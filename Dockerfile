FROM node:22-trixie-slim AS build

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build

# ──────────────────────────────────────────────
# Invoice PDF rendering: CIRFMF/ksef-pdf-generator (MIT), the Ministry of Finance's visualisation
# library, built from a pinned commit.
FROM node:22-trixie-slim AS pdf-renderer

ARG KSEF_PDF_GENERATOR_COMMIT=8a18843db12d0013a417500bb2f98bfe49b7d2a8
ADD https://github.com/CIRFMF/ksef-pdf-generator/archive/${KSEF_PDF_GENERATOR_COMMIT}.tar.gz /tmp/src.tar.gz
WORKDIR /src
RUN tar xzf /tmp/src.tar.gz --strip-components=1 \
 && npm ci --ignore-scripts --no-audit --no-fund \
 && npx vite build --mode production

# ──────────────────────────────────────────────
FROM node:22-trixie-slim AS runtime

# Extra Debian printer driver packages for printers that are not driverless,
# e.g. "hplip printer-driver-foo2zjs printer-driver-splix".
ARG EXTRA_DRIVER_PACKAGES=""

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      cups cups-client cups-ipp-utils cups-filters \
      printer-driver-brlaser printer-driver-gutenprint \
      ${EXTRA_DRIVER_PACKAGES} \
 && rm -rf /var/lib/apt/lists/*

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/job-state.test /app/job-state.test
COPY --from=build /build/dist/cli.js /app/cli.js
COPY --from=pdf-renderer /src/dist/ksef-fe-invoice-converter.js /app/vendor/ksef-pdf.js
COPY --from=pdf-renderer /src/LICENSE /app/vendor/ksef-pdf.LICENSE

WORKDIR /data
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
