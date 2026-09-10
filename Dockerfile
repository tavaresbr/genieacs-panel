FROM node:22-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --include=dev
COPY frontend/ ./
RUN npm run build

# The backend's dependencies are installed in a stage of their own because
# `better-sqlite3` ships no prebuilt binary for Alpine's musl libc and has to
# be compiled, and the compiler belongs in a stage the runtime image never
# carries: python, make and g++ are a build-time need, not a thing to ship.
FROM node:22-alpine AS backend-deps

RUN apk add --no-cache python3 make g++
WORKDIR /app/backend
COPY backend/package*.json ./
# O `postinstall` do backend roda `scripts/install-cli.js`, que instala a CLI
# `skygenpanel` num install de produção e se recusa educadamente em qualquer
# outro lugar — inclusive aqui. Ele precisa EXISTIR para poder se recusar: sem
# esta linha o npm morre com "Cannot find module" antes de o script decidir
# nada. Só o diretório de scripts, e antes do install, para a camada de
# dependências continuar valendo por hash de package-lock.
COPY backend/scripts ./scripts
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime

ENV APP_ENV=production \
    APP_HOST=0.0.0.0 \
    APP_PORT=5890 \
    PORTAL_PORT=5891 \
    DATA_DIR=/var/lib/skygenpanel

WORKDIR /app/backend
COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY backend/ ./
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

RUN mkdir -p /var/lib/skygenpanel && chown -R node:node /var/lib/skygenpanel

USER node
EXPOSE 5890 5891
VOLUME ["/var/lib/skygenpanel"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5890/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
