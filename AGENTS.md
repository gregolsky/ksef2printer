# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

ksef2printer prints KSeF (Polish National e-Invoice System) invoices for a given month on a local printer, from a Docker container. The product spec is `docs/SPEC.md`; the original intent is `docs/intent/ksef2printer.md`. Read the spec before changing behaviour, and update it in the same change when behaviour changes.

Current state: works end to end on the KSeF test environment (fetch → render → print → state → ntfy). Not yet run against production.

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
| `src/printer/reachable.ts` | TCP check of `PRINTER_URI` before printing and after a job timeout |
| `src/printer/suggest.ts` | Pure logic: discovered printer + `lpinfo -m` → `PRINTER_URI`/`PRINTER_MODEL` |
| `src/run.ts` | Monthly run: query, order, limit, download, render, print with retries, state, notifications, retention |
| `src/ksef/client.ts` | KSeF API 2.0: token auth, metadata query (paging/truncation), XML download, 429/5xx retry |
| `src/ksef/qr.ts`, `src/ksef/time.ts` | KOD I verification link; Europe/Warsaw month bounds |
| `src/pdf/render.ts` | Loads the vendored ksef-pdf-generator build and renders XML → PDF |
| `src/state.ts`, `src/notify.ts` | Per-month state file; ntfy publisher (never fails the run), `sendLong` splits long lists |
| `src/listen.ts` | ntfy command listener: strict parser, one run at a time, reconnect with `since=` |
| `src/fs.ts` | `exists`, `writeFileAtomic` (temp file + rename); `withRunLock` (`data/run.lock`) so two runs never overlap |
| `scripts/seed-test-invoices.ts` | Issues fictitious invoices on the KSeF **test** environment |
| `src/logger.ts` | Console logger; month runs also append to `data/logs/YYYY-MM-DD.log` |
| `src/exec.ts` | `run()` wrapper over `execFile`; inject a fake `Run` in tests |
| `docker/entrypoint.sh` | Starts `cupsd`, creates the `ksef` queue from `PRINTER_*` env, execs the CLI |
| `docker/job-state.test` | ipptool request used by `cups.ts` |

## Rules

- **Printer support is configuration, not code.** Never add printer- or vendor-specific code paths. A new printer means a driver package (`EXTRA_DRIVER_PACKAGES`), a PPD, or better heuristics in `suggest.ts`, which stays pure and unit-tested.
- **Never send data straight to a printer** (`nc`, raw sockets). Always go through the CUPS queue, so the driver's filter chain is applied. Raw PDF sent to a host-based printer prints blank pages.
- **Do not print on a real printer without asking the user first** — it uses paper. Test with a fake sink instead: a `socket://127.0.0.1:9100` queue with a local TCP listener inside the container.
- **Keep shell-outs injectable.** New external commands go through `Run` so they can be tested without CUPS.
- **No secrets or personal data in the repo.** `.env` and `config/` are git-ignored; examples use `192.168.1.x` addresses and made-up hostnames. KSeF tokens, real NIPs and invoice contents never go in fixtures, docs or commits. Tokens never go in logs. Runtime output on the user's own machine may show invoice numbers and counterparty names, since that is what the user needs to see.
- **Style:** TypeScript strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; ESM with `.js` import suffixes; zod for env parsing; no new runtime dependencies without a reason.
- **KSeF environments.** Develop against `KSEF_ENV=test` with random NIPs and fictitious data. Never run seed or write operations against `prod` or `demo`.
- The API contract is the official `open-api.json` in [CIRFMF/ksef-docs](https://github.com/CIRFMF/ksef-docs); check request/response shapes there, not from memory.
- **mDNS answers are untrusted input.** Any device on the LAN can announce a printer. Host names and addresses must be plain host names and IPv4 addresses, TXT values have control characters stripped, `rp` must be a plain path, and `toEnv` refuses any value with a control character, because a newline would add variables such as `NODE_OPTIONS` to `printer.env`.
- **ntfy commands are untrusted input.** Only exact matches of the known commands run; never pass message text to a shell or into paths. Replies and summaries always carry a title, which is how the listener skips its own messages on a shared topic.
- Exit codes: `0` ok, `1` some printing failed or the run stopped part way, `2` configuration error.
- The KOD I QR code uses `invoiceHash` from KSeF metadata. Keep invoice XML as raw bytes (never `res.text()`), because decoding drops a BOM and changes the hash.
