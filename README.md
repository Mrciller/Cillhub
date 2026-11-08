# Cillhub

Cillhub is a self-hostable chat for communities and teams: servers with text, voice, stage, forum and announcement channels, voice and video calls with screen sharing, roles and permissions, moderation, threads, polls, events, custom emoji, webhooks and bots. It speaks a v9-style REST/gateway API (`/api/v9`, `/gateway`), so existing tooling and bot libraries written for that API work against it.

Anyone can run a Cillhub server (a **node**) on their own machine. A node runs standalone, or it links to the Cillhub network hub at https://cillhub.cillerian.org, so hub users can sign in with their hub account, find the node's public servers in the directory and get notifications from it.

![Cillhub in the browser](docs/screenshots/desktop.png)

<img src="docs/screenshots/phone.png" alt="Cillhub on a phone" width="260">

- **Clients**: Web app (React 19 + TypeScript), Native Desktop app (Rust + WebView2/WebKitGTK), Electron desktop app (Windows & Linux), and Native Android app (Kotlin + Jetpack Compose).
- **Voice & Video**: Voice, video and screen share through [LiveKit](https://livekit.io) or cillvoice, the built-in SFU written in plain Node.js (DTLS, SRTP, simulcast, congestion control; no external WebRTC library).
- **Extensible Modules**: Instance admins can install sandboxed JavaScript modules (commands, events, settings pages, panels in the app, webhook endpoints), each sandboxed with strictly scoped permissions.
- **Lightweight Architecture**: Single Node.js process and one SQLite database file per instance; backups are a simple file copy.
- **Multilingual**: English and German UI.

---

## Run your own server (Node)

You need a Linux machine with Docker (Compose v2), a hostname pointing at it, ports 80/443 and one UDP port for voice.

```sh
curl -fsSLO https://cillhub.cillerian.org/download/server/install.sh
sh install.sh            # asks for hostname, mode, voice backend, UDP port; --help lists all flags
```

The installer verifies every download against the Cillhub release key (signed by Pascal Oraze), starts the stack (server, updater, optional Caddy with Let's Encrypt and optional LiveKit) in `/opt/cillhub` and prints the address of the first-run wizard. There you create the admin account (2FA required), choose standalone or connected mode and automatic updates.

---

## Development Quickstart

Requirements: Node.js 24, npm. Optional: a LiveKit server for voice (or use cillvoice), the Android SDK for the Android app, Rust for the native desktop client.

```sh
# server on a fresh temp data dir (voice is off without LiveKit or cillvoice settings)
cd server && npm ci && PORT=3300 DATA_DIR=$(mktemp -d) node src/index.js

# web client dev server against it
cd client && npm ci && VITE_API_BASE=http://localhost:3300 npm run dev

# production-like: build the client and let the server serve it
cd client && npm run build && cd ../server && PORT=3300 DATA_DIR=$(mktemp -d) STATIC_DIR=../client/dist node src/index.js
```

### Voice configuration
- **Built-in SFU (cillvoice)**: Add `VOICE_BACKEND=cillvoice CILLVOICE_UDP_PORT=50270 CILLVOICE_PUBLIC_IP=127.0.0.1`.
- **LiveKit**: Add `LIVEKIT_URL=http://127.0.0.1:7880 LIVEKIT_PUBLIC_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=…` (keep the keys in a local `.env`, which git ignores).

The `Dockerfile` builds the client and runs the server serving it (data in `/data`).

---

## Configuration Reference

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP + WebSocket port (`0` = ephemeral) |
| `DATA_DIR` | `./data` | Directory for SQLite database, file uploads, media proxy cache, and security keys |
| `STATIC_DIR` | unset | Directory to serve static web client assets from |
| `LIVEKIT_URL` | unset | LiveKit HTTP API URL (e.g. `http://127.0.0.1:7880`) |
| `LIVEKIT_PUBLIC_URL` | unset | LiveKit WebSocket URL clients connect to (e.g. `ws://host/livekit`) |
| `LIVEKIT_API_KEY` | unset | LiveKit API key |
| `LIVEKIT_API_SECRET` | unset | LiveKit API secret |
| `VOICE_BACKEND` | `livekit` | Set to `cillvoice` to use the built-in media server |
| `CILLVOICE_UDP_PORT` | unset | UDP port for media traffic (ICE, DTLS, SRTP) |
| `CILLVOICE_PUBLIC_IP` | unset | Public IPv4 address for clients to send media to |
| `CILLCORD_HUB_URL` | unset | Origin of the network hub (`https://cillhub.cillerian.org`) for linked mode |
| `CILLCORD_PUBLIC_URL` | request origin | Public HTTPS origin of this node |
| `CILLCORD_SETUP_CODE` | unset | Setup code for first-run admin wizard (generated automatically by `install.sh`) |

---

## Tests

```sh
# Server tests
cd server && npm test

# Web Client build & typecheck
cd client && npx tsc -b && npm run build

# Native Rust Desktop tests
cd desktop-rust && cargo test

# Electron Desktop tests
cd desktop && npm test

# Android Unit tests
cd android && ./gradlew testDebugUnitTest
```

---

## Project Layout

| Path | What |
|---|---|
| `server/` | Node 24, ES modules, plain JavaScript, `node:http`, `node:sqlite`, `ws`. REST, gateway, CDN, voice (LiveKit or cillvoice), hub/node federation, migrations, and test suites. |
| `client/` | Vite + React 19 + TypeScript, plain CSS, `livekit-client`. |
| `desktop-rust/` | Native Rust desktop client (Tauri 2, DSP audio engine, game tracking, lightweight memory footprint). |
| `desktop/` | Electron desktop client bundling the web application. |
| `android/` | Native Android app (Kotlin, Jetpack Compose): chat, servers, DMs, notifications, Android Auto, calls, self-update. |
| `selfhost/` | Node deployment package: `install.sh`, compose file, Caddyfile, updater sidecar, release tooling. |
| `scripts/` | End-to-end integration test suites and measurements. |
| `examples/modules/` | Example JavaScript modules (welcome roles, twitch sync, scrim boards, chess, etc.). |

---

## License

Copyright (C) 2026 Pascal Oraze

Cillhub is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, version 3 (AGPL-3.0-only). It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

If you run a modified version as a network service, the AGPL requires you to offer its source code to its users.
