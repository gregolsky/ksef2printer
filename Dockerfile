FROM node:22-trixie-slim AS build

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build

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

WORKDIR /data
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
