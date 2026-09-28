#!/usr/bin/env python3
"""Bird sound detector using BirdNET.
Streams camera audio over one RTSP session, analyzes for bird calls,
writes detections to daily JSON logs for the Node.js server."""

import json
import os
import subprocess
import time
import signal
import re
import urllib.request
from datetime import datetime, date
from pathlib import Path
from detector_config import enabled, notifications_enabled, rtsp_url

# Config
# Reolink carries the same audio on both streams; the sub stream is far
# lighter on a slow camera link.
RTSP_URL = rtsp_url(os.environ.get("BIRD_AUDIO_STREAM", "sub"))
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")
SAVE_CLIPS = enabled("BIRD_SAVE_AUDIO_CLIPS")
DATA_DIR = Path(os.environ.get("DATA_DIR") or Path.home() / "sensorpush-data")
DETECT_DIR = DATA_DIR / "bird-detections"
AUDIO_DIR = DETECT_DIR / "clips"
DAILY_DIR = DETECT_DIR / "daily"
LATEST_FILE = DETECT_DIR / "latest.json"
STATUS_FILE = DETECT_DIR / "status.json"
SEGMENT_DIR = DETECT_DIR / "segments"
LAT = float(os.environ.get("BIRD_LAT", "39.957"))
LON = float(os.environ.get("BIRD_LON", "-75.603"))
MIN_CONFIDENCE = float(os.environ.get("BIRD_MIN_CONFIDENCE", "0.35"))
CHUNK_SECONDS = 9  # longer chunks = better detection
POLL_INTERVAL = max(1, int(os.environ.get("BIRD_POLL_INTERVAL", "10")))  # error backoff
STALL_SECONDS = 45  # restart the stream when no segment arrives for this long
MAX_BACKLOG = 3  # finished segments kept while analysis catches up
MAX_LATEST = 50

# Ensure dirs
for d in [DETECT_DIR, AUDIO_DIR, DAILY_DIR, SEGMENT_DIR]:
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
    save_json(daily_file(d), entries)


def save_json(file, entries):
    # The metadata sync service can read while analysis is running.
    temp = file.with_suffix(".json.tmp")
    temp.write_text(json.dumps(entries, indent=2))
    temp.replace(file)


def pause(seconds):
    deadline = time.monotonic() + seconds
    while running and time.monotonic() < deadline:
        time.sleep(min(0.25, max(0, deadline - time.monotonic())))


def detection_id_for(now, name, index):
    # BirdNET can find the same species in several segments in one chunk.
    # Fractional seconds and the segment index prevent silent ID collisions.
    slug = re.sub(r"[^a-zA-Z0-9_-]", "_", name)[:80]
    return now.strftime("%Y%m%d_%H%M%S_%f") + f"_{index}_{slug}"


class AudioStream:
    """One long-lived RTSP session cut into fixed-length wav segments.

    Opening an RTSP session per chunk costs several seconds on a slow camera
    link, which pushed each 9s chunk past its timeout. A persistent session
    pays that cost once and buffers through short network stalls.
    """

    def __init__(self):
        self.proc = None
        self.started_at = 0.0
        self.last_segment_at = 0.0
        self.seen = set()

    def _clear(self):
        for f in SEGMENT_DIR.glob("*.wav"):
            f.unlink(missing_ok=True)
        self.seen.clear()

    def start(self):
        self._clear()
        self.proc = subprocess.Popen([
            "ffmpeg", "-y", "-loglevel", "error",
            "-rtsp_transport", "tcp",
            "-allowed_media_types", "audio",
            "-timeout", str(STALL_SECONDS * 1_000_000),
            "-i", RTSP_URL,
            "-vn",
            "-af", "highpass=f=500,lowpass=f=12000,volume=8.0",
            "-acodec", "pcm_s16le",
            "-ar", "48000", "-ac", "1",
            "-f", "segment", "-segment_time", str(CHUNK_SECONDS),
            "-reset_timestamps", "1",
            str(SEGMENT_DIR / "chunk_%06d.wav"),
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.started_at = self.last_segment_at = time.monotonic()

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.proc = None
        self._clear()

    def healthy(self):
        """False when ffmpeg died or produced nothing for STALL_SECONDS."""
        if self.proc is None or self.proc.poll() is not None:
            return False
        return time.monotonic() - self.last_segment_at < STALL_SECONDS

    def next_segment(self):
        """Oldest finished segment, or None. ffmpeg is still writing the newest one."""
        files = sorted(SEGMENT_DIR.glob("chunk_*.wav"))
        names = {f.name for f in files}
        if names - self.seen:
            self.last_segment_at = time.monotonic()
        self.seen = names
        done = files[:-1] if self.proc and self.proc.poll() is None else files
        # Keep up with live audio rather than fall ever further behind.
        while len(done) > MAX_BACKLOG:
            done.pop(0).unlink(missing_ok=True)
        for f in done:
            if f.stat().st_size > 1000:
                return f
            f.unlink(missing_ok=True)
        return None


def save_clip(wav_path, detection_id):
    """Optionally retain filtered audio locally; filtering cannot guarantee privacy."""
    if not SAVE_CLIPS:
        return False
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
    print(f"Bird detector started. {CHUNK_SECONDS}s segments, min_conf={MIN_CONFIDENCE}")
    print(f"Location: {LAT}, {LON}")

    get_analyzer()
    status = {"last_audio_at": None, "last_analysis_at": None}
    save_json(STATUS_FILE, status)

    stream = AudioStream()
    restarts = 0
    today_str = date.today().isoformat()
    today_detections = load_daily(today_str)

    while running:
        wav_path = None
        try:
            # Check if day rolled over
            now_day = date.today().isoformat()
            if now_day != today_str:
                print(f"New day: {now_day}")
                today_str = now_day
                today_detections = load_daily(today_str)

            if not stream.healthy():
                if stream.proc is not None:
                    restarts += 1
                    print("Camera audio stream stalled, reconnecting")
                    stream.stop()
                    if restarts > 5:
                        print("Camera audio not available, waiting 30s...")
                        pause(30)
                        restarts = 0
                    else:
                        pause(POLL_INTERVAL)
                stream.start()

            segment = stream.next_segment()
            if segment is None:
                pause(0.5)
                continue
            wav_path = str(segment)

            restarts = 0
            status["last_audio_at"] = int(time.time() * 1000)
            save_json(STATUS_FILE, status)
            results = analyze_audio(wav_path)
            status["last_analysis_at"] = int(time.time() * 1000)
            save_json(STATUS_FILE, status)

            if results:
                for index, det in enumerate(results):
                    now = datetime.now()
                    detection_id = detection_id_for(now, det["common_name"], index)

                    # Retention is opt-in. The VM profile keeps metadata only.
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
                    save_json(LATEST_FILE, latest)

                    # Add to daily log (persistent)
                    today_detections.append(entry)
                    save_daily(today_detections, today_str)

                    print(f"BIRD: {det['common_name']} ({det['scientific_name']}) conf={det['confidence']:.2f}")

                    # Push notification
                    if not notifications_enabled():
                        continue
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

            # The next iteration needs no previous audio, even when no bird was found.
            Path(wav_path).unlink(missing_ok=True)

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"Error: {e}")
            if wav_path:
                Path(wav_path).unlink(missing_ok=True)
            pause(POLL_INTERVAL)

    stream.stop()
    print("Bird detector stopped.")

if __name__ == "__main__":
    main()
