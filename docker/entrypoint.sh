#!/bin/sh
# Container entrypoint for `wilson --dashboard`.
#
# WILSON_LAN_HOSTS (comma-separated names/IPs people type in the browser,
# e.g. "nas.local,192.168.1.20") is expanded into the two allowlists the
# dashboard's DNS-rebinding and origin checks read:
#   WILSON_DASHBOARD_ALLOWED_HOSTS    += nas.local,192.168.1.20
#   WILSON_DASHBOARD_ALLOWED_ORIGINS  += http://nas.local:<port>,http://192.168.1.20:<port>
# <port> is WILSON_HOST_PORT, the port published on the host (default 3141).
# Anything already in those two variables (an https:// reverse-proxy origin,
# say) is kept.
set -eu

PORT="${WILSON_HOST_PORT:-3141}"
if [ -n "${WILSON_LAN_HOSTS:-}" ]; then
  hosts=""
  origins=""
  for h in $(echo "$WILSON_LAN_HOSTS" | tr ',' ' '); do
    hosts="$hosts,$h"
    origins="$origins,http://$h:$PORT"
  done
  export WILSON_DASHBOARD_ALLOWED_HOSTS="${WILSON_DASHBOARD_ALLOWED_HOSTS:-}$hosts"
  export WILSON_DASHBOARD_ALLOWED_ORIGINS="${WILSON_DASHBOARD_ALLOWED_ORIGINS:-}$origins"
fi

exec bun /app/src/index.tsx "$@"
