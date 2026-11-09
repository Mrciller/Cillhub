#!/bin/sh
# Signs a release made by make-release.sh (it calls this; run it alone for UNSIGNED=1 builds or to renew the feed).
# Sets latest.json's key_id (sha256 of the signing key) and expires (Unix seconds, now + EXPIRES_DAYS), then writes
# SHA256SUMS.sig and latest.json.sig. Nodes refuse an expired feed, so re-run it on the published release before
# `expires` and publish latest.json(.sig) again.
#
#   sh selfhost/scripts/sign-release.sh <release dir>
#
# Env: RELEASE_KEY   Ed25519 private key; a passphrase-protected one is asked for once on the terminal
#      PASSIN        openssl -passin source instead of asking (e.g. env:MYVAR or file:/path)
#      PUBLIC_KEY    the pinned key list; its first key must belong to RELEASE_KEY (default selfhost/release-public-key.pem)
#      EXPIRES_DAYS  feed lifetime in days (default 30)
set -eu

[ $# -eq 1 ] || { echo "usage: $0 <release dir>" >&2; exit 2; }
DIR=$1
SELFHOST=$(cd "$(dirname "$0")/.." && pwd)
RELEASE_KEY=${RELEASE_KEY:?set RELEASE_KEY to the release private key}
PUBLIC_KEY=${PUBLIC_KEY:-$SELFHOST/release-public-key.pem}
EXPIRES_DAYS=${EXPIRES_DAYS:-30}

die() { echo "sign-release: $*" >&2; exit 1; }
case $EXPIRES_DAYS in ''|*[!0-9]*) die "EXPIRES_DAYS must be a number of days" ;; esac
[ -r "$RELEASE_KEY" ] || die "cannot read release key $RELEASE_KEY"
[ -f "$DIR/SHA256SUMS" ] && [ -f "$DIR/latest.json" ] || die "$DIR has no SHA256SUMS or latest.json"

if [ -z "${PASSIN:-}" ]; then
  if grep -q 'ENCRYPTED' "$RELEASE_KEY"; then
    [ -r /dev/tty ] || die "the key has a passphrase: set PASSIN or run on a terminal"
    printf 'Passphrase for %s: ' "$RELEASE_KEY" > /dev/tty
    stty -echo < /dev/tty; read -r CILLHUB_RELEASE_PASS < /dev/tty || true; stty echo < /dev/tty; echo > /dev/tty
    export CILLHUB_RELEASE_PASS
    PASSIN=env:CILLHUB_RELEASE_PASS
  else
    PASSIN=pass:
  fi
fi

# The key we sign with must be the first pinned key (the one install.sh carries).
[ "$(openssl pkey -in "$RELEASE_KEY" -passin "$PASSIN" -pubout -outform DER | sha256sum)" = "$(openssl pkey -pubin -in "$PUBLIC_KEY" -outform DER | sha256sum)" ] \
  || die "RELEASE_KEY does not match the first key in PUBLIC_KEY ($PUBLIC_KEY), or the passphrase is wrong"
FPR=$(openssl pkey -pubin -in "$PUBLIC_KEY" -outform DER | sha256sum | cut -d' ' -f1)

F="$DIR/latest.json" FPR="$FPR" DAYS="$EXPIRES_DAYS" node -e '
  const fs = require("fs"), e = process.env, j = JSON.parse(fs.readFileSync(e.F, "utf8"));
  j.key_id = e.FPR;
  j.expires = Math.floor(Date.now() / 1000) + Number(e.DAYS) * 86400;
  fs.writeFileSync(e.F, JSON.stringify(j, null, 2) + "\n");
'
for f in SHA256SUMS latest.json; do
  openssl pkeyutl -sign -rawin -inkey "$RELEASE_KEY" -passin "$PASSIN" -in "$DIR/$f" -out "$DIR/$f.sig"
  openssl pkeyutl -verify -rawin -pubin -inkey "$PUBLIC_KEY" -in "$DIR/$f" -sigfile "$DIR/$f.sig" >/dev/null \
    || die "fresh signature of $f does not verify"
done
chmod 644 "$DIR"/*
echo "Signed $DIR with key $FPR; latest.json expires in $EXPIRES_DAYS days"
