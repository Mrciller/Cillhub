#!/bin/sh
# Builds a signed self-host release from a tested image. Publishing is a separate step (publish-release.sh).
#
#   sh selfhost/scripts/make-release.sh <version> <image>
#   e.g. NOTES_FILE=notes.txt sh selfhost/scripts/make-release.sh 7.0.0 cillcord-cillcord:v7
#
# Output (OUT_DIR, default ./cillhub-release-<version>; published as-is to /download/server/):
#   cillhub-server-<version>.tar.gz   docker save of <image>, retagged <IMAGE_REPO>:<version>, with
#                                      ENV CILLCORD_VERSION (and the legacy version label, see below) added
#   install.sh docker-compose.yml Caddyfile updater.mjs   (install.sh with the signing key baked in)
#   release-public-key.pem             the pinned release keys nodes trust (PUBLIC_KEY)
#   SHA256SUMS + SHA256SUMS.sig        sums of all the above, Ed25519 signature (raw 64 bytes)
#   latest.json + .sig                 {version, url, sha256, size, notes, min_upgrade_from, security, min_version, keys,
#                                       key_id, expires}; key_id and expires are added by sign-release.sh
#
# Env: RELEASE_KEY  private key, may have a passphrase (required unless UNSIGNED=1; see sign-release.sh)
#      UNSIGNED=1   build only; sign later with sign-release.sh (e.g. on an offline machine)
#      PUBLIC_KEY   the pinned key list (one or more PEM public keys); its FIRST key must be the signing key
#                   (default selfhost/release-public-key.pem). Every key in it is trusted by nodes after this release.
#      SIGNER       name shown by install.sh (default "Pascal Oraze")
#      HUB_URL      hub origin used in latest.json's url (default https://cillhub.cillerian.org)
#      IMAGE_REPO   image name inside the tarball (default cillcord-server)
#      NOTES / NOTES_FILE   release notes (text), MIN_UPGRADE_FROM   oldest version that may update to this one
#      SECURITY=1   marks a security release (nodes with automatic updates set to "patch" install it too)
#      MIN_VERSION  nodes refuse any later feed offering less than this (default: this version for SECURITY=1, else none)
set -eu

[ $# -eq 2 ] || { echo "usage: $0 <version> <image>" >&2; exit 2; }
VERSION=$1
IMAGE=$2
SELFHOST=$(cd "$(dirname "$0")/.." && pwd)
UNSIGNED=${UNSIGNED:-0}
[ "$UNSIGNED" = 1 ] || RELEASE_KEY=${RELEASE_KEY:?set RELEASE_KEY to the release private key (or UNSIGNED=1)}
PUBLIC_KEY=${PUBLIC_KEY:-$SELFHOST/release-public-key.pem}
SIGNER=${SIGNER:-Pascal Oraze}
HUB_URL=${HUB_URL:-https://cillhub.cillerian.org}  # the default Cillhub network hub
IMAGE_REPO=${IMAGE_REPO:-cillcord-server}
OUT_DIR=${OUT_DIR:-$PWD/cillhub-release-$VERSION}
MIN_UPGRADE_FROM=${MIN_UPGRADE_FROM:-}
NOTES=${NOTES:-}
SECURITY=${SECURITY:-0}
MIN_VERSION=${MIN_VERSION:-}
[ "$SECURITY" = 1 ] && [ -z "$MIN_VERSION" ] && MIN_VERSION=$VERSION
[ -n "${NOTES_FILE:-}" ] && NOTES=$(cat "$NOTES_FILE")

die() { echo "make-release: $*" >&2; exit 1; }

# The version ends up in file names, image tags and JSON, so keep it plain.
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "version must look like 7.0.0 or 7.0.0-rc.1"
[ -z "$MIN_UPGRADE_FROM" ] || echo "$MIN_UPGRADE_FROM" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "bad MIN_UPGRADE_FROM"
[ -z "$MIN_VERSION" ] || echo "$MIN_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "bad MIN_VERSION"
case $SECURITY in 0|1) ;; *) die "SECURITY must be 0 or 1" ;; esac
case $SIGNER in *"'"*) die "SIGNER must not contain a single quote" ;; esac
[ "$UNSIGNED" = 1 ] || [ -r "$RELEASE_KEY" ] || die "cannot read release key $RELEASE_KEY"
[ -e "$OUT_DIR" ] && die "$OUT_DIR already exists; remove it or pick another version"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE not found"

# install.sh gets the first key of the list; sign-release.sh checks that RELEASE_KEY is that key.
PUB_B64=$(openssl pkey -pubin -in "$PUBLIC_KEY" | grep -v -- '-----' | tr -d '\n')
FPR=$(openssl pkey -pubin -in "$PUBLIC_KEY" -outform DER | sha256sum | cut -d' ' -f1)

mkdir -p "$OUT_DIR"
TARBALL="cillhub-server-$VERSION.tar.gz"
REF="$IMAGE_REPO:$VERSION"

echo "Tagging $IMAGE as $REF (adds CILLCORD_VERSION=$VERSION)"
# The label is legacy: updater.mjs copies on nodes installed before 2026-11-05 read the version only from it (install
# dirs are not refreshed by updates), so it must stay as long as such nodes may exist. Current updaters read the ENV.
printf 'FROM %s\nENV CILLCORD_VERSION=%s\nLABEL org.cillerian.cillcord.version=%s\n' "$IMAGE" "$VERSION" "$VERSION" \
  | docker build -q -t "$REF" - >/dev/null
echo "Saving $REF"
docker save "$REF" | gzip -6 > "$OUT_DIR/$TARBALL"
docker rmi "$REF" >/dev/null

# install.sh carries the public key; rewrite the three marked lines.
awk -v pub="$PUB_B64" -v fpr="$FPR" -v signer="$SIGNER" '
  /^RELEASE_PUBKEY=/ { print "RELEASE_PUBKEY='\''" pub "'\''"; next }
  /^RELEASE_FPR=/    { print "RELEASE_FPR='\''" fpr "'\''"; next }
  /^RELEASE_SIGNER=/ { print "RELEASE_SIGNER='\''" signer "'\''"; next }
  { print }' "$SELFHOST/install.sh" > "$OUT_DIR/install.sh"
[ "$(grep -c "^RELEASE_PUBKEY='$PUB_B64'\$" "$OUT_DIR/install.sh")" = 1 ] || die "could not bake the key into install.sh"
cp "$SELFHOST/docker-compose.yml" "$SELFHOST/Caddyfile" "$SELFHOST/updater.mjs" "$OUT_DIR/"
cp "$PUBLIC_KEY" "$OUT_DIR/release-public-key.pem"
chmod 644 "$OUT_DIR"/*

(cd "$OUT_DIR" && sha256sum "$TARBALL" install.sh docker-compose.yml Caddyfile updater.mjs release-public-key.pem > SHA256SUMS)

SHA=$(sha256sum "$OUT_DIR/$TARBALL" | cut -d' ' -f1)
SIZE=$(wc -c < "$OUT_DIR/$TARBALL" | tr -d ' ')
VERSION="$VERSION" URL="$HUB_URL/download/server/$TARBALL" SHA="$SHA" SIZE="$SIZE" NOTES="$NOTES" MIN="$MIN_UPGRADE_FROM" SEC="$SECURITY" MINV="$MIN_VERSION" KEYS="$PUBLIC_KEY" \
  node -e '
    const e = process.env, keys = require("fs").readFileSync(e.KEYS, "utf8").match(/-----BEGIN PUBLIC KEY-----[^-]+-----END PUBLIC KEY-----\n?/g);
    process.stdout.write(JSON.stringify({ version: e.VERSION, url: e.URL, sha256: e.SHA, size: Number(e.SIZE),
      notes: e.NOTES, min_upgrade_from: e.MIN || null, security: e.SEC === "1", min_version: e.MINV || null,
      keys: keys.map(k => k.trim() + "\n") }, null, 2) + "\n");
  ' > "$OUT_DIR/latest.json"

if [ "$UNSIGNED" = 1 ]; then
  echo "Release $VERSION built UNSIGNED in $OUT_DIR. Sign it with: sh selfhost/scripts/sign-release.sh $OUT_DIR"
else
  RELEASE_KEY="$RELEASE_KEY" PUBLIC_KEY="$PUBLIC_KEY" sh "$SELFHOST/scripts/sign-release.sh" "$OUT_DIR" \
    || { rm -rf "$OUT_DIR"; die "signing failed; nothing was kept"; }
  echo "Release $VERSION in $OUT_DIR (signed by $SIGNER, key sha256 $FPR)"
fi
ls -l "$OUT_DIR"
