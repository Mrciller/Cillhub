#!/bin/sh
# Cillhub server installer (self-hosted node). POSIX sh; safe to run again (it keeps .env and data).
#
#   Check this script before running it (README.md): its SHA256SUMS must carry a valid signature by the release key
#   published in the source repository (selfhost/release-public-key.pem), then: sh install.sh
#
# What it does, in order:
#   1. checks Docker, Docker Compose, curl, openssl 3 and sha256sum
#   2. downloads SHA256SUMS + SHA256SUMS.sig and latest.json + .sig (https only) from the hub and verifies the Ed25519
#      signatures with the public key below; latest.json must not be expired and must name the same version.
#      Then verifies every downloaded file against SHA256SUMS
#   3. only then `docker load`s the server image (skipped if this install already has one)
#   4. writes <dir>/docker-compose.yml, Caddyfile, updater.mjs and, on the first run only, .env with
#      generated secrets (asks for hostname, mode, voice backend, UDP port unless given as flags)
#   5. starts the stack, waits until it answers, prints the setup URL, the setup code and the ports
#      to open. It never touches your firewall.
#
# Flags (all optional; with --yes nothing is asked and --hostname is required):
#   --hostname NAME        public DNS name of this server (e.g. chat.example.org)
#   --mode MODE            standalone (default) or connected (link to the hub later in the setup wizard)
#   --voice BACKEND        cillvoice (default, built in) or livekit (adds a LiveKit container)
#   --udp-port N           UDP port for cillvoice media (default 50250)
#   --public-ip IP         public IPv4 for voice (default: detected from the default route)
#   --no-caddy             no bundled Caddy/HTTPS; you run your own reverse proxy (an nginx example is printed)
#   --http-port N          loopback port the app listens on for the reverse proxy (default 3000)
#   --dir DIR              install directory (default /opt/cillhub)
#   --project NAME         docker compose project name (default cillcord-node)
#   --hub URL              network hub to download from and link to (default https://cillhub.cillerian.org)
#   --auto-update [MODE]   automatic updates from the hub's signed releases: patch (patch and security releases, the
#                          default when MODE is left out), all, or off (default without the flag). Changeable later in
#                          the setup wizard and on the admin Updates page
#   --update-hour H        hour of day (0-23, UTC) in which automatic updates run (default 4)
#   --yes, -y              non-interactive
set -eu

# Release signing key (make-release.sh rewrites these three lines).
RELEASE_PUBKEY='MCowBQYDK2VwAyEAWIwyMJ/ZwpoIVzpQUXOHihDsavz1V5fF8ZhCA2vbBl0='
RELEASE_FPR='b6b5344a3111599a11303ebf2f004f46397a5aa4d8256c3155ab3d3929755d65'
RELEASE_SIGNER='Pascal Oraze'

HUB=https://cillhub.cillerian.org   # the default Cillhub network hub
DIR=/opt/cillhub
PROJECT=cillcord-node
HOSTNAME_=''
MODE=''
VOICE=''
UDP_PORT=''
PUBLIC_IP=''
CADDY=''
HTTP_PORT=3000
AUTO_UPDATE=off
UPDATE_HOUR=4
YES=0

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case $1 in
    --hostname) HOSTNAME_=${2:?}; shift ;;
    --mode) MODE=${2:?}; shift ;;
    --voice) VOICE=${2:?}; shift ;;
    --udp-port) UDP_PORT=${2:?}; shift ;;
    --public-ip) PUBLIC_IP=${2:?}; shift ;;
    --no-caddy) CADDY=no ;;
    --http-port) HTTP_PORT=${2:?}; shift ;;
    --dir) DIR=${2:?}; shift ;;
    --project) PROJECT=${2:?}; shift ;;
    --hub) HUB=${2%/}; shift ;;
    --auto-update) case ${2:-} in off|patch|all) AUTO_UPDATE=$2; shift ;; *) AUTO_UPDATE=patch ;; esac ;;
    --auto-update=*) AUTO_UPDATE=${1#--auto-update=} ;;
    --update-hour) UPDATE_HOUR=${2:?}; shift ;;
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,/^set -eu/p' "$0" | sed 's/^# \{0,1\}//;$d'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

# ask VAR "question" default: keeps a value given by flag, else asks on the terminal (also when piped).
ask() {
  eval "cur=\${$1}"
  if [ -n "$cur" ]; then return; fi
  if [ "$YES" = 1 ] || [ ! -r /dev/tty ]; then
    [ -n "$3" ] || die "$2: no value (give it as a flag)"
    eval "$1=\$3"; return
  fi
  printf '%s [%s]: ' "$2" "$3" > /dev/tty
  read -r ans < /dev/tty || ans=''
  eval "$1=\${ans:-\$3}"
}
is_port() { case $1 in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
# PUBLIC_IP is written into .env with an unquoted heredoc, so it must be a plain address (or empty). Nothing else may expand.
is_ipv4() { printf '%s\n' "$1" | grep -Eq '^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$'; }
if [ -n "$PUBLIC_IP" ]; then is_ipv4 "$PUBLIC_IP" || die "bad --public-ip (an IPv4 address, or leave it empty)"; fi

# 1. Prerequisites
command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/engine/install/)"
docker info >/dev/null 2>&1 || die "cannot talk to Docker (run as root or as a member of the docker group)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (package docker-compose-plugin)"
command -v curl >/dev/null || die "curl is missing"
command -v sha256sum >/dev/null || die "sha256sum is missing (coreutils)"
openssl version 2>/dev/null | grep -Eq '^OpenSSL [3-9]' || die "OpenSSL 3 or newer is needed to verify the release signature"
is_port "$HTTP_PORT" || die "bad --http-port"
case $AUTO_UPDATE in off|patch|all) ;; *) die "--auto-update must be off, patch or all" ;; esac
case $UPDATE_HOUR in [0-9]|1[0-9]|2[0-3]) ;; *) die "--update-hour must be 0 to 23" ;; esac
case $PROJECT in *[!a-z0-9_-]*|'') die "bad --project (lowercase letters, digits, - and _)" ;; esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
REL="$HUB/download/server"
# https only; plain http just for a hub on this machine (the self-host tests run one)
case $HUB in https://*) PROTO='=https' ;; http://127.0.0.1:*|http://localhost:*) PROTO='=http' ;; *) die "--hub must be an https:// URL" ;; esac
fetch() { curl -fsSL --proto "$PROTO" --proto-redir "$PROTO" -o "$TMP/$1" "$REL/$1" || die "download of $REL/$1 failed"; }

# 2. Signature first, then checksums. Nothing from the hub is used before both pass.
say "Downloading the release list from $REL"
fetch SHA256SUMS
fetch SHA256SUMS.sig
printf -- '-----BEGIN PUBLIC KEY-----\n%s\n-----END PUBLIC KEY-----\n' "$RELEASE_PUBKEY" > "$TMP/signing-key.pem"
[ "$(openssl pkey -pubin -in "$TMP/signing-key.pem" -outform DER | sha256sum | cut -d' ' -f1)" = "$RELEASE_FPR" ] \
  || die "the public key in this script does not match its fingerprint; get a fresh install.sh"
openssl pkeyutl -verify -rawin -pubin -inkey "$TMP/signing-key.pem" -in "$TMP/SHA256SUMS" -sigfile "$TMP/SHA256SUMS.sig" >/dev/null 2>&1 \
  || die "SIGNATURE CHECK FAILED for SHA256SUMS: the download is not from the Cillhub release key. Nothing was installed."
# latest.json carries the expiry: an old SHA256SUMS replayed by the hub does not match a fresh, unexpired latest.json
fetch latest.json
fetch latest.json.sig
openssl pkeyutl -verify -rawin -pubin -inkey "$TMP/signing-key.pem" -in "$TMP/latest.json" -sigfile "$TMP/latest.json.sig" >/dev/null 2>&1 \
  || die "SIGNATURE CHECK FAILED for latest.json: the download is not from the Cillhub release key. Nothing was installed."
EXPIRES=$(sed -n 's/^  "expires": \([0-9]*\),\{0,1\}$/\1/p' "$TMP/latest.json")
[ -n "$EXPIRES" ] && [ "$EXPIRES" -gt "$(date +%s)" ] || die "the hub's release feed is expired or has no expiry (an old or replayed release). Nothing was installed."
say "Signature OK: signed by $RELEASE_SIGNER"
say "  key fingerprint (sha256) $RELEASE_FPR"

verify() { # verify FILE: must be listed in the signed SHA256SUMS with this hash
  want=$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }' "$TMP/SHA256SUMS")
  have=$(sha256sum "$TMP/$1" | cut -d' ' -f1)
  [ -n "$want" ] && [ "$want" = "$have" ] || die "CHECKSUM MISMATCH for $1. Nothing was installed."
}
TARBALL=$(awk '{ sub(/^\*/, "", $2); print $2 }' "$TMP/SHA256SUMS" | grep -E '^cillhub-server-[0-9A-Za-z.-]+\.tar\.gz$' | head -n 1)
[ -n "$TARBALL" ] || die "no server image listed in SHA256SUMS"
VERSION=${TARBALL#cillhub-server-}
VERSION=${VERSION%.tar.gz}
grep -qxF "  \"version\": \"$VERSION\"," "$TMP/latest.json" \
  || die "SHA256SUMS ($VERSION) and latest.json name different releases; the hub may be publishing right now, try again in a minute"
for f in docker-compose.yml Caddyfile updater.mjs release-public-key.pem; do fetch "$f"; verify "$f"; done

# 3. Image. An existing install keeps its image; updates go through the admin dashboard.
envget() { [ -f "$DIR/.env" ] && sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1; }
IMAGE=$(envget CILLCORD_IMAGE || true)
if [ -n "$IMAGE" ] && docker image inspect "$IMAGE:current" >/dev/null 2>&1; then
  say "Existing install found in $DIR ($IMAGE:current); keeping its image. Update from the admin dashboard."
else
  say "Downloading Cillhub server $VERSION"
  fetch "$TARBALL"
  verify "$TARBALL"
  say "Checksum OK. Loading the image"
  LOADED=$(docker load -i "$TMP/$TARBALL" | sed -n 's/^Loaded image: //p' | head -n 1)
  [ -n "$LOADED" ] || die "docker load did not report an image name"
  IMAGE=${LOADED%:*}
  docker tag "$LOADED" "$IMAGE:current"
fi

# 4. Files
mkdir -p "$DIR/data" "$DIR/backups"
chmod 700 "$DIR/backups"
# the app runs as uid 1000 (user: in docker-compose.yml), so data belongs to it and nobody else on the host may read it
docker run --rm -v "$(cd "$DIR/data" && pwd):/data" --entrypoint sh "$IMAGE:current" -c 'chown -R 1000:1000 /data && chmod 700 /data' \
  || die "could not hand $DIR/data to the app user (uid 1000)"
for f in docker-compose.yml Caddyfile updater.mjs release-public-key.pem; do
  cp "$TMP/$f" "$DIR/$f"
  chmod 644 "$DIR/$f"
done

if [ -f "$DIR/.env" ]; then
  say "Keeping the settings and secrets in $DIR/.env"
else
  ask HOSTNAME_ "Public hostname of this server (DNS must point here)" ""
  echo "$HOSTNAME_" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' || die "bad hostname $HOSTNAME_"
  ask MODE "Mode: standalone or connected (to $HUB)" standalone
  case $MODE in standalone|connected) ;; *) die "mode must be standalone or connected" ;; esac
  ask VOICE "Voice backend: cillvoice (built in) or livekit" cillvoice
  case $VOICE in cillvoice|livekit) ;; *) die "voice must be cillvoice or livekit" ;; esac
  ask UDP_PORT "UDP port for voice (cillvoice)" 50250
  is_port "$UDP_PORT" || die "bad UDP port"
  detected=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1 || true)
  ask PUBLIC_IP "Public IPv4 address for voice" "${detected:-}"
  if [ -n "$PUBLIC_IP" ]; then is_ipv4 "$PUBLIC_IP" || die "bad public IP (an IPv4 address, or leave it empty)"; fi
  ask CADDY "Bundled Caddy with automatic HTTPS? (yes/no)" yes
  case $CADDY in y|yes) CADDY=yes ;; n|no) CADDY=no ;; *) die "answer yes or no" ;; esac

  profiles=''
  [ "$CADDY" = yes ] && profiles=caddy
  lk_url='' lk_public='' lk_key='' lk_secret=''
  if [ "$VOICE" = livekit ]; then
    profiles=${profiles:+$profiles,}livekit
    lk_url=http://livekit:7880 lk_public=wss://$HOSTNAME_/livekit
    lk_key=API$(openssl rand -hex 6) lk_secret=$(openssl rand -hex 24)
  fi
  umask 077
  cat > "$DIR/.env.tmp" <<EOF
# Cillhub node settings, written by install.sh on $(date -u +%Y-%m-%dT%H:%MZ). Contains secrets: keep it private.
COMPOSE_PROJECT_NAME=$PROJECT
COMPOSE_PROFILES=$profiles
CILLCORD_IMAGE=$IMAGE
CILLCORD_HOSTNAME=$HOSTNAME_
CILLCORD_PUBLIC_URL=https://$HOSTNAME_
CILLCORD_HTTP_PORT=$HTTP_PORT
CILLCORD_MODE=$MODE
CILLCORD_HUB_URL=$HUB
CILLCORD_UPDATE_CHECK=1
CILLCORD_AUTO_UPDATE=$AUTO_UPDATE
CILLCORD_AUTO_UPDATE_HOUR=$UPDATE_HOUR
CILLCORD_SETUP_CODE=$(openssl rand -hex 6)
CILLCORD_UPDATER_URL=http://updater:8787
CILLCORD_UPDATER_SECRET=$(openssl rand -hex 32)
VOICE_BACKEND=$VOICE
CILLVOICE_UDP_PORT=$UDP_PORT
CILLVOICE_PUBLIC_IP=$PUBLIC_IP
LIVEKIT_URL=$lk_url
LIVEKIT_PUBLIC_URL=$lk_public
LIVEKIT_API_KEY=$lk_key
LIVEKIT_API_SECRET=$lk_secret
EOF
  chmod 600 "$DIR/.env.tmp"
  mv "$DIR/.env.tmp" "$DIR/.env"
  umask 022
fi

# 5. Start
say "Starting the stack (project $(envget COMPOSE_PROJECT_NAME))"
(cd "$DIR" && docker compose up -d --remove-orphans) || die "docker compose up failed"
HTTP_PORT=$(envget CILLCORD_HTTP_PORT)
i=0
until curl -fsS -o /dev/null "http://127.0.0.1:$HTTP_PORT/api/v9/gateway"; do
  i=$((i + 1))
  [ $i -lt 90 ] || die "the server did not answer on 127.0.0.1:$HTTP_PORT within 90 s; see: cd $DIR && docker compose logs app"
  sleep 1
done

HOSTNAME_=$(envget CILLCORD_HOSTNAME)
UDP_PORT=$(envget CILLVOICE_UDP_PORT)
PROFILES=$(envget COMPOSE_PROFILES)
say ""
say "Cillhub $VERSION is running in $DIR."
say ""
say "Finish the setup in your browser: https://$HOSTNAME_/setup"
say "Setup code: $(envget CILLCORD_SETUP_CODE)   (also in $DIR/.env as CILLCORD_SETUP_CODE)"
say ""
say "Open these ports in your firewall / router (this script changed nothing there):"
case ",$PROFILES," in *,caddy,*) say "  TCP 80 and 443 (HTTPS and the Let's Encrypt challenge), UDP 443 (optional, HTTP/3)" ;;
  *) say "  the ports of your own reverse proxy (usually TCP 80 and 443)" ;; esac
say "  UDP $UDP_PORT (voice and video, cillvoice)"
case ",$PROFILES," in *,livekit,*) say "  TCP 7881 and UDP 50000-50100 (LiveKit)" ;; esac
case ",$PROFILES," in *,caddy,*) ;; *)
  say ""
  say "No bundled Caddy: point your reverse proxy at 127.0.0.1:$HTTP_PORT. nginx example:"
  cat <<EOF
  server {
      listen 443 ssl http2;
      server_name $HOSTNAME_;
      # ssl_certificate /etc/letsencrypt/live/$HOSTNAME_/fullchain.pem;
      # ssl_certificate_key /etc/letsencrypt/live/$HOSTNAME_/privkey.pem;
      client_max_body_size 260m;
      location /livekit/ {            # only with --voice livekit
          proxy_pass http://127.0.0.1:7880/;
          proxy_http_version 1.1;
          proxy_set_header Upgrade \$http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_read_timeout 86400s;
      }
      location / {
          proxy_pass http://127.0.0.1:$HTTP_PORT;
          proxy_http_version 1.1;
          proxy_set_header Upgrade \$http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_set_header Host \$http_host;
          proxy_set_header X-Real-IP \$remote_addr;
          proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
          proxy_set_header X-Forwarded-Proto \$scheme;
          proxy_read_timeout 3600s;
          proxy_request_buffering off;
      }
  }
EOF
;; esac
