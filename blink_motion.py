#!/usr/bin/env python3
"""Blink motion-clip watcher (auto-capture on motion).

Blink doesn't expose a usable live stream for Mini cameras, but it DOES record
a short clip to its cloud on every motion event — *when the camera is armed*.
This long-running daemon (spawned by server.js like motion_detector.py) polls
Blink, downloads any new motion clips into $DATA_DIR/blink-motion/clips/, and
appends each event to $DATA_DIR/blink-motion/events.json so the dashboard can
show a motion feed.

IMPORTANT: cameras must be ARMED for Blink to record motion. Disarmed cameras
produce no clips, so this watcher will simply find nothing.
"""

import asyncio
import json
import os
import time

from aiohttp import ClientSession
from dateutil.parser import parse as parse_dt
from slugify import slugify
from blinkpy.blinkpy import Blink
from blinkpy.auth import Auth
from blinkpy.helpers.util import json_load

DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(os.path.expanduser("~"), "sensorpush-data")
CREDS_FILE = os.path.join(DATA_DIR, "blink_creds.json")
MOTION_DIR = os.path.join(DATA_DIR, "blink-motion")
CLIPS_DIR = os.path.join(MOTION_DIR, "clips")
EVENTS_FILE = os.path.join(MOTION_DIR, "events.json")
STATE_FILE = os.path.join(MOTION_DIR, "state.json")

POLL = int(os.environ.get("BLINK_MOTION_POLL", "60"))   # seconds between checks
MAX_EVENTS = 500                                         # cap the feed
FIRST_RUN_LOOKBACK_H = 2                                 # how far back to scan on boot


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


async def main():
    os.makedirs(CLIPS_DIR, exist_ok=True)
    if not os.path.exists(CREDS_FILE):
        print("blink-motion: not authenticated (run `python3 blink_client.py setup`)", flush=True)
        return

    events = load_json(EVENTS_FILE, [])
    known = {e["file"] for e in events}
    state = load_json(STATE_FILE, {})
    since = state.get("last_check")  # "YYYY/MM/DD HH:MM:SS" or None

    async with ClientSession() as session:
        blink = Blink(session=session)
        blink.auth = Auth(await json_load(CREDS_FILE), no_prompt=True, session=session)
        if not await blink.start():
            print("blink-motion: auth failed; stored credentials rejected", flush=True)
            return
        print(f"blink-motion: watching {list(blink.cameras)} every {POLL}s "
              f"(cameras must be armed)", flush=True)

        while True:
            try:
                await blink.refresh()
                await blink.save(CREDS_FILE)

                if since is None:
                    since_epoch = time.time() - FIRST_RUN_LOOKBACK_H * 3600
                    since = time.strftime("%Y/%m/%d %H:%M:%S", time.localtime(since_epoch))

                meta = await blink.get_videos_metadata(since=since, stop=3)
                new = 0
                for item in meta:
                    try:
                        if item.get("deleted"):
                            continue
                        created = item["created_at"]
                        camera = item["device_name"]
                        address = item["media"]
                    except KeyError:
                        continue
                    fname = slugify(f"{camera}-{created}") + ".mp4"
                    fpath = os.path.join(CLIPS_DIR, fname)
                    if fname in known or os.path.exists(fpath):
                        known.add(fname)
                        continue
                    resp = await blink.do_http_get(address)
                    data = await resp.read()
                    if not data:
                        continue
                    with open(fpath, "wb") as f:
                        f.write(data)
                    try:
                        ts = int(parse_dt(created).timestamp() * 1000)
                    except (ValueError, TypeError):
                        ts = int(time.time() * 1000)
                    events.insert(0, {"file": fname, "camera": camera,
                                      "created_at": created, "timestamp": ts})
                    known.add(fname)
                    new += 1
                    print(f"blink-motion: NEW clip {camera} @ {created} -> {fname}", flush=True)

                if new:
                    events = events[:MAX_EVENTS]
                    save_json(EVENTS_FILE, events)

                # advance the watermark to now (minus a small overlap for safety)
                since = time.strftime("%Y/%m/%d %H:%M:%S", time.localtime(time.time() - 120))
                save_json(STATE_FILE, {"last_check": since})
            except Exception as e:  # noqa: BLE001 — keep the daemon alive
                print(f"blink-motion error: {type(e).__name__}: {e}", flush=True)

            await asyncio.sleep(POLL)


if __name__ == "__main__":
    asyncio.run(main())
