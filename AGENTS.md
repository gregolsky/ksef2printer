# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

ksef2printer prints KSeF (Polish National e-Invoice System) invoices for a given month on a local printer, from a Docker container. The product spec is `docs/SPEC.md`; the original intent is `docs/intent/ksef2printer.md`. Read the spec before changing behaviour, and update it in the same change when behaviour changes.

Current state: printer layer done (setup, discovery, printing). KSeF client, PDF rendering and the monthly run are not built yet — see "Delivery order" in the spec.

## Commands

```sh
pnpm install          # Node 22, pnpm 9.15 (use `npx pnpm@9.15.0` if pnpm is not installed)
pnpm lint             # tsc --noEmit
pnpm test             # vitest
pnpm build            # tsup → dist/cli.js (single bundled ESM file)
docker compose build  # runtime image with CUPS and drivers
./print.sh <command>  # run the CLI in the container (setup, discover, test-page, print-pdf, drivers)
```

Run `pnpm lint && pnpm test` before every commit.

## Layout

| Path | Role |
|---|---|
| `src/cli.ts` | Command dispatch; the only module with side effects at import |
| `src/printer/cups.ts` | Submit jobs with `lp`, poll job state with `ipptool` against the in-container `cupsd` |
| `src/printer/discover.ts` | mDNS browse for `_ipp`, `_ipps`, `_pdl-datastream` printers (no Avahi daemon) |
| `src/printer/suggest.ts` | Pure logic: discovered printer + `lpinfo -m` → `PRINTER_URI`/`PRINTER_MODEL` |
| `src/exec.ts` | `run()` wrapper over `execFile`; inject a fake `Run` in tests |
| `docker/entrypoint.sh` | Starts `cupsd`, creates the `ksef` queue from `PRINTER_*` env, execs the CLI |
| `docker/job-state.test` | ipptool request used by `cups.ts` |

## Rules

- **Printer support is configuration, not code.** Never add printer- or vendor-specific code paths. A new printer means a driver package (`EXTRA_DRIVER_PACKAGES`), a PPD, or better heuristics in `suggest.ts`, which stays pure and unit-tested.
- **Never send data straight to a printer** (`nc`, raw sockets). Always go through the CUPS queue, so the driver's filter chain is applied. Raw PDF sent to a host-based printer prints blank pages.
- **Do not print on a real printer without asking the user first** — it uses paper. Test with a fake sink instead: a `socket://127.0.0.1:9100` queue with a local TCP listener inside the container.
- **Keep shell-outs injectable.** New external commands go through `Run` so they can be tested without CUPS.
- **No secrets or personal data in the repo.** `.env` and `config/` are git-ignored; examples use `192.168.1.x` addresses and made-up hostnames. KSeF tokens, NIPs and invoice contents never go in fixtures, logs or commits.
- **Style:** TypeScript strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; ESM with `.js` import suffixes; zod for env parsing; no new runtime dependencies without a reason.
- Exit codes: `0` ok, `1` some printing failed, `2` configuration error.
