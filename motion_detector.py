#!/usr/bin/env python3
"""Motion detection + animal identification for koi pond camera.
Grabs frames from RTSP, detects motion via frame differencing,
identifies animals with TFLite COCO SSD, records video clips."""

import json
import os
import subprocess
import time
import signal
import urllib.request
import cv2
import numpy as np
from datetime import datetime, date
from pathlib import Path

# Config
RTSP_URL = "rtsp://admin:%40Lara4chensi@192.168.68.96:554/h264Preview_01_sub"
RTSP_MAIN = "rtsp://admin:%40Lara4chensi@192.168.68.96:554/h264Preview_01_main"
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "qk0d-koi-xk7m")
BASE_DIR = Path(__file__).parent
MODEL_PATH = str(BASE_DIR / "models" / "detect.tflite")
LABELS_PATH = str(BASE_DIR / "models" / "labelmap.txt")
EVENTS_DIR = BASE_DIR / "data" / "motion-events"
CLIPS_DIR = EVENTS_DIR / "clips"
THUMBS_DIR = EVENTS_DIR / "thumbs"
LATEST_FILE = EVENTS_DIR / "latest.json"

# Detection settings
MOTION_THRESHOLD = 5000       # min contour area to count as motion
MOTION_MIN_PERCENT = 0.3      # min % of frame with motion
DETECT_INTERVAL = 2           # seconds between frame grabs
RECORD_DURATION = 15          # seconds of video to record
COOLDOWN_SECONDS = 60         # min seconds between recordings
ANIMAL_CONFIDENCE = 0.40      # min confidence for animal detection

# Animal classes we care about (COCO label indices)
ANIMAL_CLASSES = {
    16: "bird", 17: "cat", 18: "dog", 19: "horse",
    21: "bear", 22: "zebra", 23: "giraffe",
}

# Chinese translations
ANIMAL_CN = {
    "bird": "鸟类", "cat": "猫", "dog": "狗", "horse": "马",
    "bear": "熊/浣熊", "zebra": "斑马", "giraffe": "长颈鹿",
    "person": "人", "unknown": "未知动物",
}

# Ensure dirs
for d in [EVENTS_DIR, CLIPS_DIR, THUMBS_DIR]:
    d.mkdir(parents=True, exist_ok=True)

running = True
def handle_signal(sig, frame):
    global running
    running = False
signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)


def load_labels():
    with open(LABELS_PATH, 'r') as f:
        return [line.strip() for line in f.readlines()]


def notify(title, body, thumb_path=None, tags=None):
    """Send push notification via ntfy.sh."""
    try:
        url = f"https://ntfy.sh/{NTFY_TOPIC}"
        data = body.encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST")
        # Title must be ASCII only (no emoji - causes UnicodeEncodeError)
        req.add_header("Title", title.encode("ascii", "ignore").decode())
        if tags:
            req.add_header("Tags", tags)
        req.add_header("Priority", "4")
        # Attach thumbnail if available
        if thumb_path and os.path.exists(thumb_path):
            # Use multipart for image — simpler: just send as click URL
            dashboard_url = f"http://192.168.68.110:3088/koi"
            req.add_header("Click", dashboard_url)
            req.add_header("Actions", f"view, Open Camera, {dashboard_url}")
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print(f"Notify error: {e}")


def load_model():
    import tflite_runtime.interpreter as tflite
    interpreter = tflite.Interpreter(model_path=MODEL_PATH)
    interpreter.allocate_tensors()
    return interpreter


def detect_objects(interpreter, frame):
    """Run TFLite object detection on a frame."""
    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()
    h, w = input_details[0]['shape'][1], input_details[0]['shape'][2]

    # Resize and prepare input
    resized = cv2.resize(frame, (w, h))
    input_data = np.expand_dims(resized, axis=0).astype(np.uint8)
    interpreter.set_tensor(input_details[0]['index'], input_data)
    interpreter.invoke()

    # Get results
    boxes = interpreter.get_tensor(output_details[0]['index'])[0]
    classes = interpreter.get_tensor(output_details[1]['index'])[0]
    scores = interpreter.get_tensor(output_details[2]['index'])[0]

    detections = []
    for i in range(len(scores)):
        if scores[i] >= ANIMAL_CONFIDENCE:
            class_id = int(classes[i]) + 1  # COCO labels are 1-indexed
            if class_id in ANIMAL_CLASSES:
                detections.append({
                    "class": ANIMAL_CLASSES[class_id],
                    "class_id": class_id,
                    "confidence": float(scores[i]),
                    "box": boxes[i].tolist(),
                })
    return detections


def detect_motion(prev_gray, curr_gray):
    """Simple frame differencing for motion detection."""
    diff = cv2.absdiff(prev_gray, curr_gray)
    _, thresh = cv2.threshold(diff, 30, 255, cv2.THRESH_BINARY)
    # Dilate to fill gaps
    kernel = np.ones((5, 5), np.uint8)
    thresh = cv2.dilate(thresh, kernel, iterations=2)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    total_area = 0
    for c in contours:
        area = cv2.contourArea(c)
        if area > MOTION_THRESHOLD:
            total_area += area

    frame_area = curr_gray.shape[0] * curr_gray.shape[1]
    motion_percent = (total_area / frame_area) * 100
    return motion_percent > MOTION_MIN_PERCENT, motion_percent


def record_clip(event_id):
    """Record a short video clip from RTSP main stream."""
    clip_path = str(CLIPS_DIR / f"{event_id}.mp4")
    try:
        subprocess.run([
            "ffmpeg", "-y",
            "-rtsp_transport", "tcp",
            "-i", RTSP_MAIN,
            "-t", str(RECORD_DURATION),
            "-c:v", "libx264", "-preset", "ultrafast",
            "-vf", "scale=1280:-2",
            "-c:a", "aac", "-ar", "16000", "-ac", "1",
            "-movflags", "+faststart",
            clip_path
        ], capture_output=True, timeout=RECORD_DURATION + 15)
        return os.path.exists(clip_path) and os.path.getsize(clip_path) > 10000
    except Exception as e:
        print(f"Recording error: {e}")
        return False


def save_thumbnail(frame, event_id, detections):
    """Save a thumbnail with detection boxes drawn."""
    thumb = frame.copy()
    h, w = thumb.shape[:2]
    for det in detections:
        box = det["box"]
        y1, x1, y2, x2 = int(box[0]*h), int(box[1]*w), int(box[2]*h), int(box[3]*w)
        color = (0, 255, 0) if det["class"] == "bird" else (0, 0, 255)
        cv2.rectangle(thumb, (x1, y1), (x2, y2), color, 2)
        label = f"{det['class']} {det['confidence']:.0%}"
        cv2.putText(thumb, label, (x1, y1 - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

    thumb_path = str(THUMBS_DIR / f"{event_id}.jpg")
    cv2.imwrite(thumb_path, thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return os.path.exists(thumb_path)


def load_events():
    if LATEST_FILE.exists():
        try:
            return json.loads(LATEST_FILE.read_text())
        except:
            pass
    return []


def save_events(events):
    # Keep last 100
    LATEST_FILE.write_text(json.dumps(events[-100:], indent=2))


def main():
    print("Motion detector starting...")
    print(f"RTSP sub: {RTSP_URL}")
    print(f"Model: {MODEL_PATH}")

    labels = load_labels()
    interpreter = load_model()
    print(f"Model loaded. Labels: {len(labels)}")

    events = load_events()
    last_record_time = 0
    prev_gray = None

    # Open RTSP stream (sub stream for detection)
    cap = None
    reconnect_delay = 5

    while running:
        try:
            # Connect/reconnect to RTSP
            if cap is None or not cap.isOpened():
                print("Connecting to RTSP sub stream...")
                cap = cv2.VideoCapture(RTSP_URL, cv2.CAP_FFMPEG)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                if not cap.isOpened():
                    print(f"Failed to open RTSP, retrying in {reconnect_delay}s...")
                    time.sleep(reconnect_delay)
                    reconnect_delay = min(reconnect_delay * 2, 60)
                    continue
                reconnect_delay = 5
                print("RTSP connected.")
                prev_gray = None

            ret, frame = cap.read()
            if not ret:
                print("Frame read failed, reconnecting...")
                cap.release()
                cap = None
                time.sleep(2)
                continue

            curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            curr_gray = cv2.GaussianBlur(curr_gray, (21, 21), 0)

            if prev_gray is None:
                prev_gray = curr_gray
                time.sleep(DETECT_INTERVAL)
                continue

            # Check for motion
            has_motion, motion_pct = detect_motion(prev_gray, curr_gray)
            prev_gray = curr_gray

            if not has_motion:
                time.sleep(DETECT_INTERVAL)
                continue

            # Cooldown check
            now = time.time()
            if (now - last_record_time) < COOLDOWN_SECONDS:
                time.sleep(DETECT_INTERVAL)
                continue

            # Motion detected — try to identify animal (optional)
            detections = detect_objects(interpreter, frame)

            if detections:
                animals = [d["class"] for d in detections]
                best = max(detections, key=lambda d: d["confidence"])
                best_class = best["class"]
                print(f"MOTION+ID: {', '.join(animals)} (best: {best_class} {best['confidence']:.0%}, motion: {motion_pct:.1f}%)")
            else:
                best_class = "motion"
                print(f"MOTION: unidentified movement (motion: {motion_pct:.1f}%)")

            event_id = datetime.now().strftime("%Y%m%d_%H%M%S") + f"_{best_class}"

            # Save thumbnail with bounding boxes
            has_thumb = save_thumbnail(frame, event_id, detections)

            # Record video clip (runs in background-ish, blocks for duration)
            # Send notification immediately (before recording)
            notify_title = f"Koi Pond: {best_class}" if best_class != "motion" else "Koi Pond: Movement detected"
            notify_body = f"Motion {motion_pct:.0f}%"
            if detections:
                notify_body += f" - {', '.join(d['class'] + ' ' + str(round(d['confidence']*100)) + '%' for d in detections)}"
            thumb_path = str(THUMBS_DIR / f"{event_id}.jpg")
            notify(notify_title, notify_body, thumb_path, tags="camera,warning")

            print(f"Recording {RECORD_DURATION}s clip...")
            last_record_time = now
            has_clip = record_clip(event_id)
            print(f"Clip saved: {has_clip}")

            event = {
                "id": event_id,
                "time": datetime.now().isoformat(),
                "timestamp": int(now * 1000),
                "animals": [{"class": d["class"], "confidence": round(d["confidence"], 3)} for d in detections],
                "best_class": best_class,
                "best_confidence": round(best["confidence"], 3) if detections else 0,
                "motion_percent": round(motion_pct, 1),
                "has_clip": has_clip,
                "has_thumb": has_thumb,
                "duration": RECORD_DURATION,
            }
            events.append(event)
            save_events(events)

            # Also save daily log
            day_str = date.today().isoformat()
            daily_file = EVENTS_DIR / "daily" / f"{day_str}.json"
            daily_file.parent.mkdir(parents=True, exist_ok=True)
            daily = []
            if daily_file.exists():
                try: daily = json.loads(daily_file.read_text())
                except: daily = []
            daily.append(event)
            daily_file.write_text(json.dumps(daily, indent=2))

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"Error: {e}")
            time.sleep(5)

        time.sleep(DETECT_INTERVAL)

    if cap:
        cap.release()
    print("Motion detector stopped.")


if __name__ == "__main__":
    main()
