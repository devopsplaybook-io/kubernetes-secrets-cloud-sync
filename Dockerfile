# BUILD
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS builder

WORKDIR /opt/src

RUN apk add --no-cache bash git python3 perl alpine-sdk

COPY . .

RUN npm ci && \
    npm run build


# PRODUCTION DEPENDENCIES
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS prod-deps

WORKDIR /opt/app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev


# RESTIC
# Static binary from the official image; the version and digest are pinned
# instead of installing a floating apk package.
FROM restic/restic:0.20.0@sha256:93999df80d4ac6cb148e82d2ef1fe6a81996f17ff535e772723538211b31555a AS restic


# RUN
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

COPY --from=restic /usr/bin/restic /usr/local/bin/restic

WORKDIR /opt/app

COPY --chown=node:node --from=prod-deps /opt/app/node_modules ./node_modules
COPY --chown=node:node --from=builder /opt/src/dist ./dist
COPY --chown=node:node config.json ./config.json
COPY --chown=node:node package.json ./package.json

RUN chown node:node /opt/app

USER node

EXPOSE 8080

# Shell form so the port can be read from the environment. Job mode has no
# listener and exits right away, so the check is skipped there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD if [ "${JOB_MODE}" = "true" ] || [ "${JOB_MODE}" = "1" ]; then exit 0; fi; wget -q -O /dev/null "http://127.0.0.1:${API_PORT:-8080}/api/status" || exit 1

CMD ["node", "dist/App.js"]
