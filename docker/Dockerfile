# Collector + analysis CLI. No npm dependencies: Node's built-in node:sqlite is used.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY packages/schema packages/schema
COPY packages/collector packages/collector
COPY packages/analysis-cli packages/analysis-cli
ENV FFR_HOST=0.0.0.0 FFR_PORT=4318 FFR_DB=/data/ffr.db NODE_OPTIONS=--disable-warning=ExperimentalWarning
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4318/healthz >/dev/null || exit 1
CMD ["node", "packages/collector/server.mjs"]
