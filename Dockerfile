# The public sandbox (/try) as a container, for the judges' website. See docs/deploy.md.
#
#   docker build -t auren-sandbox .            (or: make sandbox-image)
#   docker run --rm -p 8080:8080 auren-sandbox  (replays without a key)
#
# The image holds only what sandbox mode reads at runtime: Core's source and production
# dependencies, the /try page, the brand assets and the eval cases and scripts it replays.
# No key is ever baked in: .dockerignore admits only those paths, and MODEL_API_KEY is
# passed at run time by the platform (or not at all, and every command replays).
# Paths mirror the repo, because Core finds the page and the cases relative to its source.

ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS deps
WORKDIR /app/core
COPY core/package.json core/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    AUREN_SANDBOX=true \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
# Owned by root and read-only to the app user: the sandbox writes nothing to disk.
COPY --from=deps /app/core/node_modules core/node_modules
COPY core/package.json core/package.json
COPY core/src core/src
COPY apps/web/try.html apps/web/try.html
COPY brand/tokens.css brand/mark.svg brand/
COPY eval/cases eval/cases
COPY eval/scripts eval/scripts
# core/src/index.ts imports the router statically, and its prompt is read when that module loads.
COPY router/auren_router/system_prompt.txt router/auren_router/system_prompt.txt

USER node
WORKDIR /app/core
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Node runs the TypeScript directly (erasable syntax) and handles SIGTERM itself.
CMD ["node", "src/index.ts"]
