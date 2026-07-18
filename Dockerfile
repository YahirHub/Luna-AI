# ─── Build stage: Luna standalone + runtime oficial de whisper.cpp ──
FROM oven/bun:1.3.14 AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --production --frozen-lockfile

COPY scripts ./scripts
COPY assets ./assets
COPY src ./src
RUN bun run build

# ─── Runtime glibc: compatible con los binarios oficiales Ubuntu ─────
FROM debian:trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        gosu \
        libgomp1 \
        libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system appgroup \
    && useradd --system --gid appgroup --home-dir /data --shell /usr/sbin/nologin appuser

COPY --from=build /app/dist/luna-ai /data/bot
COPY --from=build /app/dist/runtime /data/runtime
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /data/bot \
    && chmod -R a+rX /data/runtime \
    && find /data/runtime/whisper -type f -name whisper-cli -exec chmod +x {} +

WORKDIR /data
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/data/bot", "--qr"]
