#!/bin/sh
# The server runs as "node" (uid 1000). Started as root (older compose files), it first hands /data to node, once;
# any other command (the updater sidecar needs the Docker socket) runs as given.
set -e
if [ "$(id -u)" = 0 ] && [ "$*" = "node src/index.js" ]; then
  [ "$(stat -c %u /data)" = 1000 ] || chown -R node:node /data
  exec su-exec node "$@"
fi
exec "$@"
