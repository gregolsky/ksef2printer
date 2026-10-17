#!/bin/sh
# Runs the CLI. With PUID set (and PGID, default PUID) it drops root first, so files written to
# data/ and config/ belong to that host user. CUPS keeps running as root; jobs are submitted as PUID.
set -eu
if [ -z "${PUID:-}" ] && [ -n "${PGID:-}" ]; then
  echo "PGID is set but PUID is not: running as root. Set PUID too." >&2
fi
if [ -n "${PUID:-}" ] && [ "$(id -u)" = 0 ]; then
  case "$PUID${PGID:-}" in
    *[!0-9]*)
      echo "PUID and PGID must be numeric ids (PUID=$PUID PGID=${PGID:-})" >&2
      exit 2
      ;;
  esac
  PGID="${PGID:-$PUID}"
  # Files left by earlier runs as root would fail the run part way; say how to fix it up front.
  for dir in /data /config; do
    [ -d "$dir" ] || continue
    if ! setpriv --reuid="$PUID" --regid="$PGID" --clear-groups test -w "$dir" \
      || [ -n "$(find "$dir" -maxdepth 3 ! -uid "$PUID" -print -quit)" ]; then
      echo "$dir has files PUID=$PUID cannot write. On the host, in the ksef2printer folder, run once:" >&2
      echo "  sudo chown -R $PUID:$PGID data config" >&2
      exit 2
    fi
  done
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all node /app/cli.js "$@"
fi
exec node /app/cli.js "$@"
