#!/bin/sh
# Starts a private CUPS scheduler, creates the "ksef" queue from PRINTER_* env, then runs the CLI.
set -eu

QUEUE="${PRINTER_QUEUE:-ksef}"

cupsd
i=0
until lpstat -r >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 50 ]; then
    echo "cupsd did not start" >&2
    exit 2
  fi
  sleep 0.2
done

if [ -n "${PRINTER_URI:-}" ]; then
  # abort-job: a failed job is reported as aborted instead of stopping the queue, so the app can retry it.
  if ! lpadmin -p "$QUEUE" -E -v "$PRINTER_URI" -m "${PRINTER_MODEL:-everywhere}" -o printer-error-policy=abort-job; then
    echo "could not create printer queue (PRINTER_URI=$PRINTER_URI PRINTER_MODEL=${PRINTER_MODEL:-everywhere})" >&2
    exit 2
  fi
fi

exec node /app/cli.js "$@"
