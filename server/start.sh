#!/usr/bin/env bash
# start.sh — one-shot launcher.
# Usage:
#   ./start.sh         # foreground (Ctrl+C to stop)
#   ./start.sh -d      # background (daemon mode, log -> server.log)
#   ./start.sh stop    # stop the background daemon
#
# Reads env from .env in this directory. Auto-installs node_modules if missing.

set -e
cd "$(dirname "$0")"

PIDFILE=server.pid
LOGFILE=server.log

case "${1:-}" in
  stop)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
      kill "$(cat $PIDFILE)" && rm -f "$PIDFILE"
      echo "stopped."
    else
      echo "not running."
    fi
    exit 0
    ;;
esac

# 1) Check .env
if [ ! -f .env ]; then
  echo "❌ Missing .env"
  echo "→ copy the template and fill in values:"
  echo "   cp .env.example .env && nano .env"
  exit 1
fi

# 2) Install deps if needed
if [ ! -d node_modules ]; then
  echo "📦 Installing dependencies..."
  npm install --omit=dev
fi

# 3) Run
if [ "${1:-}" = "-d" ]; then
  echo "🚀 Starting in background (log: $LOGFILE)"
  nohup node --env-file=.env index.js > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  echo "PID: $(cat $PIDFILE)"
  echo "Tail log: tail -f $LOGFILE"
  echo "Stop: ./start.sh stop"
else
  echo "🚀 Starting (Ctrl+C to stop)"
  exec node --env-file=.env index.js
fi
