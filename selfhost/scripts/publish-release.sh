#!/bin/sh
# Publishes a release made by make-release.sh to the hub's download folder. The OWNER runs this; agents don't.
#
#   sh selfhost/scripts/publish-release.sh <release dir> <dest>
#
# dest: the web folder served as https://<hub>/download/server/.
# Older tarballs stay. Signatures are checked again with selfhost/release-public-key.pem first.
# Order: tarball and files, then SHA256SUMS(.sig), then latest.json(.sig) last, so nodes only see a
# new version once everything it points at is in place. Each file is swapped in atomically.
set -eu

[ $# -eq 2 ] || { echo "usage: $0 <release dir> <dest>" >&2; exit 2; }
SRC=$1
DEST=$2
SELFHOST=$(cd "$(dirname "$0")/.." && pwd)
PUB="$SELFHOST/release-public-key.pem"

die() { echo "publish-release: $*" >&2; exit 1; }

for f in SHA256SUMS latest.json; do
  [ -f "$SRC/$f" ] && [ -f "$SRC/$f.sig" ] || die "missing $SRC/$f or its .sig"
  openssl pkeyutl -verify -rawin -pubin -inkey "$PUB" -in "$SRC/$f" -sigfile "$SRC/$f.sig" >/dev/null \
    || die "$f is not signed by the key in $PUB"
done
(cd "$SRC" && sha256sum -c --quiet SHA256SUMS) || die "SHA256SUMS does not match the files"
TARBALL=$(awk '{print $2}' "$SRC/SHA256SUMS" | grep '^cillhub-server-.*\.tar\.gz$')
grep -q "\"sha256\": \"$(sha256sum "$SRC/$TARBALL" | cut -d' ' -f1)\"" "$SRC/latest.json" \
  || die "latest.json does not describe $TARBALL"

mkdir -p "$DEST"
chmod 755 "$DEST"
put() {
  cp "$SRC/$1" "$DEST/.$1.tmp"
  chmod 644 "$DEST/.$1.tmp"
  mv -f "$DEST/.$1.tmp" "$DEST/$1"
}
for f in "$TARBALL" install.sh docker-compose.yml Caddyfile updater.mjs release-public-key.pem; do put "$f"; done
put SHA256SUMS.sig; put SHA256SUMS
put latest.json.sig; put latest.json

echo "Published $TARBALL to $DEST:"
ls -l "$DEST"
