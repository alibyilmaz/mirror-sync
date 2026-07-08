FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# npm install, not npm ci: the lockfile is generated on Windows and npm
# pins some cross-platform optional deps (eslint's unrs-resolver wasm
# binding -> @emnapi) to versions the Linux builder rejects under the strict
# `npm ci` sync check. `npm install` re-resolves correctly for Linux.
RUN npm install --no-audit --no-fund

COPY . .

RUN npm run build && npm prune --omit=dev && npm cache clean --force

RUN chmod +x docker-entrypoint.sh

# Shell entrypoint that ends with `exec node server.mjs`: node gets PID 1
# and receives SIGTERM, so the queue worker drains gracefully on deploys.
CMD ["./docker-entrypoint.sh"]
