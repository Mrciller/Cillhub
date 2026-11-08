# Build the web client, then run the server which also serves client/dist.
FROM node:24-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
COPY CHANGELOG.md /app/CHANGELOG.md
RUN npm run build

FROM node:24-alpine
# git: v8 module installs from Git sources (server/src/modules/package.js)
RUN apk add --no-cache git
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY examples/ /app/examples/
COPY --from=client /app/client/dist /app/client/dist
ENV PORT=3000 DATA_DIR=/data STATIC_DIR=/app/client/dist NODE_ENV=production CILLCORD_VERSION=7.7.0
VOLUME /data
EXPOSE 3000
CMD ["node", "src/index.js"]
