FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY docs/package.json docs/package.json
RUN pnpm install --filter docs --frozen-lockfile

COPY docs ./docs
RUN pnpm --filter docs build

FROM nginx:stable-alpine
COPY <<EOF /etc/nginx/conf.d/default.conf
server {
  listen 80;
  root /usr/share/nginx/html;
  error_page 404 /404.html;
  absolute_redirect off;
  gzip on;
  gzip_types text/css text/plain text/javascript application/javascript application/json image/svg+xml;
}
EOF
COPY --from=build /app/docs/dist /usr/share/nginx/html
