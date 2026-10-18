# syntax=docker/dockerfile:1
# La imagen de AgentSales (spec F8 §4.7, T10): una sola para la API y el worker (D7), Node 26 sobre
# Debian 13 (trixie). Lleva las apps compiladas sin tests, el panel compilado, ffmpeg estático
# fijado por sha256 (el mismo de la CI), Chromium de Playwright y `pg_dump` 18 de PGDG. Nunca
# secretos ni datos reales (`.dockerignore`): los secretos llegan como variables al arrancar.
# Notas verificadas: docs/integraciones/hosting.md §14.5.

# La etiqueta y el digest (índice multi-arquitectura) se suben juntos.
ARG NODE_IMAGE=node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4

# ── Build: instala todo, compila sin tests y deja solo las dependencias de producción ──────────
FROM ${NODE_IMAGE} AS build
# Corepack ya no viene con Node 25+: pnpm, la versión de `packageManager`.
RUN npm install --global pnpm@11.24.0
WORKDIR /app
# Primero el lockfile: la descarga queda en caché mientras no cambien las dependencias.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --frozen-lockfile --offline
# `tsconfig.build.json` compila solo `src` sin tests ni `testing` (deuda de F1); el panel con Vite.
RUN pnpm build
# Que ningún test ni doble de prueba llegue a la imagen (spec T10).
RUN found="$(find apps packages -path '*/node_modules' -prune -o -path '*/dist/*' \( -name '*.test.*' -o -path '*/testing/*' \) -print)" \
 && if [ -n "$found" ]; then echo "archivos de prueba en dist:"; echo "$found"; exit 1; fi \
 && test -f apps/web/dist/index.html
# Sin devDependencies (TypeScript, Vitest, Biome…): no hacen falta para correr. `CI=true`: sin una
# terminal, pnpm no pide confirmar que rehace `node_modules`.
RUN CI=true pnpm install --frozen-lockfile --offline --prod

# ── Runtime ─────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

# ffmpeg 8.1 o más nuevo (spec F2, D6): el build estático GPL de BtbN, el mismo de la CI.
ARG FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n9.0.1-11-ge47273f4d9-linux64-gpl-9.0.tar.xz
ARG FFMPEG_SHA256=182c1b509720e939bb47bfb47dc29cc0c298640401128e3dce8627d10707eb5a
# La clave del repositorio PGDG (huella B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8), fijada por sha256.
ARG PGDG_KEY_SHA256=0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && curl -fsSL --retry 3 -o /tmp/ffmpeg.tar.xz "$FFMPEG_URL" \
 && echo "$FFMPEG_SHA256  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/ffmpeg \
 && tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1 \
 && ln -s /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg \
 && ln -s /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe \
 && rm /tmp/ffmpeg.tar.xz \
 && ffmpeg -hide_banner -version | head -1 \
 # pg_dump 18 de PGDG: Debian trae el 17, y pg_dump no vuelca un servidor más nuevo (Neon es 18).
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL --retry 3 -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "$PGDG_KEY_SHA256  /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc" | sha256sum -c - \
 && . /etc/os-release \
 && printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: %s-pgdg\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n' \
      "$VERSION_CODENAME" > /etc/apt/sources.list.d/pgdg.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && /usr/lib/postgresql/18/bin/pg_dump --version | grep -q 'pg_dump (PostgreSQL) 18\.' \
 && apt-get purge -y --auto-remove xz-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=node:node /app /app

# Chromium de Playwright (el del lockfile) con sus librerías del sistema, como root, en una carpeta
# fija que el proceso (sin root) lee.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN packages/media/node_modules/.bin/playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/*

# Los temporales del worker (`tmp/`, cargas y contenido) y su carpeta de respaldo local.
RUN install -d -o node -g node /app/tmp /home/node/.agentsales

ENV NODE_ENV=production \
    PG_BIN_DIR=/usr/lib/postgresql/18/bin \
    API_HOST=0.0.0.0 \
    API_PORT=8080

USER node
EXPOSE 8080
# La API por defecto; el worker y la migración los elige el proveedor (`fly.toml`, `[processes]`).
CMD ["node", "apps/api/dist/src/server.js"]
