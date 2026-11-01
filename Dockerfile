# BUILD
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS builder

WORKDIR /opt/src

RUN apk add --no-cache bash git python3 perl alpine-sdk

COPY . .

RUN npm ci && \
    npm run build


# PRODUCTION DEPENDENCIES
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS prod-deps

WORKDIR /opt/app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev


# RESTIC
# Static binary from the official image; the version and digest are pinned
# instead of installing a floating apk package.
FROM restic/restic:0.18.1@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76 AS restic


# RUN
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94

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
