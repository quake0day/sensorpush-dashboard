#!/usr/bin/env python3
"""Bird sound detector using BirdNET.
Extracts audio from HLS stream, analyzes for bird calls,
writes detections to daily JSON logs for the Node.js server."""

import json
import os
import subprocess
import time
import signal
from datetime import datetime, date
from pathlib import Path

# Config
RTSP_URL = "rtsp://admin:%40Lara4chensi@192.168.68.96:554/h264Preview_01_main"
DETECT_DIR = Path(__file__).parent / "data" / "bird-detections"
AUDIO_DIR = DETECT_DIR / "clips"
DAILY_DIR = DETECT_DIR / "daily"
LATEST_FILE = DETECT_DIR / "latest.json"
LAT, LON = 39.957, -75.603
MIN_CONFIDENCE = 0.50
CHUNK_SECONDS = 9  # longer chunks = better detection
POLL_INTERVAL = 10
MAX_LATEST = 50

# Ensure dirs
for d in [DETECT_DIR, AUDIO_DIR, DAILY_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# Load latest detections (for real-time notifications)
latest = []
if LATEST_FILE.exists():
    try:
        latest = json.loads(LATEST_FILE.read_text())
    except:
        latest = []

running = True
def handle_signal(sig, frame):
    global running
    running = False
signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)


def daily_file(d=None):
    """Get path for a day's detection log."""
    day = d or date.today().isoformat()
    return DAILY_DIR / f"{day}.json"


def load_daily(d=None):
    """Load a day's detections."""
    f = daily_file(d)
    if f.exists():
        try:
            return json.loads(f.read_text())
        except:
            pass
    return []


def save_daily(entries, d=None):
    """Save a day's detections."""
    daily_file(d).write_text(json.dumps(entries, indent=2))


def extract_audio(output_path):
    """Extract audio directly from RTSP with noise filtering for bird detection."""
    try:
        # Audio filter chain optimized for bird detection:
        # 1. Double highpass at 800Hz — remove water/wind/traffic noise
        # 2. Lowpass at 10kHz — remove high-freq hiss
        # 3. Volume boost 3x — compensate for quiet mic (no clipping)
        audio_filter = (
            "highpass=f=800:poles=2,"
            "highpass=f=800:poles=2,"
            "lowpass=f=10000,"
            "volume=3.0"
        )
        result = subprocess.run([
            "ffmpeg", "-y",
            "-rtsp_transport", "tcp",
            "-i", RTSP_URL,
            "-t", str(CHUNK_SECONDS),
            "-vn",
            "-af", audio_filter,
            "-acodec", "pcm_s16le",
            "-ar", "48000", "-ac", "1",
            output_path
        ], capture_output=True, text=True, timeout=20)
        return result.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 1000
    except Exception as e:
        print(f"Audio extraction error: {e}")
        return False


def save_clip(wav_path, detection_id):
    clip_path = str(AUDIO_DIR / f"{detection_id}.mp3")
    try:
        subprocess.run([
            "ffmpeg", "-y", "-i", wav_path,
            "-ar", "22050", "-ac", "1", "-b:a", "48k", clip_path
        ], capture_output=True, timeout=10)
        return os.path.exists(clip_path)
    except:
        return False


_analyzer = None
def get_analyzer():
    global _analyzer
    if _analyzer is None:
        print("Loading BirdNET model...")
        from birdnetlib.analyzer import Analyzer
        _analyzer = Analyzer()
        print("BirdNET model loaded.")
    return _analyzer


def analyze_audio(wav_path):
    from birdnetlib import Recording
    analyzer = get_analyzer()
    recording = Recording(analyzer, wav_path, lat=LAT, lon=LON, min_conf=MIN_CONFIDENCE)
    recording.analyze()
    return recording.detections


def main():
    global latest
    print(f"Bird detector started. Polling every {POLL_INTERVAL}s, min_conf={MIN_CONFIDENCE}")
    print(f"Location: {LAT}, {LON}")

    get_analyzer()

    wav_path = str(DETECT_DIR / "current_chunk.wav")
    consecutive_errors = 0
    today_str = date.today().isoformat()
    today_detections = load_daily(today_str)

    while running:
        try:
            # Check if day rolled over
            now_day = date.today().isoformat()
            if now_day != today_str:
                print(f"New day: {now_day}")
                today_str = now_day
                today_detections = load_daily(today_str)

            if not extract_audio(wav_path):
                consecutive_errors += 1
                if consecutive_errors > 5:
                    print("HLS stream not available, waiting 30s...")
                    time.sleep(30)
                    consecutive_errors = 0
                else:
                    time.sleep(POLL_INTERVAL)
                continue

            consecutive_errors = 0
            results = analyze_audio(wav_path)

            if results:
                for det in results:
                    now = datetime.now()
                    detection_id = now.strftime("%Y%m%d_%H%M%S") + f"_{det['common_name'].replace(' ', '_')}"

                    entry = {
                        "id": detection_id,
                        "time": now.isoformat(),
                        "timestamp": int(time.time() * 1000),
                        "common_name": det["common_name"],
                        "scientific_name": det["scientific_name"],
                        "confidence": round(det["confidence"], 3),
                    }

                    # Add to latest (for real-time notifications)
                    latest.append(entry)
                    latest = latest[-MAX_LATEST:]
                    LATEST_FILE.write_text(json.dumps(latest, indent=2))

                    # Add to daily log (persistent)
                    today_detections.append(entry)
                    save_daily(today_detections, today_str)

                    print(f"BIRD: {det['common_name']} ({det['scientific_name']}) conf={det['confidence']:.2f}")

            time.sleep(POLL_INTERVAL)

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"Error: {e}")
            time.sleep(POLL_INTERVAL)

    print("Bird detector stopped.")

if __name__ == "__main__":
    main()
