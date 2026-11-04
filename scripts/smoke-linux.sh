#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

# The workstation's prescribed harness already supplies a private display.
# electron-smoke checks its authority and reserved display before launching.
if [[ "${AGENT_BROKER_SMOKE_HEADFUL:-0}" == 1 ]]; then
  exec node scripts/electron-smoke.mjs
fi

for task_command in xvfb-run dbus-run-session; do
  command -v "$task_command" >/dev/null || {
    printf 'Missing %s; install the documented Linux smoke prerequisites.\n' "$task_command" >&2
    exit 1
  }
done

exec xvfb-run -a -n 90 -s '-screen 0 1600x1000x24 -nolisten tcp' \
  dbus-run-session -- env -u WAYLAND_DISPLAY AGENT_BROKER_SMOKE_HEADFUL=0 \
  node scripts/electron-smoke.mjs
