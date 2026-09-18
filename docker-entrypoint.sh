#!/bin/sh
set -eu

if [ "${PLAYWRIGHT_HEADLESS:-true}" = "false" ]; then
  exec xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" node dist/server.js
fi

exec node dist/server.js
