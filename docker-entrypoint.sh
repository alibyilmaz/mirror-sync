#!/bin/sh
set -e
# Migrations at boot (idempotent), then exec node so it becomes PID 1 and
# receives SIGTERM directly — npm would swallow it and break the graceful
# worker drain in server.mjs.
npx prisma migrate deploy
exec node server.mjs
