#!/bin/sh
# Entrypoint for the `vnc` image target only.
#
# Brings up a virtual X display, bridges it to the browser over noVNC, then
# hands off to wigolo. This exists for ONE reason: the human-solve rung is a
# hard no-op without a visible surface, so a container that should ever prompt
# a human needs a display someone can actually look at.
#
# Layout:
#   Xvfb        :99            virtual display, no TCP listener
#   x11vnc      127.0.0.1:5900 VNC server, loopback-only, password-gated
#   websockify  0.0.0.0:6080   serves the noVNC web client, proxies to x11vnc
#
# x11vnc binds loopback INSIDE the namespace, so the only reachable surface is
# the websockify port, which Compose publishes to host loopback only.

set -eu

DISPLAY="${DISPLAY:-:99}"
export DISPLAY

VNC_PORT=5900
NOVNC_PORT="${WIGOLO_NOVNC_PORT:-6080}"
SCREEN_GEOMETRY="${WIGOLO_VNC_GEOMETRY:-1920x1080x24}"
PASSWD_FILE=/tmp/.vncpasswd

# --- password gate ---------------------------------------------------------
# This surface grants full mouse/keyboard control of a browser that may hold
# authenticated sessions. Refuse to start unauthenticated rather than default
# to an open port.
if [ -n "${WIGOLO_VNC_PASSWORD_FILE:-}" ] && [ -r "${WIGOLO_VNC_PASSWORD_FILE}" ]; then
  VNC_PASSWORD="$(head -c 512 "${WIGOLO_VNC_PASSWORD_FILE}" | tr -d '\r\n')"
elif [ -n "${WIGOLO_VNC_PASSWORD:-}" ]; then
  VNC_PASSWORD="${WIGOLO_VNC_PASSWORD}"
else
  echo "[vnc-entrypoint] refusing to start: no VNC password." >&2
  echo "[vnc-entrypoint] set WIGOLO_VNC_PASSWORD_FILE (preferred) or WIGOLO_VNC_PASSWORD." >&2
  exit 1
fi

if [ -z "${VNC_PASSWORD}" ]; then
  echo "[vnc-entrypoint] refusing to start: VNC password is empty." >&2
  exit 1
fi

umask 077
x11vnc -storepasswd "${VNC_PASSWORD}" "${PASSWD_FILE}" >/dev/null 2>&1
unset VNC_PASSWORD

# --- virtual display -------------------------------------------------------
# Pre-create the socket directory. /tmp is a fresh tmpfs on every start and Xvfb
# runs unprivileged, so it logs `_XSERVTransmkdir: euid != 0` and falls back
# when the directory is absent. Creating it here keeps the X socket on the
# expected path and drops a misleading error from the startup logs.
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix 2>/dev/null || true

# -nolisten tcp: the display is reachable only through the local unix socket.
Xvfb "${DISPLAY}" -screen 0 "${SCREEN_GEOMETRY}" -nolisten tcp &

# Wait for the X socket rather than sleeping a fixed interval: on a cold
# container Xvfb can take longer than any guess, and x11vnc exits immediately
# if it attaches before the display exists.
socket="/tmp/.X11-unix/X${DISPLAY#:}"
waited=0
while [ ! -S "${socket}" ]; do
  if [ "${waited}" -ge 100 ]; then
    echo "[vnc-entrypoint] Xvfb did not create ${socket} within 10s" >&2
    exit 1
  fi
  sleep 0.1
  waited=$((waited + 1))
done

# --- vnc + web client ------------------------------------------------------
x11vnc -display "${DISPLAY}" \
       -rfbauth "${PASSWD_FILE}" \
       -rfbport "${VNC_PORT}" \
       -localhost \
       -forever -shared -noxdamage -quiet &

websockify --web /usr/share/novnc "0.0.0.0:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" &

echo "[vnc-entrypoint] noVNC on container port ${NOVNC_PORT}; display ${DISPLAY} (${SCREEN_GEOMETRY})" >&2

# exec so wigolo owns PID 1's signal handling (Compose `init: true` reaps the
# background helpers when the container stops).
exec node /app/dist/index.js "$@"
