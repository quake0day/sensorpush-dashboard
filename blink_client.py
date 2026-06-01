#!/usr/bin/env python3
"""Blink camera client for the Smart Garden Dashboard.

Blink cameras are cloud-only — no RTSP/ONVIF/local stream — so unlike the
Reolink koi camera (RTSP -> ffmpeg -> HLS) we have to talk to Amazon's Blink
cloud. There is no official public API, so this uses the community `blinkpy`
library, which reverse-engineers the same API the Blink mobile app uses.

Auth requires a one-time interactive 2FA (email/SMS PIN). After that the
session token is persisted to $DATA_DIR/blink_creds.json and every subsequent
call just reuses + refreshes it (no PIN needed).

server.js spawns this script once per request (same pattern as the pinyin and
detector helpers), so each command prints a single JSON object to stdout and
exits. Errors go to stderr and exit non-zero.

Usage:
  python3 blink_client.py setup                       # interactive 2FA, run once
  python3 blink_client.py cameras                     # JSON list of cameras
  python3 blink_client.py snap     <camera>           # trigger a fresh photo
  python3 blink_client.py thumbnail <camera> <out>    # download latest thumbnail
  python3 blink_client.py clip     <camera> <out>     # download latest motion clip
  python3 blink_client.py arm      <network>          # arm a sync module / network
  python3 blink_client.py disarm   <network>
  python3 blink_client.py liveview <camera>           # print {"url": "rtsps://..."}
"""

import asyncio
import json
import os
import sys

from aiohttp import ClientSession
from blinkpy.blinkpy import Blink, BlinkTwoFARequiredError
from blinkpy.auth import Auth
from blinkpy.helpers.util import json_load

# Same external data dir as server.js / the detectors, so creds survive any
# git operation. Default ~/sensorpush-data, override with DATA_DIR.
DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(os.path.expanduser("~"), "sensorpush-data")
CREDS_FILE = os.path.join(DATA_DIR, "blink_creds.json")


def out(obj):
    """Emit one JSON object to stdout for server.js to parse."""
    print(json.dumps(obj))


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


async def connect(session):
    """Load persisted creds and bring up the Blink session. Refreshes + saves
    the token. Raises if no creds file exists (setup not run yet)."""
    if not os.path.exists(CREDS_FILE):
        die("NOT_AUTHENTICATED: run `python3 blink_client.py setup` first", code=2)
    blink = Blink(session=session)
    blink.auth = Auth(await json_load(CREDS_FILE), no_prompt=True, session=session)
    if not await blink.start():
        die("AUTH_FAILED: stored Blink credentials rejected; re-run setup", code=2)
    # Persist any refreshed token so the next call stays logged in.
    await blink.save(CREDS_FILE)
    return blink


def get_camera(blink, name):
    cam = blink.cameras.get(name)
    if cam is None:
        die(f"CAMERA_NOT_FOUND: {name!r}; have {list(blink.cameras.keys())}")
    return cam


# ---- commands ---------------------------------------------------------------

async def cmd_setup():
    """Interactive: prompt for credentials + 2FA PIN, persist the session."""
    os.makedirs(DATA_DIR, exist_ok=True)
    username = os.environ.get("BLINK_USERNAME") or input("Blink/Amazon email: ").strip()
    password = os.environ.get("BLINK_PASSWORD") or input("Password: ").strip()
    async with ClientSession() as session:
        blink = Blink(session=session)
        blink.auth = Auth(
            {"username": username, "password": password},
            no_prompt=True,
            session=session,
        )
        try:
            await blink.start()
        except BlinkTwoFARequiredError:
            code = input("Enter the 2FA code Blink just sent you: ").strip()
            if not await blink.send_2fa_code(code):
                die("2FA_FAILED: code rejected")
        await blink.save(CREDS_FILE)
        cams = list(blink.cameras.keys())
        print(f"OK — saved session to {CREDS_FILE}")
        print(f"Cameras: {cams}")


async def cmd_setup_wait():
    """Non-interactive 2FA setup driven by files (so it can be orchestrated
    across turns). Reads BLINK_USERNAME/BLINK_PASSWORD from env, sends the 2FA
    code, then polls $DATA_DIR/blink_2fa_code.txt for the PIN. Progress is
    written to $DATA_DIR/blink_setup_status.txt."""
    os.makedirs(DATA_DIR, exist_ok=True)
    status_file = os.path.join(DATA_DIR, "blink_setup_status.txt")
    code_file = os.path.join(DATA_DIR, "blink_2fa_code.txt")

    def status(s):
        with open(status_file, "w") as f:
            f.write(s)

    if os.path.exists(code_file):
        os.remove(code_file)

    username = os.environ.get("BLINK_USERNAME")
    password = os.environ.get("BLINK_PASSWORD")
    if not username or not password:
        status("ERROR: BLINK_USERNAME/BLINK_PASSWORD not set")
        die("BLINK_USERNAME/BLINK_PASSWORD not set in env")

    async with ClientSession() as session:
        blink = Blink(session=session)
        blink.auth = Auth(
            {"username": username, "password": password},
            no_prompt=True,
            session=session,
        )
        try:
            await blink.start()
            need_2fa = False
        except BlinkTwoFARequiredError:
            need_2fa = True
        except Exception as e:  # noqa: BLE001
            status(f"ERROR: {type(e).__name__}: {e}")
            die(str(e))

        if need_2fa:
            status("2FA_SENT")
            code = None
            for _ in range(600):  # up to ~5 min
                if os.path.exists(code_file):
                    code = open(code_file).read().strip()
                    if code:
                        break
                await asyncio.sleep(0.5)
            if not code:
                status("ERROR: timed out waiting for 2FA code")
                die("timed out waiting for 2FA code")
            if not await blink.send_2fa_code(code):
                status("ERROR: 2FA code rejected")
                die("2FA code rejected")
            try:
                os.remove(code_file)
            except OSError:
                pass

        await blink.save(CREDS_FILE)
        cams = list(blink.cameras.keys())
        status("OK: " + json.dumps(cams))
        print("OK — cameras:", cams)


async def cmd_cameras():
    async with ClientSession() as session:
        blink = await connect(session)
        cams = []
        for name, cam in blink.cameras.items():
            a = cam.attributes
            cams.append({
                "name": name,
                "id": a.get("camera_id"),
                "type": a.get("type"),
                "battery": a.get("battery"),
                "battery_level": a.get("battery_level"),
                "temperature": a.get("temperature"),
                "temperature_c": a.get("temperature_c"),
                "wifi_strength": a.get("wifi_strength"),
                "motion_enabled": a.get("motion_enabled"),
                "motion_detected": a.get("motion_detected"),
                "last_record": a.get("last_record"),
                "network_id": a.get("network_id"),
                "sync_module": a.get("sync_module"),
                "thumbnail": a.get("thumbnail"),
            })
        armed = {name: sm.attributes.get("arm") for name, sm in blink.sync.items()}
        out({"cameras": cams, "networks": armed})


async def cmd_snap(name):
    async with ClientSession() as session:
        blink = await connect(session)
        cam = get_camera(blink, name)
        await cam.snap_picture()      # tell the camera to take a new photo
        await blink.refresh(force=True)  # pull the updated thumbnail metadata
        out({"ok": True, "camera": name, "thumbnail": cam.attributes.get("thumbnail")})


async def cmd_thumbnail(name, outfile):
    async with ClientSession() as session:
        blink = await connect(session)
        cam = get_camera(blink, name)
        await cam.image_to_file(outfile)
        out({"ok": True, "file": outfile})


async def cmd_clip(name, outfile):
    async with ClientSession() as session:
        blink = await connect(session)
        cam = get_camera(blink, name)
        await cam.video_to_file(outfile)
        out({"ok": True, "file": outfile, "last_record": cam.attributes.get("last_record")})


async def cmd_arm(network, value):
    async with ClientSession() as session:
        blink = await connect(session)
        sm = blink.sync.get(network)
        if sm is None:
            die(f"NETWORK_NOT_FOUND: {network!r}; have {list(blink.sync.keys())}")
        await sm.async_arm(value)
        await blink.refresh(force=True)
        out({"ok": True, "network": network, "armed": sm.attributes.get("arm")})


async def cmd_liveview(name):
    # Call the liveview API directly so we can handle cameras that don't
    # support it. Blink Mini ("hawk"/mini) cameras have liveview gated behind a
    # newer app version — the API returns {"message": "An app update is
    # required"} with no "server" URL, so blinkpy's get_liveview() KeyErrors.
    # Surface that as a clean, recognizable error instead.
    from blinkpy.api import request_camera_liveview
    async with ClientSession() as session:
        blink = await connect(session)
        cam = get_camera(blink, name)
        resp = await request_camera_liveview(
            blink, cam.sync.network_id, cam.camera_id, camera_type=cam.camera_type
        )
        server = resp.get("server") if isinstance(resp, dict) else None
        if not server:
            msg = (resp.get("message") if isinstance(resp, dict) else None) or "no stream URL returned"
            die(f"LIVEVIEW_UNSUPPORTED: {msg}")
        out({"ok": True, "camera": name, "url": server})


def main():
    if len(sys.argv) < 2:
        die(__doc__)
    cmd = sys.argv[1]
    args = sys.argv[2:]
    table = {
        "setup":      lambda: cmd_setup(),
        "setup-wait": lambda: cmd_setup_wait(),
        "cameras":   lambda: cmd_cameras(),
        "snap":      lambda: cmd_snap(args[0]),
        "thumbnail": lambda: cmd_thumbnail(args[0], args[1]),
        "clip":      lambda: cmd_clip(args[0], args[1]),
        "arm":       lambda: cmd_arm(args[0], True),
        "disarm":    lambda: cmd_arm(args[0], False),
        "liveview":  lambda: cmd_liveview(args[0]),
    }
    if cmd not in table:
        die(f"Unknown command: {cmd}\n{__doc__}")
    try:
        asyncio.run(table[cmd]())
    except IndexError:
        die(f"Missing argument(s) for `{cmd}`\n{__doc__}")
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — surface any blinkpy/network error as JSON-ish stderr
        die(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
