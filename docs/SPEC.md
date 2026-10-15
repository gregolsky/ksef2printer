# ksef2printer — spec

Print every KSeF invoice for a given month on a local printer with one command. Runs in Docker, works with any printer CUPS can drive.

## CLI

```
./print.sh 2026-10            # fetch, render and print every invoice issued in Oct 2026
./print.sh 2026-10 --dry-run  # list what would print, print nothing
./print.sh setup             # scan the network (mDNS), pick a printer, write config/printer.env
./print.sh discover          # list printers with suggested settings
./print.sh test-page         # print a CUPS test page
./print.sh print-pdf file.pdf # print one PDF
./print.sh drivers brother    # search installed drivers/models
```

Exit codes: `0` everything printed (or nothing to do), `1` some documents failed, `2` configuration or KSeF error.

## Configuration (`.env`)

| Variable | Required | Meaning |
|---|---|---|
| `KSEF_TOKEN` | yes | KSeF token with `InvoiceRead` permission |
| `KSEF_NIP` | yes | Taxpayer NIP |
| `KSEF_ENV` | no | `prod` (default), `demo` or `test` |
| `PRINTER_URI` | yes | CUPS device URI, e.g. `ipp://printer.local/ipp/print`, `socket://192.168.1.50:9100` |
| `PRINTER_MODEL` | no | `everywhere` (default, driverless IPP), a model from `drivers`, or `/config/printer.ppd` |
| `PRINTER_OPTIONS` | no | Space-separated CUPS options, e.g. `PageSize=A4 sides=two-sided-long-edge` |
| `PRINT_TIMEOUT_SECONDS` | no | Max wait for one job to finish (default `300`) |
| `NTFY_URL` | no | ntfy server, e.g. `https://ntfy.sh`; notifications off when unset |
| `NTFY_TOPIC` | with `NTFY_URL` | ntfy topic |
| `NTFY_TOKEN` | no | ntfy access token |

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
4. Download the XML to `data/invoices/YYYY-MM/<ksefNumber>.xml` and render a PDF next to it with [CIRFMF/ksef-pdf-generator](https://github.com/CIRFMF/ksef-pdf-generator).
5. Print in issue-date order, purchases first, one job per invoice.
6. Notify through ntfy after each document and once at the end.

## State

`data/state/YYYY-MM.json`, keyed by KSeF number:

```json
{ "1234567890-20261003-ABC123-01": { "status": "printed", "attempts": 1, "jobId": "ksef-12", "issueDate": "2026-10-03", "updatedAt": "2026-10-15T19:40:00Z" } }
```

`status` is `printed` or `failed`. Written atomically (temp file + rename) after every document, so an interrupted run resumes where it stopped.

## Retry

Up to 3 attempts per document, with 10 s, 30 s and 90 s waits between them. Retries happen on a submit error, a job that ends `aborted`, `canceled` or `stopped`, or a timeout. A `stopped` queue is re-enabled (`cupsenable`) before the next attempt. A document still failing after 3 attempts is marked `failed` and the run moves on.

## Notifications (ntfy)

- Per document: `✓ Printed FV/123/2026 (ACME sp. z o.o.)`, or `✗ Failed FV/123/2026 after 3 attempts: <reason>` with priority `high`.
- Summary: `2026-10: 14 printed, 1 failed, 3 already printed`, priority `default` or `high` if anything failed.
- An ntfy failure is logged and never fails the run.

## Retention

Each run deletes invoice files whose issue date is more than 1 year ago, along with their state entries. Rerunning such a month downloads and prints it again.

## Delivery order

1. Container with CUPS, printer setup from env, `print-pdf`, `discover`, `drivers`, CI.
2. KSeF API 2.0 client: auth, metadata query, XML download, contract test against a pinned `open-api.json`.
3. XML → PDF rendering.
4. Monthly run: state, retry, ntfy, retention, `--dry-run`.

## Out of scope

Google Drive, scheduling, non-KSeF documents, multiple KSeF accounts, any UI.
