# ksef2printer — confirmed intent (2026-10-15)

- **Outcome:** `./print.sh 2026-10` fetches that month's KSeF invoices, renders each to PDF, and sends it to the LAN printer (brlaser raster over raw port 9100 — see Printer below).
- **User:** single user, single KSeF account. The printed stack goes to the accounting office monthly.
- **Why now:** printing each document by hand from a phone is the pain point.
- **Success:** one run prints every invoice for the month. Failed prints retry 3x with backoff. Printed invoices are remembered, so a rerun prints only what's missing. Every success/failure is reported via ntfy, plus a final summary.
- **Retention:** XML/PDF files kept on a mounted volume for 1 year from issue date; each run prunes expired files and their print records.
- **Constraint:** runs in a Docker container on the Raspberry Pi; triggered by hand via a script (no scheduler yet). Own KSeF API 2.0 client (auth, query, XML download); PDF rendering via CIRFMF/ksef-pdf-generator.
- **Out of scope:** Google Drive, scheduling, bank statements / non-KSeF documents, multi-tenant, any UI.

Defaults: purchases + sales, grouped by issue date; per-month JSON state keyed by KSeF number; ntfy server URL + topic from `.env`.

## Printer (verified 2026-10-15)

- Brother HL-1210W at 192.168.1.50 (`BRN001122334455.local`). Host-based (GDI) printer: IPP endpoint is a stub (no PDF/PS/PCL), so IPP printing is not an option.
- Working path, tested from a `debian:trixie-slim` container on the Pi (arm64, Debian 13, Docker 29): `printer-driver-brlaser` + `cups` + `cups-ppdc` + `ghostscript`; compile PPD with `ppdc /usr/share/cups/drv/brlaser.drv` → `br1200.ppd` ("HL-1200 series"); `cupsfilter -p br1200.ppd -m printer/foo -e -i application/pdf in.pdf > out.prn`; send with `nc -N 192.168.1.50 9100 < out.prn`. No cupsd needed.
- Port 9100 gives no print confirmation: a successful TCP send is "submitted", not "printed". Retry covers connection/send errors only.
