FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app

# Manifests before sources, so the install layer survives source edits.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/view/package.json packages/view/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/engine/package.json packages/engine/package.json
RUN pnpm install --filter @walter-sql/engine... --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages
RUN pnpm --filter @walter-sql/engine... build
RUN pnpm --filter @walter-sql/engine deploy --legacy --prod /out

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source=https://github.com/walter-sql/walter
ENV NODE_ENV=production
# Published ports dial the container's interface, not its loopback.
ENV WALTER_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 5544
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --start-interval=1s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WALTER_PORT||5544)+'/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/bin/walter.js"]
