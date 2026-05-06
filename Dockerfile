# BUILD
FROM node:24-alpine as builder

WORKDIR /opt/src

RUN apk add --no-cache bash git python3 perl alpine-sdk

COPY . .

RUN npm ci && \
    npm run build


# RUN
FROM node:24-alpine

COPY --from=builder /opt/src/node_modules /opt/app/node_modules
COPY --from=builder /opt/src/dist /opt/app/dist
COPY config.json /opt/app/config.json
COPY package.json /opt/app/package.json

WORKDIR /opt/app

CMD ["dist/App.js"]
