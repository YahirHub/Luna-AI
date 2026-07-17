# ─── Build stage: compilar a binario standalone ───────────────────
FROM oven/bun:1.3.14-alpine AS build

WORKDIR /app

# Instalar dependencias
COPY package.json ./
RUN bun install --production

# Copiar y compilar código fuente
COPY src ./src
RUN bun build ./src/index.ts --compile --bytecode --outfile /tmp/bot

# ─── Runtime stage: solo el binario + runtime libs ───────────────
FROM alpine:3.22

# Instalar bash (entrypoint), su-exec (drop privileges) y libs runtime
RUN apk add --no-cache bash su-exec libgcc libstdc++

# Crear usuario no-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copiar binario compilado desde build stage
COPY --from=build /tmp/bot /data/bot

# Copiar entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Directorio de trabajo para datos persistentes (/data/persistent/)
WORKDIR /data

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/data/bot", "--qr"]
