#!/bin/sh
# Creates the Ed25519 release signing key ONCE, outside the repo, and exports its public key
# into selfhost/release-public-key.pem (the key install.sh and the updater trust).
# Refuses to touch an existing key: replacing it would make every installed node reject new releases.
#
#   KEY_DIR=/path/outside/the/repo sh selfhost/scripts/init-release-key.sh
#   KEY_DIR=/elsewhere PUBLIC_OUT=/elsewhere/pub.pem sh selfhost/scripts/init-release-key.sh   (tests)
set -eu

KEY_DIR=${KEY_DIR:?set KEY_DIR to a folder outside the repo}
SELFHOST=$(cd "$(dirname "$0")/.." && pwd)
PRIVATE="$KEY_DIR/release-private.pem"
PUBLIC="$KEY_DIR/release-public.pem"
PUBLIC_OUT=${PUBLIC_OUT:-$SELFHOST/release-public-key.pem}

if [ -e "$PRIVATE" ]; then
  echo "A release key already exists at $PRIVATE; not creating a new one." >&2
  echo "Public key fingerprint (sha256 of the DER key):" >&2
  openssl pkey -pubin -in "$PUBLIC" -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1 >&2 || true
  exit 1
fi

umask 077
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"
openssl genpkey -algorithm ed25519 -out "$PRIVATE"
chmod 600 "$PRIVATE"
openssl pkey -in "$PRIVATE" -pubout -out "$PUBLIC"
chmod 600 "$PUBLIC"

cp "$PUBLIC" "$PUBLIC_OUT"
chmod 644 "$PUBLIC_OUT"

echo "Release key created: $PRIVATE (chmod 600). Back it up OFF this server."
echo "Public key written to $PUBLIC_OUT; put it into install.sh (RELEASE_PUBKEY, RELEASE_FPR)."
printf 'Fingerprint: '
openssl pkey -pubin -in "$PUBLIC" -outform DER | sha256sum | cut -d' ' -f1
