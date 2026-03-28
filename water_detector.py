#!/usr/bin/env python3
"""Water level detection using camera + calibration data.
Grabs frames from RTSP, detects water surface using edge detection,
maps to calibrated water levels."""

import json
import os
import subprocess
import time
import signal
import cv2
import numpy as np
import urllib.request
from datetime import datetime, date
from pathlib import Path

# Config
RTSP_URL = "rtsp://admin:%40Lara4chensi@192.168.68.96:554/h264Preview_01_sub"
BASE_DIR = Path(__file__).parent
WATER_DIR = BASE_DIR / "data" / "water-level"
CAL_FILE = WATER_DIR / "calibration.json"
READINGS_FILE = WATER_DIR / "readings.json"
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "qk0d-koi-xk7m")

CHECK_INTERVAL = 60  # seconds between checks
MAX_READINGS = 1440  # ~24h at 1/min
ALERT_COOLDOWN = 1800  # 30 min between alerts

WATER_DIR.mkdir(parents=True, exist_ok=True)

running = True
def handle_signal(sig, frame):
    global running
    running = False
signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)


def load_calibration():
    if CAL_FILE.exists():
        try:
            return json.loads(CAL_FILE.read_text())
        except:
            pass
    return None


def load_readings():
    if READINGS_FILE.exists():
        try:
            return json.loads(READINGS_FILE.read_text())
        except:
            pass
    return []


def save_readings(readings):
    READINGS_FILE.write_text(json.dumps(readings[-MAX_READINGS:], indent=2))


def grab_frame():
    """Grab a single frame from RTSP."""
    cap = cv2.VideoCapture(RTSP_URL, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        return None
    ret, frame = cap.read()
    cap.release()
    return frame if ret else None


def detect_water_line(frame, cal):
    """Detect water surface line using edge detection within calibrated ROI."""
    h, w = frame.shape[:2]

    # Define ROI
    roi = cal.get("roi")
    if roi:
        x1 = int(roi["x1"] * w)
        y1 = int(roi["y1"] * h)
        x2 = int(roi["x2"] * w)
        y2 = int(roi["y2"] * h)
        region = frame[y1:y2, x1:x2]
    else:
        region = frame
        y1 = 0

    rh, rw = region.shape[:2]

    # Convert to grayscale
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    # Blur to reduce noise
    blurred = cv2.GaussianBlur(gray, (7, 7), 0)

    # Method 1: Canny edge detection — find horizontal edges (water surface)
    edges = cv2.Canny(blurred, 30, 100)

    # Method 2: Color-based — water is typically darker/bluer
    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    # Water tends to have lower saturation and specific value range
    # Analyze rows from top to bottom — find transition from non-water to water
    row_means = np.mean(blurred, axis=1)

    # Find the biggest gradient change (water surface = big brightness change)
    if len(row_means) > 10:
        gradient = np.abs(np.diff(row_means))
        # Smooth gradient
        kernel = np.ones(5) / 5
        gradient_smooth = np.convolve(gradient, kernel, mode='same')

        # Also use edge density per row
        edge_density = np.sum(edges > 0, axis=1).astype(float)
        edge_smooth = np.convolve(edge_density, kernel, mode='same')

        # Combine: strong gradient + high edge density = water line
        combined = gradient_smooth * 0.6 + edge_smooth * 0.4
        # Find peak in upper 60% of image (water line is usually in upper portion)
        search_range = int(rh * 0.8)
        if search_range > 10:
            peak_row = np.argmax(combined[:search_range])
            # Normalize to full image coordinates
            water_y_norm = (y1 + peak_row) / h
            return water_y_norm, float(combined[peak_row])

    return None, 0


def y_to_level_cm(y_norm, cal):
    """Convert normalized y position to cm using calibration levels."""
    levels = cal.get("levels", [])
    if len(levels) < 2:
        return None

    # Sort levels by y position
    sorted_levels = sorted(levels, key=lambda l: l["y"])

    # Linear interpolation
    for i in range(len(sorted_levels) - 1):
        y1 = sorted_levels[i]["y"]
        y2 = sorted_levels[i + 1]["y"]
        h1 = sorted_levels[i]["height_cm"]
        h2 = sorted_levels[i + 1]["height_cm"]

        if y1 <= y_norm <= y2:
            t = (y_norm - y1) / (y2 - y1) if y2 != y1 else 0
            return round(h1 + t * (h2 - h1), 1)

    # Extrapolate if outside range
    if y_norm < sorted_levels[0]["y"]:
        # Above highest mark
        return sorted_levels[0]["height_cm"]
    else:
        return sorted_levels[-1]["height_cm"]


def get_status(level_cm, cal):
    """Determine status based on calibrated levels."""
    levels = cal.get("levels", [])
    if not levels:
        return "unknown"

    sorted_levels = sorted(levels, key=lambda l: l["height_cm"], reverse=True)
    for lv in sorted_levels:
        if level_cm >= lv["height_cm"] - 2:
            return lv["label"]
    return sorted_levels[-1]["label"]


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
        if not cal or not cal.get("levels") or len(cal["levels"]) < 2:
            print("No calibration data (need at least 2 levels). Waiting...")
            time.sleep(30)
            continue

        frame = grab_frame()
        if frame is None:
            print("Failed to grab frame")
            time.sleep(CHECK_INTERVAL)
            continue

        water_y, confidence = detect_water_line(frame, cal)
        if water_y is None:
            time.sleep(CHECK_INTERVAL)
            continue

        level_cm = y_to_level_cm(water_y, cal)
        if level_cm is None:
            time.sleep(CHECK_INTERVAL)
            continue

        status = get_status(level_cm, cal)

        reading = {
            "timestamp": int(time.time() * 1000),
            "time": datetime.now().isoformat(),
            "level_cm": level_cm,
            "water_y": round(water_y, 4),
            "confidence": round(confidence, 2),
            "status": status,
        }
        readings.append(reading)
        save_readings(readings)

        print(f"Water: {level_cm}cm ({status}) y={water_y:.3f} conf={confidence:.1f}")

        # Alert on status change to low/critical
        now = time.time()
        if status != last_status and (now - last_alert_time) > ALERT_COOLDOWN:
            low_labels = {"low", "critical", "Low", "Critical", "偏低", "危险"}
            if status in low_labels:
                notify("Water Level Alert", f"Level: {level_cm}cm - Status: {status}")
                last_alert_time = now
        last_status = status

        time.sleep(CHECK_INTERVAL)

    print("Water level detector stopped.")


if __name__ == "__main__":
    main()
