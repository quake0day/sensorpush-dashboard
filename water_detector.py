#!/usr/bin/env python3
"""Water level detection using camera + calibration stroke data.
Compares current water edge against calibrated reference strokes."""

import json
import os
import time
import signal
import cv2
import numpy as np
import urllib.request
from datetime import datetime
from pathlib import Path

# Config
RTSP_URL = "rtsp://admin:%40Lara4chensi@192.168.68.96:554/h264Preview_01_sub"
BASE_DIR = Path(__file__).parent
WATER_DIR = BASE_DIR / "data" / "water-level"
CAL_FILE = WATER_DIR / "calibration.json"
READINGS_FILE = WATER_DIR / "readings.json"
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "qk0d-koi-xk7m")

CHECK_INTERVAL = 60
MAX_READINGS = 1440
ALERT_COOLDOWN = 1800

WATER_DIR.mkdir(parents=True, exist_ok=True)

running = True
def handle_signal(sig, frame):
    global running
    running = False
signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)


def load_calibration():
    if CAL_FILE.exists():
        try: return json.loads(CAL_FILE.read_text())
        except: pass
    return None


def load_readings():
    if READINGS_FILE.exists():
        try: return json.loads(READINGS_FILE.read_text())
        except: pass
    return []


def save_readings(readings):
    READINGS_FILE.write_text(json.dumps(readings[-MAX_READINGS:], indent=2))


def grab_frame():
    cap = cv2.VideoCapture(RTSP_URL, cv2.CAP_FFMPEG)
    if not cap.isOpened(): return None
    ret, frame = cap.read()
    cap.release()
    return frame if ret else None


def detect_water_level(frame, cal):
    """Detect water level by comparing current frame edge with calibrated strokes.

    For each calibrated level, check how well the current water edge
    matches the calibrated stroke positions. The level with best match
    determines the current water level.
    """
    h, w = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 30, 80)

    levels = cal.get("levels", [])
    if not levels:
        return None

    results = []
    for lv in levels:
        strokes = lv.get("strokes", [])
        if not strokes:
            continue

        # Sample the calibrated stroke positions
        stroke_points = []
        for stroke in strokes:
            for pt in stroke:
                stroke_points.append((pt["x"], pt["y"]))

        if len(stroke_points) < 10:
            continue

        # For each calibrated point, check edge presence at various vertical offsets
        # This tells us if the water edge has moved up or down
        best_offset = 0
        best_score = 0

        for offset_px in range(-50, 51, 2):  # search ±50 pixels
            score = 0
            count = 0
            # Sample evenly spaced points along the stroke
            step = max(1, len(stroke_points) // 100)
            for i in range(0, len(stroke_points), step):
                px = int(stroke_points[i][0] * w)
                py = int(stroke_points[i][1] * h) + offset_px
                if 0 <= px < w and 0 <= py < h:
                    # Check if there's an edge near this point
                    # Sample a small window
                    y1 = max(0, py - 2)
                    y2 = min(h, py + 3)
                    x1 = max(0, px - 2)
                    x2 = min(w, px + 3)
                    window = edges[y1:y2, x1:x2]
                    score += np.sum(window > 0)
                    count += 1

            if count > 0:
                avg_score = score / count
                if avg_score > best_score:
                    best_score = avg_score
                    best_offset = offset_px

        # Convert pixel offset to level change
        # Positive offset = edge moved down = water dropped
        # The percentage change depends on image height
        offset_pct = (best_offset / h) * 100
        cal_level = lv["height_cm"]  # This is the calibrated percentage (50%)
        # Each pixel offset maps to some level change
        # Use a scale factor: ~2% level per 1% image shift
        current_level = cal_level - offset_pct * 2
        current_level = max(0, min(100, current_level))

        results.append({
            "label": lv["label"],
            "cal_level": cal_level,
            "offset_px": best_offset,
            "edge_score": round(best_score, 1),
            "current_level": round(current_level, 1),
        })

    if not results:
        return None

    # Use the result with highest edge score (most confident)
    best = max(results, key=lambda r: r["edge_score"])
    return best


def get_status(level_pct):
    if level_pct >= 70: return "High"
    if level_pct >= 40: return "Normal"
    if level_pct >= 20: return "Low"
    return "Critical"


def notify(title, body):
    try:
        req = urllib.request.Request(
            f"https://ntfy.sh/{NTFY_TOPIC}",
            data=body.encode("utf-8"), method="POST")
        req.add_header("Title", title.encode("ascii", "ignore").decode())
        req.add_header("Tags", "droplet,warning")
        req.add_header("Priority", "4")
        req.add_header("Click", "http://192.168.68.110:3088/water")
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print(f"Notify error: {e}")


def main():
    print("Water level detector starting...")
    readings = load_readings()
    last_alert_time = 0
    last_status = None

    while running:
        cal = load_calibration()
        if not cal or not cal.get("levels"):
            print("No calibration data. Waiting...")
            time.sleep(30)
            continue

        frame = grab_frame()
        if frame is None:
            print("Failed to grab frame")
            time.sleep(CHECK_INTERVAL)
            continue

        result = detect_water_level(frame, cal)
        if result is None:
            print("Detection failed")
            time.sleep(CHECK_INTERVAL)
            continue

        level = result["current_level"]
        status = get_status(level)

        reading = {
            "timestamp": int(time.time() * 1000),
            "time": datetime.now().isoformat(),
            "level_pct": level,
            "status": status,
            "offset_px": result["offset_px"],
            "edge_score": result["edge_score"],
            "ref_label": result["label"],
        }
        readings.append(reading)
        save_readings(readings)

        print(f"Water: {level:.0f}% ({status}) offset={result['offset_px']}px score={result['edge_score']:.0f}")

        # Alert on low/critical
        now = time.time()
        if status != last_status and (now - last_alert_time) > ALERT_COOLDOWN:
            if status in ("Low", "Critical"):
                notify("Water Level Alert", f"Level: {level:.0f}% - {status}")
                last_alert_time = now
        last_status = status

        time.sleep(CHECK_INTERVAL)

    print("Water level detector stopped.")


if __name__ == "__main__":
    main()
