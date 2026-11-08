#!/usr/bin/env bash
# Instrumented end-to-end tests on an emulator against THROWAWAY Cillhub instances (fresh DATA_DIRs), never production.
# Needs a running emulator (see README) and a built client (client/dist). Screenshots land in android/test-shots/.
#
#   1. AppFlowTest and CarScreensTest against a server on $PORT with a stand-in for LiveKit's HTTP API.
#   2. VoiceFlowTest against a cillvoice server ($CV_PORT, UDP $CV_UDP) and, when LIVEKIT_API_KEY/SECRET are set (a local
#      LiveKit on 127.0.0.1:7880), against a LiveKit server ($LK_SRV_PORT); the other participant is the web client in
#      headless Chromium (scripts/web-peer.cjs, needs Playwright with Chromium in NODE_PATH; skipped without it).
#
# BUILD=minified (default) tests the release build (R8, release key from cillhub.signingDir when available) pointed at
# the test servers; BUILD=debug the debug build.
set -euo pipefail
PORT=${PORT:-3360}
LK_PORT=${LK_PORT:-3369}
CV_PORT=${CV_PORT:-3361}
CV_UDP=${CV_UDP:-50271}
LK_SRV_PORT=${LK_SRV_PORT:-3362}
PEER_PORT=${PEER_PORT:-3370}
BUILD=${BUILD:-minified}
# cillvoice's media address: one the emulator reaches through its NAT AND the host's browser reaches (not 10.0.2.2,
# which only the emulator knows, nor 127.0.0.1, the emulator's own loopback): the docker bridge, else the host's first address
CV_IP=${CV_IP:-$( (ip -4 -o addr show docker0 2>/dev/null || true) | awk '{print $4}' | cut -d/ -f1)}
CV_IP=${CV_IP:-$(hostname -I | awk '{print $1}')}
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/.." && pwd)
export ANDROID_HOME=${ANDROID_HOME:-/opt/android-sdk}
ADB="$ANDROID_HOME/platform-tools/adb"
TMP=$(mktemp -d /tmp/cillcord-android-test-XXXXXX)
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; "$ADB" reverse --remove tcp:7880 >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

server() { # name port env...
  local name=$1 port=$2; shift 2
  mkdir -p "$TMP/$name"
  (cd "$ROOT/server" && exec env PORT=$port DATA_DIR="$TMP/$name" STATIC_DIR="$ROOT/client/dist" "$@" node src/index.js) > "$TMP/$name.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 50); do curl -sf "http://127.0.0.1:$port/api/v9/gateway" >/dev/null && return; sleep 0.2; done
  echo "server $name did not start"; cat "$TMP/$name.log"; exit 1
}

# a stand-in for LiveKit's HTTP API: DM calls need a voice backend to start (no media flows in AppFlowTest)
node -e "require('http').createServer((q,s)=>{q.resume();q.on('end',()=>{s.writeHead(200,{'Content-Type':'application/json'});s.end('{}')})}).listen($LK_PORT,'127.0.0.1')" &
PIDS+=($!)
server app $PORT LIVEKIT_URL=http://127.0.0.1:$LK_PORT LIVEKIT_PUBLIC_URL=ws://10.0.2.2:$LK_PORT LIVEKIT_API_KEY=test LIVEKIT_API_SECRET=test-secret-test-secret-test-secret
server cillvoice $CV_PORT VOICE_BACKEND=cillvoice CILLVOICE_UDP_PORT=$CV_UDP CILLVOICE_PUBLIC_IP=$CV_IP CILLVOICE_BIND_IP=$CV_IP
if [ -n "${LIVEKIT_API_KEY:-}" ] && [ -n "${LIVEKIT_API_SECRET:-}" ]; then
  # the emulator reaches the local LiveKit as 127.0.0.1:7880 through adb reverse, so one URL works for it and the browser
  server livekit $LK_SRV_PORT LIVEKIT_URL=http://127.0.0.1:7880 LIVEKIT_PUBLIC_URL=ws://127.0.0.1:7880
  "$ADB" reverse tcp:7880 tcp:7880 >/dev/null
fi
PEER=no
if node -e "require('playwright')" 2>/dev/null; then
  node "$HERE/scripts/web-peer.cjs" $PEER_PORT > "$TMP/peer.log" 2>&1 &
  PIDS+=($!)
  PEER=yes
fi

cd "$HERE"
Variant=$(echo "${BUILD:0:1}" | tr a-z A-Z)${BUILD:1}
PKG=io.github.mrciller.cillhub.$BUILD
"$ADB" shell rm -rf /data/local/tmp/cillcord-shots
status=0
run() { # test class, extra gradle args
  local cls=$1; shift
  "$ADB" uninstall $PKG >/dev/null 2>&1 || true
  ./gradlew --no-daemon -q "connected${Variant}AndroidTest" -Pcillhub.testBuildType=$BUILD -Pcillhub.url=http://10.0.2.2:$PORT \
    -Pandroid.testInstrumentationRunnerArguments.class=io.github.mrciller.cillhub.$cls "$@" || status=$?
  # each run replaces the XML: say here what this one did
  for f in app/build/outputs/androidTest-results/connected/$BUILD/TEST-*.xml; do
    echo "$cls $(printf "%s " "$@" | grep -o "backend=[^ ]*"): $(grep -o 'tests="[0-9]*" failures="[0-9]*"' "$f" | head -1)"
    grep -o '<testcase name="[^"]*"[^>]*>\s*<failure>[^&<]*' "$f" | sed 's/<testcase name="\([^"]*\)".*<failure>/  FAILED \1: /' | cut -c1-300 || true
  done
}
run AppFlowTest
run CarScreensTest
if [ $PEER = yes ]; then
  voice() { run VoiceFlowTest -Pandroid.testInstrumentationRunnerArguments.backend=$1 -Pandroid.testInstrumentationRunnerArguments.voiceServer=http://10.0.2.2:$2 \
    -Pandroid.testInstrumentationRunnerArguments.voiceWebBase=http://127.0.0.1:$2 -Pandroid.testInstrumentationRunnerArguments.webPeer=http://10.0.2.2:$PEER_PORT; }
  voice cillvoice $CV_PORT
  [ -n "${LIVEKIT_API_KEY:-}" ] && voice LiveKit $LK_SRV_PORT
else
  echo "VoiceFlowTest skipped: no Playwright (NODE_PATH)"
fi
mkdir -p test-shots
"$ADB" pull /data/local/tmp/cillcord-shots/. test-shots/ >/dev/null && ls test-shots
for f in /tmp/cillhub-webpeer-*-sees-phone.png; do [ -e "$f" ] && mv "$f" test-shots/; done
echo "reports: app/build/reports/androidTests/connected/"
exit $status
