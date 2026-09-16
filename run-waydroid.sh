#!/usr/bin/env bash
#
# run-waydroid.sh -- build and launch the Sachiko operator app inside Waydroid.
#
#   ./run-waydroid.sh                 boot Waydroid, start Metro, build, install, launch
#   ./run-waydroid.sh --fast          skip Gradle, just relaunch the installed app
#   ./run-waydroid.sh --clean         gradlew clean first, then a full build
#   ./run-waydroid.sh --release       build the release variant instead of debug
#   ./run-waydroid.sh --logs          tail the app's logcat
#   ./run-waydroid.sh --stop          stop Metro and shut the Waydroid session down
#   ./run-waydroid.sh --disable-freeze   stop Waydroid freezing itself (one-time, sudo)
#
# Why the ceremony: Waydroid's adb is over TCP, not USB, and its default
# suspend_action=freeze parks the container whenever no Waydroid window is on
# screen -- a frozen container makes every adb call hang forever instead of
# failing. So this script keeps a window up, waits for a real boot, and puts a
# timeout on every adb call rather than trusting them to return.

set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_ID="com.sachikooperator.app"
MAIN_ACTIVITY=".MainActivity"
METRO_PORT="${RCT_METRO_PORT:-8081}"
API_PORT="${SACHIKO_API_PORT:-3001}"
FALLBACK_IP="192.168.240.112"

SESSION_TIMEOUT=120     # seconds to wait for `waydroid session start`
BOOT_TIMEOUT=300        # seconds to wait for Android to finish booting
METRO_TIMEOUT=120       # seconds to wait for Metro to answer /status
IP_TIMEOUT=60           # seconds to wait for the container to report an IP

RUN_DIR="${XDG_RUNTIME_DIR:-/tmp}/sachiko-waydroid"
METRO_LOG="$RUN_DIR/metro.log"
METRO_PID_FILE="$RUN_DIR/metro.pid"
SESSION_LOG="$RUN_DIR/waydroid-session.log"

MODE="debug"
DO_BUILD=1
DO_CLEAN=0
DO_UI=1
ACTION="run"

# ---------------------------------------------------------------- output ----

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

step() { printf '%s==>%s %s%s%s\n' "$C_BLUE$C_BOLD" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
dim()  { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()   { printf '    %s+%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$*" >&2; exit 1; }

usage() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^#\{0,1\} \{0,1\}//'; exit 0; }

# ------------------------------------------------------------------ args ----

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast|--no-build)  DO_BUILD=0 ;;
    --clean)            DO_CLEAN=1 ;;
    --release)          MODE="release" ;;
    --no-ui)            DO_UI=0 ;;
    --port)             shift; [[ $# -gt 0 ]] || die "--port needs a value"; METRO_PORT="$1" ;;
    --logs)             ACTION="logs" ;;
    --stop)             ACTION="stop" ;;
    --disable-freeze)   ACTION="disable-freeze" ;;
    -h|--help)          usage ;;
    *)                  die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

mkdir -p "$RUN_DIR"
cd "$PROJECT_DIR"

# ------------------------------------------------------------- toolchain ----

command -v waydroid >/dev/null 2>&1 || die "waydroid is not installed"

if [[ -z "${ANDROID_HOME:-}" && -n "${ANDROID_SDK_ROOT:-}" ]]; then
  export ANDROID_HOME="$ANDROID_SDK_ROOT"
fi
if [[ -z "${ANDROID_HOME:-}" && -d "$HOME/Android/Sdk" ]]; then
  export ANDROID_HOME="$HOME/Android/Sdk"
fi
[[ -n "${ANDROID_HOME:-}" ]] || die "ANDROID_HOME is not set and ~/Android/Sdk was not found"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"

ADB=""
for candidate in "$ANDROID_HOME/platform-tools/adb" "$(command -v adb 2>/dev/null || true)"; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then ADB="$candidate"; break; fi
done
[[ -n "$ADB" ]] || die "adb not found (looked in \$ANDROID_HOME/platform-tools and \$PATH)"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

# ------------------------------------------------------------- waydroid -----

# `waydroid status` prints tab-separated "Field:\tvalue" lines. Every call gets
# a timeout: a wedged container can make even this block.
wd_field() {
  timeout 15 waydroid status 2>/dev/null | sed -n "s/^$1:[[:space:]]*//p" | head -1 | tr -d '\r'
}

# `waydroid status` reports "IP address: UNKNOWN" for the first few seconds
# after the container starts, so poll until it looks like an IPv4 address
# rather than handing "UNKNOWN:5555" to adb, which then retries a hostname
# that will never resolve.
waydroid_ip() {
  local ip deadline=$((SECONDS + IP_TIMEOUT))
  while (( SECONDS <= deadline )); do
    ip="$(wd_field 'IP address')"
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      printf '%s' "$ip"
      return 0
    fi
    sleep 2
  done
  printf '%s' "$FALLBACK_IP"
}

start_session() {
  if [[ "$(wd_field Session)" == "RUNNING" ]]; then
    ok "Waydroid session already running"
    return 0
  fi

  if ! systemctl is-active --quiet waydroid-container; then
    info "waydroid-container service is not running, starting it (needs sudo)"
    sudo systemctl start waydroid-container || die "could not start waydroid-container"
  fi
  [[ -f /var/lib/waydroid/images/system.img ]] || die "no Waydroid images -- run 'sudo waydroid init' first"

  if [[ "${XDG_SESSION_TYPE:-}" != "wayland" && -z "${WAYLAND_DISPLAY:-}" ]]; then
    die "Waydroid needs a Wayland session; this looks like ${XDG_SESSION_TYPE:-unknown}"
  fi

  info "starting Waydroid session (log: $SESSION_LOG)"
  nohup waydroid session start >"$SESSION_LOG" 2>&1 &
  disown || true

  local deadline=$((SECONDS + SESSION_TIMEOUT))
  while (( SECONDS < deadline )); do
    [[ "$(wd_field Session)" == "RUNNING" ]] && { ok "session running"; return 0; }
    sleep 2
  done
  die "session did not come up within ${SESSION_TIMEOUT}s -- see $SESSION_LOG"
}

# Showing the UI is what keeps suspend_action=freeze from parking the container
# out from under adb. Harmless to call when a window is already open.
show_ui() {
  [[ "$DO_UI" -eq 1 ]] || return 0
  info "opening the Waydroid window (keeps the container awake)"
  nohup waydroid show-full-ui >>"$SESSION_LOG" 2>&1 &
  disown || true

  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    [[ "$(wd_field Container)" == "RUNNING" ]] && return 0
    sleep 2
  done
  warn "container still not RUNNING -- adb may hang; check 'waydroid status'"
}

# ------------------------------------------------------------------ adb -----

adb_dev() { timeout 20 "$ADB" -s "$SERIAL" "$@"; }

wait_for_device() {
  local deadline=$((SECONDS + BOOT_TIMEOUT)) state booted announced=0
  while (( SECONDS < deadline )); do
    timeout 15 "$ADB" connect "$SERIAL" >/dev/null 2>&1 || true
    state="$(timeout 15 "$ADB" -s "$SERIAL" get-state 2>/dev/null | tr -d '\r\n' || true)"
    if [[ "$state" == "device" ]]; then
      booted="$(adb_dev shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n' || true)"
      if [[ "$booted" == "1" ]]; then
        ok "device ready: $SERIAL"
        return 0
      fi
      if [[ "$announced" -eq 0 ]]; then
        dim "connected, waiting for Android to finish booting..."
        announced=1
      fi
    else
      # "offline" sticks until adb is re-handshaked; drop it and reconnect.
      timeout 15 "$ADB" disconnect "$SERIAL" >/dev/null 2>&1 || true
    fi
    sleep 3
  done
  die "device $SERIAL never became ready within ${BOOT_TIMEOUT}s"
}

# ---------------------------------------------------------------- metro -----

metro_running() {
  curl -fsS --max-time 3 "http://127.0.0.1:$METRO_PORT/status" 2>/dev/null \
    | grep -q 'packager-status:running'
}

start_metro() {
  if metro_running; then
    ok "Metro already serving on port $METRO_PORT"
    return 0
  fi

  info "starting Metro on port $METRO_PORT (log: $METRO_LOG)"
  # setsid gives Metro its own process group so --stop can take down the whole
  # npx -> node tree, not just the wrapper.
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup npx react-native start --port "$METRO_PORT" >"$METRO_LOG" 2>&1 &
  else
    nohup npx react-native start --port "$METRO_PORT" >"$METRO_LOG" 2>&1 &
  fi
  echo $! >"$METRO_PID_FILE"
  disown || true

  local deadline=$((SECONDS + METRO_TIMEOUT))
  while (( SECONDS < deadline )); do
    metro_running && { ok "Metro ready"; return 0; }
    sleep 2
  done
  die "Metro did not start within ${METRO_TIMEOUT}s -- see $METRO_LOG"
}

stop_metro() {
  if [[ -f "$METRO_PID_FILE" ]]; then
    local pid; pid="$(cat "$METRO_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      ok "stopped Metro (pid $pid)"
    fi
    rm -f "$METRO_PID_FILE"
  fi
  pkill -f "react-native start --port $METRO_PORT" 2>/dev/null || true
}

# --------------------------------------------------------------- actions ----

SERIAL=""

case "$ACTION" in
  stop)
    step "Shutting down"
    stop_metro
    SERIAL="$(waydroid_ip):5555"
    timeout 15 "$ADB" disconnect "$SERIAL" >/dev/null 2>&1 || true
    timeout 30 waydroid session stop >/dev/null 2>&1 || true
    ok "Waydroid session stopped"
    exit 0
    ;;

  disable-freeze)
    step "Disabling Waydroid's freeze-on-idle"
    if grep -q '^suspend_action = none' /var/lib/waydroid/waydroid.cfg 2>/dev/null; then
      ok "already disabled"
    else
      sudo sed -i 's/^suspend_action = .*/suspend_action = none/' /var/lib/waydroid/waydroid.cfg
      ok "set suspend_action = none"
      info "restarting the session so it takes effect"
      timeout 30 waydroid session stop >/dev/null 2>&1 || true
    fi
    info "the container will now stay awake with no window open"
    exit 0
    ;;

  logs)
    SERIAL="$(waydroid_ip):5555"
    timeout 15 "$ADB" connect "$SERIAL" >/dev/null 2>&1 || true
    step "logcat for $APP_ID (ctrl-c to stop)"
    exec "$ADB" -s "$SERIAL" logcat -v color ReactNative:V ReactNativeJS:V AndroidRuntime:E "*:S"
    ;;
esac

# ------------------------------------------------------------------ run -----

step "1/5  Waydroid"
start_session
show_ui
WD_IP="$(waydroid_ip)"
SERIAL="$WD_IP:5555"
HOST_IP="${WD_IP%.*}.1"           # host end of the waydroid0 bridge
info "container $SERIAL, host reachable from Android as $HOST_IP"

step "2/5  adb"
wait_for_device
ABI="$(adb_dev shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r\n' || true)"
dim "abi ${ABI:-unknown}, android sdk $(adb_dev shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r\n' || echo '?')"

step "3/5  Metro"
start_metro
if adb_dev reverse "tcp:$METRO_PORT" "tcp:$METRO_PORT" >/dev/null 2>&1; then
  ok "adb reverse tcp:$METRO_PORT -> host"
else
  warn "adb reverse failed. In the app press ctrl-M -> Dev Settings ->"
  warn "  'Debug server host & port', and enter: $HOST_IP:$METRO_PORT"
fi

# The debug build talks to the SACHIKO2 server at http://localhost:$API_PORT
# (see src/storage/authStorage.js). Tunnel that back to the host too, or every
# API call fails with "No connection to the server".
if adb_dev reverse "tcp:$API_PORT" "tcp:$API_PORT" >/dev/null 2>&1; then
  ok "adb reverse tcp:$API_PORT -> host (SACHIKO2 server)"
else
  warn "adb reverse tcp:$API_PORT failed -- start the server on the host,"
  warn "  or the app will sit on 'Waiting for the server'"
fi

step "4/5  Build"
if [[ "$DO_CLEAN" -eq 1 ]]; then
  info "gradlew clean"
  (cd android && ./gradlew clean)
fi

if [[ "$DO_BUILD" -eq 1 ]]; then
  # --active-arch-only reads ro.product.cpu.abi off the device and passes
  # -PreactNativeArchitectures=x86_64, instead of building all four ABIs that
  # android/gradle.properties lists. Waydroid is x86_64 with no ARM
  # translation, so the other three are dead weight.
  info "react-native run-android (mode=$MODE, ${ABI:-active} only)"
  npx react-native run-android \
    --device "$SERIAL" \
    --mode "$MODE" \
    --active-arch-only \
    --no-packager \
    --port "$METRO_PORT"
else
  dim "skipped (--fast)"
fi

step "5/5  Launch"
if [[ "$DO_BUILD" -eq 1 ]]; then
  ok "run-android already launched $APP_ID"
else
  if ! adb_dev shell pm list packages 2>/dev/null | tr -d '\r' | grep -q "^package:$APP_ID$"; then
    die "$APP_ID is not installed -- run without --fast to build it first"
  fi
  adb_dev shell am start -n "$APP_ID/$MAIN_ACTIVITY" >/dev/null
  ok "launched $APP_ID"
fi

echo
printf '%sReady.%s  Metro log: %s\n' "$C_GREEN$C_BOLD" "$C_RESET" "$METRO_LOG"
dim "logs:  ./run-waydroid.sh --logs"
dim "stop:  ./run-waydroid.sh --stop"
dim "next time, JS-only changes just need Metro -- reload in the app, no rebuild"
echo
warn "Waydroid caveats for this app: no camera (ScanScreen will fail)."
warn "The SACHIKO2 server on port $API_PORT is tunnelled via adb reverse, so the"
warn "debug build's 'http://localhost:$API_PORT' works -- just have it running."
warn "Any OTHER host service is reachable as '$HOST_IP', never 'localhost'."
