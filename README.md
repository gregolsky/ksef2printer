# ksef2printer

Prints KSeF invoices on your own printer, from a Docker container. It works with any printer CUPS can drive: driverless (IPP Everywhere / AirPrint) printers out of the box, and older printers that need a driver.

> Status: printer setup and printing work. Fetching invoices from KSeF and the monthly run are next (see [docs/SPEC.md](docs/SPEC.md)).

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
- **What "printed" means:** over `ipp://`, a job counts as done when the printer reports it finished. Over `socket://` (port 9100), the printer gives no feedback, so it means the data was delivered.

## Development

```sh
pnpm install
pnpm lint && pnpm test
pnpm build
```

See [AGENTS.md](AGENTS.md) for the code layout and conventions, and [docs/SPEC.md](docs/SPEC.md) for the full design.

## License

MIT
