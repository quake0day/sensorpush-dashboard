"""Shared detector settings inherited from the Node/systemd environment."""

import os
from urllib.parse import quote


def enabled(name, default=False):
    return os.environ.get(name, "1" if default else "0").lower() in ("1", "true", "yes")


def rtsp_url(stream):
    host = os.environ.get("REOLINK_IP")
    password = os.environ.get("REOLINK_PASSWORD")
    if not host or not password:
        raise RuntimeError("Set REOLINK_IP and REOLINK_PASSWORD in the service environment")
    user = quote(os.environ.get("REOLINK_USER", "admin"), safe="")
    password = quote(password, safe="")
    port = os.environ.get("REOLINK_RTSP_PORT", "554")
    return f"rtsp://{user}:{password}@{host}:{port}/h264Preview_01_{stream}"


def notifications_enabled():
    # A configured topic alone must never enable outbound notifications.
    return enabled("NOTIFICATIONS_ENABLED") and bool(os.environ.get("NTFY_TOPIC"))
