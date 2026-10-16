# ksef2printer

Prints KSeF invoices on your own printer, from a Docker container. It works with any printer CUPS can drive: driverless (IPP Everywhere / AirPrint) printers out of the box, and older printers that need a driver.

> Status: works end to end against the KSeF **test** environment. Production use is next.

## Requirements

- Docker with the compose plugin (Linux; tested on Raspberry Pi OS / Debian 13, arm64)
- A printer on the same local network

## Setup

```sh
git clone https://github.com/gregolsky/ksef2printer && cd ksef2printer
cp .env.example .env
./print.sh setup       # finds printers on the network, you pick one
./print.sh test-page   # prints a CUPS test page
```

Then add your KSeF token to `.env` (generate it in the KSeF taxpayer app with only the **InvoiceRead** permission):

```sh
KSEF_TOKEN=...
KSEF_NIP=1234567890
```

## Printing a month

```sh
./print.sh 2026-10 --dry-run   # list the month's invoices and what would print
./print.sh 2026-10 --limit 1   # print just the first one, to check
./print.sh 2026-10             # print the rest
```

Purchases print first, then sales, each oldest first. Every printed invoice is remembered in `data/state/`, so running the same month again only prints what is missing. A failed print is retried 3 times. The QR code on each printed invoice carries the hash KSeF holds for it, and an invoice whose downloaded XML doesn't match that hash is not printed. Invoice XML and PDFs are kept in `data/invoices/` for a year, then deleted. Each run's log is saved to `data/logs/` for the same period.

The printer is checked before anything prints. If it is off, or goes away during the run, the run stops with one notification instead of retrying every invoice, and the next run picks up where it stopped.

Set `NTFY_URL` and `NTFY_TOPIC` in `.env` to get an [ntfy](https://ntfy.sh) notification for every printed or failed invoice, a summary at the end, and an alert if the run stops part way. Notifications include invoice numbers and counterparty names. On the public ntfy.sh server anyone who knows the topic can read them, so use a long random topic, a protected topic with `NTFY_TOKEN`, or your own ntfy server.

`setup` saves the printer settings to `config/printer.env`, for example:

```sh
# Driverless printer
PRINTER_URI=ipp://192.168.1.40:631/ipp/print
PRINTER_MODEL=everywhere
PRINTER_OPTIONS=media=A4

# Brother HL-1210W (host-based, needs the brlaser driver)
PRINTER_URI=socket://192.168.1.50:9100
PRINTER_MODEL=drv:///brlaser.drv/br1200.ppd
PRINTER_OPTIONS=media=A4
```

To add duplex or other options, edit `PRINTER_OPTIONS` (space-separated CUPS options, e.g. `media=A4 sides=two-sided-long-edge`).

## Commands

| Command | What it does |
|---|---|
| `./print.sh YYYY-MM [--limit N] [--dry-run]` | Print the month's KSeF invoices |
| `./print.sh setup [n]` | Scan the network, pick printer `n`, save its settings |
| `./print.sh discover` | List printers with suggested settings, save nothing |
| `./print.sh test-page` | Print a test page on the configured printer |
| `./print.sh print-pdf data/file.pdf` | Print one PDF (paths are inside `./data`) |
| `./print.sh drivers <text>` | Search installed drivers, e.g. `drivers canon` |

## If your printer is not found or does not print

- **Not found:** the container uses host networking to see mDNS announcements. Check that the printer is on and in the same network. You can always set `PRINTER_URI` by hand in `.env`, using `ipp://<ip>/ipp/print` or `socket://<ip>:9100`.
- **Needs a driver that is not in the image:** the image includes `brlaser` (Brother lasers) and `gutenprint` (many Canon, Epson, HP and others). Add more Debian driver packages at build time:
  ```sh
  docker compose build --build-arg EXTRA_DRIVER_PACKAGES="hplip printer-driver-foo2zjs printer-driver-splix"
  ```
  Then run `./print.sh setup` again. A vendor PPD file also works: put it at `config/printer.ppd` and set `PRINTER_MODEL=/config/printer.ppd`.
- **What "printed" means:** over `ipp://`, a job counts as done when the printer reports it finished. Over `socket://` (port 9100), the printer gives no feedback, so it means the data was delivered. If a `socket://` job times out, it may have printed anyway, so the retry can give you a duplicate page. A duplicate is safer than a missing invoice.

## Development

```sh
pnpm install
pnpm lint && pnpm test
pnpm build
./scripts/build-pdf-renderer.sh   # vendor/ksef-pdf.js, needed to render PDFs outside Docker
```

### Trying it on the KSeF test environment

The test environment (`KSEF_ENV=test`) is shared by everyone, so use a random NIP and no real data. Get a test KSeF token with `InvoiceRead` and `InvoiceWrite` (for example with the official [CertTestApp](https://github.com/CIRFMF/ksef-docs/blob/main/auth/testowe-certyfikaty-i-podpisy-xades.md) plus `POST /tokens`), then issue a few fictitious invoices:

```sh
KSEF_NIP=... KSEF_TOKEN=... pnpm tsx scripts/seed-test-invoices.ts 3
```

See [AGENTS.md](AGENTS.md) for the code layout and conventions, and [docs/SPEC.md](docs/SPEC.md) for the full design.

## License

MIT. Invoice PDFs are rendered with [CIRFMF/ksef-pdf-generator](https://github.com/CIRFMF/ksef-pdf-generator) (MIT), built into the image.
