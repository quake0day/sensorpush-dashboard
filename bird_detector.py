#!/usr/bin/env python3
"""Bird sound detector using BirdNET.
Extracts audio from HLS stream, analyzes for bird calls,
writes detections to daily JSON logs for the Node.js server."""

import json
import os
import subprocess
import time
import signal
import urllib.request
from datetime import datetime, date
from pathlib import Path

# Config
RTSP_URL = "rtsp://admin:%40Lara4chensi@192.168.68.96:554/h264Preview_01_main"
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "qk0d-koi-xk7m")
DATA_DIR = Path(os.environ.get("DATA_DIR") or Path.home() / "sensorpush-data")
DETECT_DIR = DATA_DIR / "bird-detections"
AUDIO_DIR = DETECT_DIR / "clips"
DAILY_DIR = DETECT_DIR / "daily"
LATEST_FILE = DETECT_DIR / "latest.json"
LAT, LON = 39.957, -75.603
MIN_CONFIDENCE = 0.35
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
    proc = None
    try:
        audio_filter = (
            "highpass=f=500,"
            "lowpass=f=12000,"
            "volume=8.0"
        )
        proc = subprocess.Popen([
            "ffmpeg", "-y",
            "-rtsp_transport", "tcp",
            "-i", RTSP_URL,
            "-t", str(CHUNK_SECONDS),
            "-vn",
            "-af", audio_filter,
            "-acodec", "pcm_s16le",
            "-ar", "48000", "-ac", "1",
            output_path
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        proc.wait(timeout=CHUNK_SECONDS + 10)
        return proc.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 1000
    except subprocess.TimeoutExpired:
        if proc:
            proc.kill()
            proc.wait()
        print("Audio extraction timed out (ffmpeg killed)")
        return False
    except Exception as e:
        if proc and proc.poll() is None:
            proc.kill()
            proc.wait()
        print(f"Audio extraction error: {e}")
        return False


def save_clip(wav_path, detection_id):
    """Save audio clip with aggressive noise/speech removal for privacy."""
    clip_path = str(AUDIO_DIR / f"{detection_id}.mp3")
    try:
        # Filter chain to remove background noise and human speech:
        # 1. highpass 1500Hz — removes human speech fundamental (85-300Hz) + harmonics
        # 2. lowpass 9000Hz — removes high-freq hiss
        # 3. anlmdn — non-local means denoiser for residual noise
        # 4. volume normalize
        clip_filter = (
            "highpass=f=1500:poles=2,"
            "lowpass=f=9000,"
            "anlmdn=s=0.001:p=0.002:r=0.01,"
            "volume=2.0"
        )
        subprocess.run([
            "ffmpeg", "-y", "-i", wav_path,
            "-af", clip_filter,
            "-ar", "22050", "-ac", "1", "-b:a", "48k", clip_path
        ], capture_output=True, timeout=15)
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

                    # Save cleaned audio clip (speech/noise removed) for /bird page
                    has_clip = save_clip(wav_path, detection_id)

                    entry = {
                        "id": detection_id,
                        "time": now.isoformat(),
                        "timestamp": int(time.time() * 1000),
                        "common_name": det["common_name"],
                        "scientific_name": det["scientific_name"],
                        "confidence": round(det["confidence"], 3),
                        "has_clip": has_clip,
                    }

                    # Add to latest (for real-time notifications)
                    latest.append(entry)
                    latest = latest[-MAX_LATEST:]
                    LATEST_FILE.write_text(json.dumps(latest, indent=2))

                    # Add to daily log (persistent)
                    today_detections.append(entry)
                    save_daily(today_detections, today_str)

                    print(f"BIRD: {det['common_name']} ({det['scientific_name']}) conf={det['confidence']:.2f}")

                    # Push notification
                    try:
                        msg = f"{det['common_name']} ({det['scientific_name']}) - {det['confidence']:.0%} confidence"
                        req = urllib.request.Request(
                            f"https://ntfy.sh/{NTFY_TOPIC}",
                            data=msg.encode("utf-8"), method="POST")
                        req.add_header("Title", f"Bird: {det['common_name']}")
                        req.add_header("Tags", "bird")
                        req.add_header("Click", "http://192.168.68.110:3088/bird")
                        urllib.request.urlopen(req, timeout=5)
                    except Exception as ne:
                        print(f"Notify error: {ne}")

            time.sleep(POLL_INTERVAL)

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"Error: {e}")
            time.sleep(POLL_INTERVAL)

    print("Bird detector stopped.")

if __name__ == "__main__":
    main()
