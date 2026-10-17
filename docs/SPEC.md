# ksef2printer — spec

Print every KSeF invoice for a given month on a local printer with one command. Runs in Docker, works with any printer CUPS can drive.

## CLI

```
./print.sh 2026-10            # fetch, render and print every invoice issued in Oct 2026
./print.sh 2026-10 --dry-run  # list what would print, print nothing
./print.sh 2026-10 --limit 1  # print at most one invoice this run
./print.sh setup             # scan the network (mDNS), pick a printer, write config/printer.env
./print.sh discover          # list printers with suggested settings
./print.sh test-page         # print a CUPS test page
./print.sh print-pdf file.pdf # print one PDF
./print.sh drivers brother    # search installed drivers/models
```

Exit codes: `0` everything printed (or nothing to do), `1` some documents failed or the run stopped part way (KSeF unreachable, token rejected), `2` configuration error.

## Configuration (`.env`)

| Variable | Required | Meaning |
|---|---|---|
| `KSEF_TOKEN` | yes | KSeF token with `InvoiceRead` permission |
| `KSEF_NIP` | yes | Taxpayer NIP |
| `KSEF_ENV` | no | `prod` (default), `demo` or `test` |
| `PRINTER_URI` | yes | CUPS device URI, e.g. `ipp://printer.local/ipp/print`, `socket://192.168.1.50:9100` |
| `PRINTER_MODEL` | no | `everywhere` (default, driverless IPP), a model from `drivers`, or `/config/printer.ppd` |
| `PRINTER_OPTIONS` | no | Space-separated CUPS options, e.g. `PageSize=A4 sides=two-sided-long-edge` |
| `RETRY_DELAYS_SECONDS` | no | Waits between print attempts (default `10,30,90`) |
| `PRINT_TIMEOUT_SECONDS` | no | Max wait for one job to finish (default `300`) |
| `NTFY_TOPIC` | no | ntfy topic; notifications and the listener are off when unset |
| `NTFY_URL` | no | ntfy server, default `https://ntfy.sh` |
| `NTFY_TOKEN` | no | ntfy access token |
| `PUID`, `PGID` | no | Run the app as this host user and group (CUPS stays root), so `data/` and `config/` belong to that user. `PGID` defaults to `PUID` |

## Printer layer

The container runs a local `cupsd` (localhost only, no web UI). On start the entrypoint creates one queue, `ksef`, from `PRINTER_URI`, `PRINTER_MODEL` and `PRINTER_OPTIONS`. The app only ever talks to that queue with `lp` and `lpstat`, so supporting another printer is configuration, never code.

- **Driverless printers** (IPP Everywhere / AirPrint, most printers since ~2015): `PRINTER_MODEL=everywhere`.
- **Printers that need a driver**: the image ships `brlaser` (Brother) and `gutenprint` (many Canon, Epson, HP). Other Debian driver packages go in the `EXTRA_DRIVER_PACKAGES` build arg (e.g. `hplip printer-driver-foo2zjs printer-driver-splix`). A vendor PPD can be mounted at `/config/printer.ppd`.
- **Success semantics.** A job is `printed` when CUPS reports it `completed`. Over `ipp://` that means the printer reported it done. Over `socket://` (raw port 9100) it only means the data was delivered, because the protocol has no feedback.
- Compose uses `network_mode: host` so mDNS names (`*.local`) and `discover` work.

**Setup from the network.** `setup` browses `_ipp._tcp`, `_ipps._tcp` and `_pdl-datastream._tcp` over mDNS (in-process, no Avahi daemon needed) and groups services by host. For each printer:
1. If its IPP TXT record lists `image/pwg-raster` or `image/urf` (or a `URF` key), it is driverless: `ipp://<ip>:<port>/<rp>` + `everywhere`.
2. Otherwise it looks up the make and model (`usb_MFG`/`usb_MDL`, else `ty`) in `lpinfo -m`, falling back to shorter model prefixes (HL-1210W → "HL-1200 series"). Dedicated drivers rank above Gutenprint, and Gutenprint "simple" ranks above "expert". The URI is `socket://<ip>:<pdl port or 9100>`.
3. If no driver matches, it suggests driverless and says that it may not work.

The chosen settings are checked with a throwaway `lpadmin` queue, then written to `config/printer.env` (`PRINTER_OPTIONS` defaults to `media=A4`).

Reference setup (Brother HL-1210W, host-based printer with no usable IPP):
`PRINTER_URI=socket://192.168.1.50:9100`, `PRINTER_MODEL=drv:///brlaser.drv/br1200.ppd`, `PRINTER_OPTIONS=media=A4`.

## Monthly run

1. Authenticate to KSeF API 2.0 with the token.
2. Query invoice metadata for the month by **issue date**, both as buyer (`ZAKUP`) and seller (`SPRZEDAŻ`), paging until done.
3. Skip invoices whose state is `printed`.
4. Download the XML as raw bytes to `data/invoices/YYYY-MM/<ksefNumber>.xml` and render a PDF next to it with [CIRFMF/ksef-pdf-generator](https://github.com/CIRFMF/ksef-pdf-generator). The XML must match the `invoiceHash` from the metadata, or the invoice is marked `failed` and not printed. The QR code (KOD I) uses that hash. A saved XML that no longer matches is downloaded again and its PDF re-rendered. Both files are written atomically, so an interrupted run never leaves a half-written file to be reused.
5. Before the first job, check that the printer accepts a TCP connection at `PRINTER_URI` (5 s timeout; non-TCP URIs such as `usb://` are not checked). If it doesn't, stop before downloading anything. Print in issue-date order, purchases first, one job per invoice, logging `printing i/n: …` before each. `--limit N` prints at most N invoices this run; the rest stay for the next run.
6. Notify through ntfy once at the end, with the invoice list. If printing stops part way (printer gone), the same list goes out as a `high` priority `stopped` notification, with the reason and `NOT YET` on the invoices left. If the run stops before the list is known (KSeF down, token rejected), the notification has only the reason.

## State

`data/state/YYYY-MM.json`, keyed by KSeF number:

```json
{ "1234567890-20261003-ABC123-01": { "status": "printed", "attempts": 1, "jobId": "ksef-12", "issueDate": "2026-10-03", "updatedAt": "2026-10-15T19:40:00Z" } }
```

`status` is `printed` or `failed`. Written atomically (temp file + rename) after every document, so an interrupted run resumes where it stopped.

## Retry

Up to 4 attempts per document (the first plus one per `RETRY_DELAYS_SECONDS` entry), with 10 s, 30 s and 90 s waits between them. Retries happen on a submit error, a job that ends `aborted`, `canceled` or `stopped`, or a timeout (the job is cancelled first). The queue uses `printer-error-policy=abort-job`, so a failed job never stops the queue. A document still failing after the last attempt is marked `failed` and the run moves on. Over `socket://` a timed-out job may already have printed, so a retry can produce a duplicate. That is preferred to a missing invoice.

When a job times out, the printer is checked again, and if it is unreachable the run stops at once. If it is reachable but an invoice times out on every attempt, the run also stops. Either way the remaining invoices are left for the next run, and one `stopped` notification is sent with the month's list. A printer that is off therefore costs at most one print timeout, not 22 minutes per invoice.

KSeF requests are retried up to 4 times on network errors, 429 and 5xx, waiting 2, 4 and 8 s or what `Retry-After` asks. A `Retry-After` above 60 s fails the run with the reason instead of blocking it.

## Notifications (ntfy)

- **One summary per run**, real or dry, and no per-invoice messages. Title `ksef2printer 2026-10`, or `ksef2printer 2026-10 — DRY RUN`. The body is the counts line (`2026-10: 14 printed, 1 failed, 3 already printed`; dry run: `Dry run: nothing was printed.` then `… would print …`), then one line per invoice of the month, the same lines that go to the log:
  `[MARK      ] <issue date>  ZAKUP|SPRZEDAŻ <number> (<counterparty>)  <gross> <currency>  <KSeF number>`
  The marks are `printed` (in an earlier run), `PRINTED` (this run), `FAILED` (followed by a `↳ reason` line), `WILL PRINT` (dry run), and `later` (beyond `--limit`).
- Priority is `high` with tag `warning` if anything failed. Otherwise the tag is `white_check_mark`, or `mag` for a dry run.
- A body over 3800 bytes is split on line boundaries into messages titled `(1/n)`, so ntfy.sh never turns it into an attachment.
- Run stopped: `✗ ksef2printer 2026-10 stopped`, priority `high`: the reason, `Run the month again to print the rest.`, the counts with `N not printed yet`, then the list (`[NOT YET   ]` for what is left). When the run stops before the list is known, only the reason.
- Every message is sent with `Cache: no`. ntfy delivers it to subscribers who are connected (and through push to the phone app), but doesn't keep it, so nobody can fetch the invoice lists from the server later. A phone that was offline for longer than the push service holds messages misses that summary; the log on the Pi still has it.
- An ntfy failure is logged and never fails the run.

## Commands over ntfy

`docker compose up -d listener` runs `listen`. It subscribes to `NTFY_COMMAND_TOPIC` (default `NTFY_TOPIC`) via the ntfy JSON stream and accepts messages without a title:

| Message | Action |
|---|---|
| `dry-run YYYY-MM` | the month run with `--dry-run` |
| `print YYYY-MM` | the month run |
| `help` | replies with the command list |

- Parsing is exact (case and extra spaces aside). Anything else gets an `Unknown command` reply, and message text is never used in a shell or a path. Titled messages are ignored: they are the app's own replies on a shared topic.
- Each command is confirmed with `▶ <command> started`, then the run sends its summary or `stopped` alert.
- One run at a time, no queue: a command during a run gets `Busy: … is running`, including while a manual `./print.sh` run holds `data/run.lock`. The lock also stops a manual run from starting during a listener run; that run exits with the error and sends no alert, since nothing ran. The lock records the host's boot id: a lock from before a reboot (power cut mid-run) is stale at once, and one older than 6 h is stale too; a stale lock is taken over. The process releases it on any exit, a crash included.
- Commands older than 10 minutes (by ntfy's timestamp) are ignored. After a disconnect, the listener reconnects with backoff (5 s up to 60 s) and resumes with `since=<last message id>`. It also reconnects if not even a keepalive arrives for 120 s.
- While the listener runs, `print.sh` executes commands inside its container, because a second container would start a second CUPS on the same host port.
- Limits: an `Unknown command` reply goes out at most once a minute, so spam can't use up the ntfy quota the summaries need. A stream line over 64 KB drops the connection, which then reconnects. At startup the listener warns if the topic is shorter than 20 characters and has no token, or if `NTFY_URL` is plain `http://` outside the local network.
- Security rests on the topic: on public ntfy.sh anyone who knows it can read the lists and start printing. Use a long random topic, or `NTFY_TOKEN` with a protected topic or your own server.

## Logs

The container is removed after each run, so month runs and the listener also append their log to `data/logs/YYYY-MM-DD.log`. Each line goes to the file of its own UTC date, so a listener running for weeks still writes one file per day. Tokens never appear in logs.

## Retention

Each run deletes invoice files whose issue date is more than 1 year ago, along with their state entries and run logs older than a year. Rerunning such a month downloads and prints it again.

## Delivery order

1. Container with CUPS, printer setup from env, `print-pdf`, `discover`, `drivers`, CI.
2. KSeF API 2.0 client: auth, metadata query, XML download, contract test against a pinned `open-api.json`.
3. XML → PDF rendering.
4. Monthly run: state, retry, ntfy, retention, `--dry-run`.

## Out of scope

Google Drive, scheduling, non-KSeF documents, multiple KSeF accounts, any UI.
