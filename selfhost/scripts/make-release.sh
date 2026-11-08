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
#   SHA256SUMS + SHA256SUMS.sig        sums of all the above, Ed25519 signature (raw 64 bytes)
#   latest.json + .sig                 {version, url, sha256, size, notes, min_upgrade_from, security}
#
# Env: RELEASE_KEY  private key (required)
#      PUBLIC_KEY   must match RELEASE_KEY (default selfhost/release-public-key.pem)
#      SIGNER       name shown by install.sh (default "Pascal Oraze")
#      HUB_URL      hub origin used in latest.json's url (default https://cillhub.cillerian.org)
#      IMAGE_REPO   image name inside the tarball (default cillcord-server)
#      NOTES / NOTES_FILE   release notes (text), MIN_UPGRADE_FROM   oldest version that may update to this one
#      SECURITY=1   marks a security release (nodes with automatic updates set to "patch" install it too)
set -eu

[ $# -eq 2 ] || { echo "usage: $0 <version> <image>" >&2; exit 2; }
VERSION=$1
IMAGE=$2
SELFHOST=$(cd "$(dirname "$0")/.." && pwd)
RELEASE_KEY=${RELEASE_KEY:?set RELEASE_KEY to the release private key}
PUBLIC_KEY=${PUBLIC_KEY:-$SELFHOST/release-public-key.pem}
SIGNER=${SIGNER:-Pascal Oraze}
HUB_URL=${HUB_URL:-https://cillhub.cillerian.org}  # the default Cillhub network hub
IMAGE_REPO=${IMAGE_REPO:-cillcord-server}
OUT_DIR=${OUT_DIR:-$PWD/cillhub-release-$VERSION}
MIN_UPGRADE_FROM=${MIN_UPGRADE_FROM:-}
NOTES=${NOTES:-}
SECURITY=${SECURITY:-0}
[ -n "${NOTES_FILE:-}" ] && NOTES=$(cat "$NOTES_FILE")

die() { echo "make-release: $*" >&2; exit 1; }

# The version ends up in file names, image tags and JSON, so keep it plain.
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "version must look like 7.0.0 or 7.0.0-rc.1"
[ -z "$MIN_UPGRADE_FROM" ] || echo "$MIN_UPGRADE_FROM" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "bad MIN_UPGRADE_FROM"
case $SECURITY in 0|1) ;; *) die "SECURITY must be 0 or 1" ;; esac
case $SIGNER in *"'"*) die "SIGNER must not contain a single quote" ;; esac
[ -r "$RELEASE_KEY" ] || die "cannot read release key $RELEASE_KEY"
[ -e "$OUT_DIR" ] && die "$OUT_DIR already exists; remove it or pick another version"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE not found"

# The key we sign with must be the one we publish.
PUB_B64=$(openssl pkey -in "$RELEASE_KEY" -pubout | grep -v -- '-----')
[ "$PUB_B64" = "$(grep -v -- '-----' "$PUBLIC_KEY")" ] || die "RELEASE_KEY does not match PUBLIC_KEY ($PUBLIC_KEY)"
FPR=$(openssl pkey -in "$RELEASE_KEY" -pubout -outform DER | sha256sum | cut -d' ' -f1)

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
chmod 644 "$OUT_DIR"/*

(cd "$OUT_DIR" && sha256sum "$TARBALL" install.sh docker-compose.yml Caddyfile updater.mjs > SHA256SUMS)

SHA=$(sha256sum "$OUT_DIR/$TARBALL" | cut -d' ' -f1)
SIZE=$(wc -c < "$OUT_DIR/$TARBALL" | tr -d ' ')
VERSION="$VERSION" URL="$HUB_URL/download/server/$TARBALL" SHA="$SHA" SIZE="$SIZE" NOTES="$NOTES" MIN="$MIN_UPGRADE_FROM" SEC="$SECURITY" \
  node -e '
    const e = process.env;
    process.stdout.write(JSON.stringify({ version: e.VERSION, url: e.URL, sha256: e.SHA, size: Number(e.SIZE),
      notes: e.NOTES, min_upgrade_from: e.MIN || null, security: e.SEC === "1" }, null, 2) + "\n");
  ' > "$OUT_DIR/latest.json"

for f in SHA256SUMS latest.json; do
  openssl pkeyutl -sign -rawin -inkey "$RELEASE_KEY" -in "$OUT_DIR/$f" -out "$OUT_DIR/$f.sig"
  openssl pkeyutl -verify -rawin -pubin -inkey "$PUBLIC_KEY" -in "$OUT_DIR/$f" -sigfile "$OUT_DIR/$f.sig" >/dev/null \
    || die "fresh signature of $f does not verify"
done
chmod 644 "$OUT_DIR"/*

echo "Release $VERSION in $OUT_DIR (signed by $SIGNER, key sha256 $FPR):"
ls -l "$OUT_DIR"
