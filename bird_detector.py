#!/usr/bin/env python3
"""Bird sound detector using BirdNET.
Extracts audio from HLS stream, analyzes for bird calls,
writes detections to JSON for the Node.js server to serve."""

import json
import os
import subprocess
import sys
import time
import signal
from datetime import datetime
from pathlib import Path

# Config
HLS_URL = "http://localhost:3088/hls/stream.m3u8"
DETECT_DIR = Path(__file__).parent / "data" / "bird-detections"
AUDIO_DIR = DETECT_DIR / "clips"
DETECTIONS_FILE = DETECT_DIR / "latest.json"
LAT, LON = 39.957, -75.603  # Location for species filtering
MIN_CONFIDENCE = 0.40
CHUNK_SECONDS = 6  # BirdNET works best with 3-6 second chunks
POLL_INTERVAL = 10  # seconds between analysis cycles
MAX_DETECTIONS = 50  # keep last N detections

# Ensure dirs exist
DETECT_DIR.mkdir(parents=True, exist_ok=True)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

# Load existing detections
detections = []
if DETECTIONS_FILE.exists():
    try:
        detections = json.loads(DETECTIONS_FILE.read_text())
    except:
        detections = []

running = True
def handle_signal(sig, frame):
    global running
    running = False
    print("Shutting down bird detector...")

signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)

def extract_audio(output_path):
    """Extract audio chunk from HLS stream."""
    try:
        result = subprocess.run([
            "ffmpeg", "-y",
            "-i", HLS_URL,
            "-t", str(CHUNK_SECONDS),
            "-vn",
            "-ar", "48000",
            "-ac", "1",
            "-f", "wav",
            output_path
        ], capture_output=True, text=True, timeout=30)
        return result.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 1000
    except Exception as e:
        print(f"Audio extraction error: {e}")
        return False

def save_clip(wav_path, detection_id):
    """Save a short MP3 clip for playback."""
    clip_path = str(AUDIO_DIR / f"{detection_id}.mp3")
    try:
        subprocess.run([
            "ffmpeg", "-y",
            "-i", wav_path,
            "-ar", "22050",
            "-ac", "1",
            "-b:a", "48k",
            clip_path
        ], capture_output=True, timeout=10)
        return os.path.exists(clip_path)
    except:
        return False

def analyze_audio(wav_path):
    """Run BirdNET analysis on audio file."""
    from birdnetlib import Recording
    from birdnetlib.analyzer import Analyzer

    if not hasattr(analyze_audio, '_analyzer'):
        print("Loading BirdNET model...")
        analyze_audio._analyzer = Analyzer()
        print("BirdNET model loaded.")

    recording = Recording(
        analyze_audio._analyzer,
        wav_path,
        lat=LAT, lon=LON,
        min_conf=MIN_CONFIDENCE,
    )
    recording.analyze()
    return recording.detections

def save_detections():
    """Persist detections to JSON."""
    DETECTIONS_FILE.write_text(json.dumps(detections[-MAX_DETECTIONS:], indent=2))

def main():
    global detections
    print(f"Bird detector started. Polling every {POLL_INTERVAL}s, min_conf={MIN_CONFIDENCE}")
    print(f"HLS source: {HLS_URL}")
    print(f"Location: {LAT}, {LON}")

    # Pre-load the analyzer
    analyze_audio("/dev/null")  # triggers model load (will fail gracefully)

    wav_path = str(DETECT_DIR / "current_chunk.wav")
    consecutive_errors = 0

    while running:
        try:
            # Extract audio from HLS stream
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

            # Analyze for birds
            results = analyze_audio(wav_path)

            if results:
                for det in results:
                    detection_id = datetime.now().strftime("%Y%m%d_%H%M%S") + f"_{det['common_name'].replace(' ', '_')}"

                    # Save audio clip
                    has_clip = save_clip(wav_path, detection_id)

                    entry = {
                        "id": detection_id,
                        "time": datetime.now().isoformat(),
                        "timestamp": int(time.time() * 1000),
                        "common_name": det["common_name"],
                        "scientific_name": det["scientific_name"],
                        "confidence": round(det["confidence"], 3),
                        "has_clip": has_clip,
                    }

                    detections.append(entry)
                    save_detections()
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
