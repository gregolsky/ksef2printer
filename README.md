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

## Notifications and commands from your phone (ntfy)

Set `NTFY_URL` and `NTFY_TOPIC` in `.env` to get an [ntfy](https://ntfy.sh) notification when a run finishes. Each one lists every invoice of the month with its status, in the same lines as the log:

```
2026-09: 2 printed, 0 failed, 1 already printed

[printed   ] 2026-09-01  ZAKUP FV/3/2026 (Seller sp. z o.o.)  1230.00 PLN  <KSeF number>
[PRINTED   ] 2026-09-02  SPRZEDAŻ FV/1/2026 (Client s.c.)  500.00 PLN  <KSeF number>
```

Dry runs send the same list, marked `DRY RUN`. If a run stops part way, you get an alert with the reason. Long lists are split over several messages.

To start runs from your phone, also run the listener:

```sh
docker compose up -d listener
```

Then, in the ntfy app, subscribe to your topic and send a message (no title) to it:

| Message | Does |
|---|---|
| `dry-run 2026-09` | lists the month, prints nothing |
| `print 2026-09` | prints what is not printed yet |
| `help` | lists the commands |

The listener replies `▶ … started`, then sends the summary. Only one run happens at a time; a command sent during a run gets a `Busy` reply. Commands older than 10 minutes are ignored. While the listener runs, `./print.sh` runs inside its container. After changing `.env` or running `setup`, restart it with `docker compose up -d listener`.

**Keep the topic secret.** On the public ntfy.sh server anyone who knows the topic name can read the invoice lists and start printing. Generate it with `openssl rand -hex 16`, use a protected topic with `NTFY_TOKEN`, or run your own ntfy server.

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
| `docker compose up -d listener` | Accept `print` / `dry-run` commands over ntfy |

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
