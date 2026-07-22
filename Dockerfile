# ─── Build stage: Luna standalone + runtimes por arquitectura ─────────
FROM oven/bun:1.3.14 AS build

WORKDIR /app

# En Docker el navegador se instala en la imagen runtime mediante el gestor de
# paquetes de la distribución. Evitamos descargar Chrome for Testing en el
# build stage porque no se copiaría a la imagen final y Linux ARM64 no dispone
# de builds oficiales de Chrome for Testing.
ENV LUNA_AGENT_BROWSER_SKIP_INSTALL=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
# El postinstall del proyecto necesita scripts/ y src/. Se omiten lifecycle
# scripts en esta capa para conservar el cache de dependencias y la preparación
# real se ejecuta después mediante bun run build.
RUN bun install --production --ignore-scripts

COPY scripts ./scripts
COPY assets ./assets
COPY src ./src
RUN bun run build

# ─── Runtime glibc multi-arquitectura ──────────────────────────────────
# Bookworm proporciona Chromium, libgomp1 y libstdc++6 para amd64 y arm64.
# whisper.cpp incluye una libgomp portable basada en Bookworm; además dejamos
# libgomp1 del sistema como respaldo, evitando depender de la glibc del build.
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        chromium \
        fonts-liberation \
        gosu \
        libgomp1 \
        libstdc++6 \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system appgroup \
    && useradd --system --gid appgroup --home-dir /data --shell /usr/sbin/nologin appuser

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=build /app/dist/luna-ai /data/bot
COPY --from=build /app/dist/runtime /data/runtime
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /data/bot \
    && chmod -R a+rX /data/runtime \
    && find /data/runtime/whisper -type f -name whisper-cli -exec chmod +x {} + \
    && find /data/runtime/agent-browser -type f -name agent-browser -exec chmod +x {} +

WORKDIR /data
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/data/bot", "--qr"]
