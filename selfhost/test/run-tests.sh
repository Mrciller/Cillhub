#!/bin/sh
# Self-host package tests: static checks, release tooling with a TEST key, install.sh against a fake hub
# (incl. tampering), the updater (update, failing update -> automatic rollback, manual rollback) and automatic updates
# in the maintenance window (patch mode: patch and security releases only; no retry of a version that failed).
#
#   sh selfhost/test/run-tests.sh
#
# Uses only throwaway names (prefix TEST_PREFIX, default cillhub-sh): images cillhub-sh-test:*, compose project
# cillhub-sh-test, container cillhub-sh-hub, ports 127.0.0.1:3420 (app), 3421/udp (voice), 127.0.0.1:3422 (hub),
# a temp dir. Everything is removed on exit. Never signs anything with the real release key.
set -u

SELFHOST=$(cd "$(dirname "$0")/.." && pwd)
SRC=$(cd "$SELFHOST/.." && pwd)
T=$(mktemp -d /tmp/cillhub-sh.XXXXXX)
P=${TEST_PREFIX:-cillhub-sh}   # name prefix of every throwaway image, project and container
PROJECT=$P-test
REPO=$P-test
HUBC=$P-hub
HUB_HOST=http://127.0.0.1:3422
APP=http://127.0.0.1:3420
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$*"; }
check() { desc=$1; shift; if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi; }
fatal() { bad "$*"; exit 1; }

cleanup() {
  echo "-- cleanup"
  [ "$FAIL" != 0 ] && [ -f "$T/inst/.env" ] && (cd "$T/inst" && docker compose logs --tail 60 updater app; docker ps -a --filter "label=com.docker.compose.project=$PROJECT")
  [ -f "$T/inst/.env" ] && (cd "$T/inst" && docker compose down -v --remove-orphans >/dev/null 2>&1)
  docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | xargs -r docker rm -f >/dev/null
  docker rm -f "$HUBC" >/dev/null 2>&1
  docker network rm "${PROJECT}_default" >/dev/null 2>&1
  # by tag, so an image passed in as BASE_IMAGE keeps its own tags
  docker images --format '{{.Repository}}:{{.Tag}}' --filter "reference=$REPO:*" | xargs -r docker rmi -f >/dev/null 2>&1
  rm -rf "$T"
  left=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"; docker ps -aq --filter "name=$HUBC"; docker images -q --filter "reference=$REPO:*")
  [ -z "$left" ] && [ ! -e "$T" ] && echo "cleanup complete" || echo "CLEANUP INCOMPLETE: $left"
  echo "passed $PASS, failed $FAIL"
  [ "$FAIL" = 0 ]
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# every container that is not ours must be untouched by the tests
others() { docker ps --format '{{.Names}} {{.ID}} {{.Status}}' | grep -v "^$P" | sed 's/Up [^(]*//' | sort; }
prod_before=$(others)

echo "-- static checks"
if command -v shellcheck >/dev/null; then
  for f in "$SELFHOST"/install.sh "$SELFHOST"/scripts/*.sh "$SELFHOST"/test/*.sh; do check "shellcheck $(basename "$f")" shellcheck -s sh "$f"; done
else
  echo "(shellcheck not installed: sh -n and dash -n instead)"
  for f in "$SELFHOST"/install.sh "$SELFHOST"/scripts/*.sh "$SELFHOST"/test/*.sh; do
    check "sh -n $(basename "$f")" sh -n "$f"
    if command -v dash >/dev/null; then check "dash -n $(basename "$f")" dash -n "$f"; fi
  done
fi
check "node --check updater.mjs" node --check "$SELFHOST/updater.mjs"
mkdir -p "$T/c" && cp "$SELFHOST/docker-compose.yml" "$T/c/" &&
  printf 'CILLCORD_IMAGE=x\nCILLCORD_HTTP_PORT=1\nCILLVOICE_UDP_PORT=2\nCILLCORD_HOSTNAME=h\nLIVEKIT_API_KEY=k\nLIVEKIT_API_SECRET=s\n' > "$T/c/.env"
check "compose file parses (all profiles)" sh -c "cd '$T/c' && docker compose --profile caddy --profile livekit config -q"
check "install.sh carries the real key and its fingerprint" sh -c "
  pub=\$(grep -v -- ----- '$SELFHOST/release-public-key.pem')
  grep -q \"^RELEASE_PUBKEY='\$pub'\" '$SELFHOST/install.sh' &&
  fpr=\$(openssl pkey -pubin -in '$SELFHOST/release-public-key.pem' -outform DER | sha256sum | cut -d' ' -f1) &&
  grep -q \"^RELEASE_FPR='\$fpr'\" '$SELFHOST/install.sh'"

echo "-- release key script"
mkdir -p "$T/k"
check "init-release-key creates a key (temp dir)" sh -c "KEY_DIR='$T/k/new' PUBLIC_OUT='$T/k/pub.pem' sh '$SELFHOST/scripts/init-release-key.sh'"
check "  private key is chmod 600" test "$(stat -c %a "$T/k/new/release-private.pem")" = 600
if KEY_DIR="$T/k/new" PUBLIC_OUT="$T/k/pub2.pem" sh "$SELFHOST/scripts/init-release-key.sh" >/dev/null 2>&1; then bad "init-release-key refuses an existing key"
else ok "init-release-key refuses an existing key"; fi
check "  and leaves no second public key" test ! -e "$T/k/pub2.pem"

echo "-- release tooling (TEST key)"
TKEY="$T/k/new/release-private.pem"
TPUB="$T/k/pub.pem"
# BASE_IMAGE / NEXT_IMAGE (optional): run everything with other images, e.g. two builds of the real Dockerfile; the
# releases 1.0.0 and 1.3.0 come from BASE_IMAGE, 1.1.0 from NEXT_IMAGE. Default: the small Dockerfile.test image.
if [ -n "${BASE_IMAGE:-}" ]; then
  docker tag "$BASE_IMAGE" "$REPO:base" || fatal "tag $BASE_IMAGE"
  docker tag "${NEXT_IMAGE:-$BASE_IMAGE}" "$REPO:next" || fatal "tag ${NEXT_IMAGE:-$BASE_IMAGE}"
else
  docker build -q -t "$REPO:base" -f "$SELFHOST/test/Dockerfile.test" "$SRC/server" >/dev/null || fatal "build test image"
  docker tag "$REPO:base" "$REPO:next"
fi
# A release that writes into the database and then crashes: proves the snapshot is restored on rollback.
printf '%s\n' "FROM $REPO:base" \
  "CMD [\"node\", \"-e\", \"new (require('node:sqlite').DatabaseSync)('/data/cillcord.sqlite').exec('CREATE TABLE broken_marker (x)'); process.exit(3)\"]" \
  | docker build -q -t "$REPO:broken" - >/dev/null || fatal "build broken image"
release() { # release VERSION IMAGE [MIN] [SECURITY]
  RELEASE_KEY="$TKEY" PUBLIC_KEY="$TPUB" SIGNER="TEST KEY (not a real release)" HUB_URL=http://fakehub:8000 \
    IMAGE_REPO="$REPO" OUT_DIR="$T/rel/$1" NOTES="Test release $1" MIN_UPGRADE_FROM="${3:-}" SECURITY="${4:-0}" \
    sh "$SELFHOST/scripts/make-release.sh" "$1" "$2" > "$T/release-$1.log" 2>&1
}
check "make-release 1.0.0" release 1.0.0 "$REPO:base"
check "make-release 1.1.0" release 1.1.0 "$REPO:next"
check "make-release 1.2.0 (broken)" release 1.2.0 "$REPO:broken"
check "make-release refuses the test key against the real public key" sh -c \
  "! RELEASE_KEY='$TKEY' OUT_DIR='$T/rel/x' sh '$SELFHOST/scripts/make-release.sh' 9.9.9 '$REPO:base'"
check "make-release refuses to run without RELEASE_KEY" sh -c \
  "! env -u RELEASE_KEY PUBLIC_KEY='$TPUB' OUT_DIR='$T/rel/y' sh '$SELFHOST/scripts/make-release.sh' 9.9.9 '$REPO:base'"
R="$T/rel/1.0.0"
check "release has all files" sh -c "cd '$R' && ls cillhub-server-1.0.0.tar.gz install.sh docker-compose.yml Caddyfile updater.mjs SHA256SUMS SHA256SUMS.sig latest.json latest.json.sig"
check "SHA256SUMS signed with the test key" openssl pkeyutl -verify -rawin -pubin -inkey "$TPUB" -in "$R/SHA256SUMS" -sigfile "$R/SHA256SUMS.sig"
check "  and not with the real key" sh -c "! openssl pkeyutl -verify -rawin -pubin -inkey '$SELFHOST/release-public-key.pem' -in '$R/SHA256SUMS' -sigfile '$R/SHA256SUMS.sig'"
check "latest.json signed" openssl pkeyutl -verify -rawin -pubin -inkey "$TPUB" -in "$R/latest.json" -sigfile "$R/latest.json.sig"
check "latest.json fields" node -e "
  const j = require('$R/latest.json'), fs = require('fs'), c = require('crypto');
  const f = fs.readFileSync('$R/cillhub-server-1.0.0.tar.gz');
  if (j.version !== '1.0.0' || j.size !== f.length || j.sha256 !== c.createHash('sha256').update(f).digest('hex')
    || j.url !== 'http://fakehub:8000/download/server/cillhub-server-1.0.0.tar.gz' || j.notes !== 'Test release 1.0.0' || j.min_upgrade_from !== null || j.security !== false) process.exit(1)"
check "install.sh in the release carries the test key" grep -q "^RELEASE_SIGNER='TEST KEY" "$R/install.sh"
check "make-release left no versioned tag behind" sh -c "! docker image inspect $REPO:1.0.0"

echo "-- fake hub"
HUBDIR="$T/hub/download/server"
mkdir -p "$HUBDIR"
publish() { cp "$T/rel/$1"/* "$HUBDIR/"; }
publish 1.0.0
docker run -d --name "$HUBC" -p 127.0.0.1:3422:8000 -v "$T/hub:/srv:ro" "$REPO:base" node -e "
  const fs = require('fs'), path = require('path');
  require('http').createServer((q, s) => {
    const p = path.join('/srv', decodeURIComponent(new URL(q.url, 'http://x').pathname));
    if (!p.startsWith('/srv/')) return s.writeHead(403).end();
    fs.stat(p, (e, st) => e || !st.isFile() ? s.writeHead(404).end() : fs.createReadStream(p).pipe(s));
  }).listen(8000)" >/dev/null || fatal "start fake hub"
i=0; until curl -fs -o /dev/null "$HUB_HOST/download/server/SHA256SUMS"; do i=$((i + 1)); [ $i -lt 20 ] || fatal "fake hub"; sleep 0.5; done

INSTALL_ARGS="--hub $HUB_HOST --project $PROJECT --hostname chat.example.test --no-caddy --http-port 3420 --udp-port 3421 --public-ip 127.0.0.1 --yes"
FAR_HOUR=$(( ($(date -u +%H | sed 's/^0//') + 12) % 24 )) # automatic updates on, but in an hour far from now
not_loaded() { ! docker image inspect "$REPO:1.0.0" >/dev/null 2>&1; }

echo "-- tampering (install must stop before docker load)"
cp "$HUBDIR/SHA256SUMS" "$T/sums.orig"
echo "0000000000000000000000000000000000000000000000000000000000000000  extra" >> "$HUBDIR/SHA256SUMS"
# shellcheck disable=SC2086
sh "$R/install.sh" $INSTALL_ARGS --dir "$T/tamper1" > "$T/tamper1.log" 2>&1; rc=$?
check "tampered SHA256SUMS: install fails" test "$rc" != 0
check "  reports the signature failure" grep -q "SIGNATURE CHECK FAILED" "$T/tamper1.log"
check "  nothing loaded, no .env" sh -c "! docker image inspect $REPO:1.0.0 && test ! -e '$T/tamper1/.env'"
cp "$T/sums.orig" "$HUBDIR/SHA256SUMS"

cp "$HUBDIR/cillhub-server-1.0.0.tar.gz" "$T/tar.orig"
printf 'x' >> "$HUBDIR/cillhub-server-1.0.0.tar.gz"
# shellcheck disable=SC2086
sh "$R/install.sh" $INSTALL_ARGS --dir "$T/tamper2" > "$T/tamper2.log" 2>&1; rc=$?
check "tampered tarball: install fails" test "$rc" != 0
check "  reports the checksum mismatch" grep -q "CHECKSUM MISMATCH for cillhub-server-1.0.0.tar.gz" "$T/tamper2.log"
check "  nothing loaded" not_loaded
cp "$T/tar.orig" "$HUBDIR/cillhub-server-1.0.0.tar.gz"

# shellcheck disable=SC2086
sh "$SELFHOST/install.sh" $INSTALL_ARGS --dir "$T/tamper3" > "$T/tamper3.log" 2>&1; rc=$?
check "install.sh with the real key rejects a test-signed release" sh -c "test $rc != 0 && grep -q 'SIGNATURE CHECK FAILED' '$T/tamper3.log'"
check "  nothing loaded" not_loaded

echo "-- install"
# shellcheck disable=SC2086
sh "$R/install.sh" $INSTALL_ARGS --auto-update all --update-hour "$FAR_HOUR" --dir "$T/inst" > "$T/install.log" 2>&1 || { cat "$T/install.log"; fatal "install.sh"; }
ok "install.sh 1.0.0 finished"
envget() { sed -n "s/^$1=//p" "$T/inst/.env"; }
check "prints the signer" grep -q "Signature OK: signed by TEST KEY" "$T/install.log"
check "prints the setup code from .env" grep -q "Setup code: $(envget CILLCORD_SETUP_CODE) " "$T/install.log"
check "prints the voice port to open" grep -q "UDP 3421" "$T/install.log"
check "prints an nginx example (--no-caddy)" grep -q "proxy_pass http://127.0.0.1:3420;" "$T/install.log"
check ".env is chmod 600" test "$(stat -c %a "$T/inst/.env")" = 600
check ".env has the automatic update settings (--auto-update all --update-hour)" sh -c "grep -qx 'CILLCORD_AUTO_UPDATE=all' '$T/inst/.env' && grep -qx 'CILLCORD_AUTO_UPDATE_HOUR=$FAR_HOUR' '$T/inst/.env'"
check "install.sh refuses a bad --auto-update / --update-hour" sh -c "! sh '$R/install.sh' --auto-update=weekly --dir '$T/nope' --yes && ! sh '$R/install.sh' --update-hour 24 --dir '$T/nope' --yes && test ! -e '$T/nope/.env'"
check ".env has generated secrets" sh -c "test \$(sed -n 's/^CILLCORD_UPDATER_SECRET=//p' '$T/inst/.env' | wc -c) -ge 64"
check "stack running: app answers" curl -fs -o /dev/null "$APP/api/v9/gateway"
check "stack running: updater up" sh -c "cd '$T/inst' && docker compose ps --status running --services | grep -qx updater"
check "app runs 1.0.0" sh -c "cd '$T/inst' && docker compose exec -T app printenv CILLCORD_VERSION | grep -qx 1.0.0"
check "no caddy, no livekit" sh -c "cd '$T/inst' && ! docker compose ps --services | grep -Eq 'caddy|livekit'"
sum_before=$(sha256sum "$T/inst/.env")
# shellcheck disable=SC2086
sh "$R/install.sh" $INSTALL_ARGS --dir "$T/inst" > "$T/install2.log" 2>&1
check "second run succeeds (idempotent)" test $? = 0
check "  keeps image and .env" sh -c "grep -q 'Existing install found' '$T/install2.log' && test \"\$(sha256sum '$T/inst/.env')\" = '$sum_before'"
check "  app still answers" curl -fs -o /dev/null "$APP/api/v9/gateway"

# Registration is closed until setup is done; the first admin is created with the printed setup code.
TOKEN=$(curl -fs -H 'content-type: application/json' -d "{\"setup_code\":\"$(envget CILLCORD_SETUP_CODE)\",\"email\":\"t@example.test\",\"username\":\"selfhosttest\",\"password\":\"correct horse battery\"}" "$APP/api/v9/setup/admin" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
check "setup code creates the first admin" test -n "$TOKEN"
login() { curl -fs -o /dev/null -H 'content-type: application/json' -d '{"login":"t@example.test","password":"correct horse battery"}' "$APP/api/v9/auth/login"; }

echo "-- updater"
# The updater reaches the fake hub over the project network as http://fakehub:8000.
docker network connect --alias fakehub "${PROJECT}_default" "$HUBC" || fatal "connect hub to network"
sed -i 's|^CILLCORD_HUB_URL=.*|CILLCORD_HUB_URL=http://fakehub:8000|' "$T/inst/.env"
(cd "$T/inst" && docker compose up -d >/dev/null 2>&1) || fatal "compose up with the test hub"
i=0; until curl -fs -o /dev/null "$APP/api/v9/gateway"; do i=$((i + 1)); [ $i -lt 60 ] || fatal "app back"; sleep 1; done
sleep 2
# upd METHOD PATH [BODY] [SECRET]: the request the app makes. Sent from the updater container because
# the app is down during an update (the dashboard reconnects afterwards).
upd() {
  (cd "$T/inst" && docker compose exec -T -e M="$1" -e P="$2" -e B="${3:-}" -e S="${4:-}" updater node -e "
    fetch('http://127.0.0.1:8787' + process.env.P, { method: process.env.M, body: process.env.B || undefined,
      headers: { authorization: 'Bearer ' + (process.env.S || process.env.CILLCORD_UPDATER_SECRET), 'content-type': 'application/json' } })
      .then(async (r) => console.log(r.status + ' ' + await r.text()), (e) => console.log('000 ' + e.message))")
}
wait_done() { # polls /status until the operation finishes; prints the final status
  i=0
  while :; do
    s=$(upd GET /status 2>/dev/null)
    case $s in *'"state":"updating"'*|*'"state":"rolling_back"'*|'') ;; *) printf '%s\n' "$s"; return ;; esac
    i=$((i + 1)); [ $i -lt 120 ] || { printf '%s\n' "$s"; return; }
    sleep 2
  done
}
field() { printf '%s' "$1" | sed 's/^[0-9]* //' | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const v=JSON.parse(s)$2;console.log(typeof v==='object'?JSON.stringify(v):v)})"; }
app_version() { (cd "$T/inst" && docker compose exec -T app printenv CILLCORD_VERSION); }

r=$(upd GET /status "" "wrong-secret-wrong-secret-wrong-secret")
case $r in 401*) ok "wrong secret -> 401" ;; *) bad "wrong secret -> 401 (got $r)" ;; esac
r=$(upd GET /check)
check "check: 1.0.0 is up to date" test "$(field "$r" .update_available)" = false
r=$(upd POST /update)
case $r in 409*) ok "update when up to date -> 409" ;; *) bad "update when up to date -> 409 (got $r)" ;; esac

publish 1.1.0
r=$(upd GET /check)
check "check: 1.1.0 available" test "$(field "$r" .latest.version) $(field "$r" .update_available)" = "1.1.0 true"
r=$(upd POST /update '{"version":"1.0.5"}')
case $r in 409*) ok "update to a version the hub does not offer -> 409" ;; *) bad "version mismatch -> 409 (got $r)" ;; esac
r=$(upd POST /update '{"version":"1.1.0"}')
case $r in 202*) ok "update to 1.1.0 accepted" ;; *) bad "update accepted (got $r)" ;; esac
s=$(wait_done)
check "update finished: done" test "$(field "$s" .state)" = done
check "  status reports 1.1.0" test "$(field "$s" .current_version)" = 1.1.0
check "  app runs 1.1.0" test "$(app_version)" = 1.1.0
check "  app answers" curl -fs -o /dev/null "$APP/api/v9/gateway"
check "  user still logs in" login
check "  backup has data.tar.gz and a database snapshot" sh -c "ls '$T'/inst/backups/*-pre-1.1.0/data.tar.gz '$T'/inst/backups/*-pre-1.1.0/cillcord.sqlite"
check "  previous image tagged (1.0.0)" sh -c "docker image inspect $REPO:previous --format '{{json .Config.Env}}' | grep -q CILLCORD_VERSION=1.0.0"
check "  the app is reachable as 'app' on the project network" sh -c "cd '$T/inst' && docker compose exec -T updater node -e \"require('dns').lookup('app', e => process.exit(e ? 1 : 0))\""
check "  one app container, no leftovers" test "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=app | wc -l)" = 1
check "  downloaded tarball removed after load" sh -c "! ls '$T'/inst/releases/*.tar.gz"

publish 1.2.0
r=$(upd POST /update)
case $r in 202*) ok "update to 1.2.0 (broken) accepted" ;; *) bad "broken update accepted (got $r)" ;; esac
s=$(wait_done)
check "failed update: state failed, rolled back" test "$(field "$s" .state) $(field "$s" .rolled_back)" = "failed true"
err=$(field "$s" .error)
case $err in *"the app exited"*) ok "  error says the app exited" ;; *) bad "  error says the app exited (got $err)" ;; esac
check "  status carries the failed container's log" sh -c "test -n '$(field "$s" .logs | head -c 40 | tr -d "'")'"
check "  app back on 1.1.0" test "$(app_version)" = 1.1.0
check "  app answers" curl -fs -o /dev/null "$APP/api/v9/gateway"
check "  user still logs in" login
check "  database restored from the snapshot (broken release's write is gone)" sh -c "cd '$T/inst' && docker compose exec -T updater node -e \"
  const d = new (require('node:sqlite').DatabaseSync)('/install/data/cillcord.sqlite');
  process.exit(d.prepare(\\\"SELECT count(*) n FROM sqlite_master WHERE name = 'broken_marker'\\\").get().n)\""
check "  previous still 1.0.0" test "$(field "$s" .previous.version)" = 1.0.0

r=$(upd POST /rollback)
case $r in 202*) ok "manual rollback accepted" ;; *) bad "manual rollback accepted (got $r)" ;; esac
s=$(wait_done)
check "rollback done, on 1.0.0" test "$(field "$s" .state) $(field "$s" .current_version) $(app_version)" = "done 1.0.0 1.0.0"
check "  app answers" curl -fs -o /dev/null "$APP/api/v9/gateway"
check "  user still logs in" login
r=$(upd POST /rollback)
case $r in 409*) ok "second rollback -> 409" ;; *) bad "second rollback -> 409 (got $r)" ;; esac

check "make-release 1.3.0 with min_upgrade_from 1.1.0" release 1.3.0 "$REPO:base" 1.1.0
publish 1.3.0
r=$(upd POST /update)
case $r in 422*) ok "update below min_upgrade_from -> 422" ;; *) bad "min_upgrade_from -> 422 (got $r)" ;; esac
r=$(upd GET /check)
check "check: can_update false" test "$(field "$r" .can_update)" = false

echo "-- automatic updates"
publish 1.1.0 # offered again; a manual update could install it, an automatic one must not
r=$(upd POST /update '{"auto":true}')
case $r in 409*"rolled back before"*) ok "auto update refuses a version rolled back before (1.1.0 after the manual rollback)" ;;
  *) bad "auto update refuses a rolled-back version (got $r)" ;; esac
# auto_restart: in the window now (an hour boundary is avoided), forget the app's last automatic run, restart the app;
# its first automatic run comes 30 s after the start
auto_restart() {
  [ "$(date -u +%M)" -lt 58 ] || sleep 150
  sed -i "s|^CILLCORD_AUTO_UPDATE=.*|CILLCORD_AUTO_UPDATE=patch|; s|^CILLCORD_AUTO_UPDATE_HOUR=.*|CILLCORD_AUTO_UPDATE_HOUR=$(date -u +%H | sed 's/^0//')|" "$T/inst/.env"
  (cd "$T/inst" && docker compose stop app >/dev/null 2>&1 && docker compose exec -T updater node -e "
    new (require('node:sqlite').DatabaseSync)('/install/data/cillcord.sqlite').exec(\"DELETE FROM instance_settings WHERE key = 'update_last_auto'\")" &&
    docker compose up -d --force-recreate app >/dev/null 2>&1)
  i=0; until curl -fs -o /dev/null "$APP/api/v9/gateway"; do i=$((i + 1)); [ $i -lt 60 ] || return 1; sleep 1; done
}
wait_auto() { # wait_auto VERSION: until the updater finished an update to VERSION (or 150 s passed); prints the status
  i=0
  while :; do
    s=$(upd GET /status 2>/dev/null)
    case $s in *"\"target_version\":\"$1\""*'"state":"done"'*|*'"state":"done"'*"\"target_version\":\"$1\""*) printf '%s\n' "$s"; return ;;
      *"\"target_version\":\"$1\""*'"state":"failed"'*|*'"state":"failed"'*"\"target_version\":\"$1\""*) printf '%s\n' "$s"; return ;; esac
    i=$((i + 1)); [ $i -lt 75 ] || { printf '%s\n' "$s"; return; }
    sleep 2
  done
}
check "make-release 1.0.1 (patch)" release 1.0.1 "$REPO:next"
publish 1.0.1
auto_restart || bad "app back after the restart for automatic updates"
s=$(wait_auto 1.0.1)
check "patch mode, in the window: 1.0.0 -> 1.0.1 installed automatically" test "$(field "$s" .state) $(field "$s" .action) $(field "$s" .target_version) $(app_version)" = "done update 1.0.1 1.0.1"
check "  backup taken first" sh -c "ls '$T'/inst/backups/*-pre-1.0.1/cillcord.sqlite"
check "  app answers" curl -fs -o /dev/null "$APP/api/v9/gateway"
check "  user still logs in" login
check "  the decision is kept in the app's database" sh -c "cd '$T/inst' && docker compose exec -T updater node -e \"
  const r = new (require('node:sqlite').DatabaseSync)('/install/data/cillcord.sqlite').prepare('SELECT value FROM instance_settings WHERE key = ?').get('update_last_auto');
  process.exit(r && JSON.parse(r.value).decision === 'updating to 1.0.1' ? 0 : 1)\""

check "make-release 1.4.0 (minor, not a security release)" release 1.4.0 "$REPO:base"
publish 1.4.0
auto_restart || bad "app back after the restart"
i=0; until (cd "$T/inst" && docker compose logs app 2>/dev/null | grep -q 'auto-update: 1.4.0 is not a patch or security release'); do i=$((i + 1)); [ $i -lt 45 ] || break; sleep 2; done
check "patch mode leaves a minor release alone (logged)" sh -c "cd '$T/inst' && docker compose logs app | grep -q 'auto-update: 1.4.0 is not a patch or security release (mode patch); update by hand'"
check "  still on 1.0.1" test "$(app_version)" = 1.0.1

check "make-release 1.5.0 (minor, marked security)" release 1.5.0 "$REPO:base" "" 1
check "  latest.json says security: true" node -e "process.exit(require('$T/rel/1.5.0/latest.json').security === true ? 0 : 1)"
publish 1.5.0
auto_restart || bad "app back after the restart"
s=$(wait_auto 1.5.0)
check "patch mode installs a security release: 1.0.1 -> 1.5.0" test "$(field "$s" .state) $(field "$s" .target_version) $(app_version)" = "done 1.5.0 1.5.0"

prod_after=$(others)
check "other containers untouched" test "$prod_before" = "$prod_after"
