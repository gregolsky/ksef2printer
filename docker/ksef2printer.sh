#!/bin/sh
# Runs the CLI. With PUID set (and PGID, default PUID) it drops root first, so files written to
# data/ and config/ belong to that host user. CUPS keeps running as root; jobs are submitted as PUID.
set -eu
if [ -n "${PUID:-}" ] && [ "$(id -u)" = 0 ]; then
  case "$PUID${PGID:-}" in
    *[!0-9]*)
      echo "PUID and PGID must be numeric ids (PUID=$PUID PGID=${PGID:-})" >&2
      exit 2
      ;;
  esac
  exec setpriv --reuid="$PUID" --regid="${PGID:-$PUID}" --clear-groups --inh-caps=-all node /app/cli.js "$@"
fi
exec node /app/cli.js "$@"
