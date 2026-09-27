#!/usr/bin/env bash
# Famigo Office — 이 Mac 을 사무실 서버로.
#
#   bash scripts/install-mac.sh            # 설치·시작 (다시 돌려도 안전)
#   bash scripts/install-mac.sh --lan      # 같은 네트워크의 팀원도 접속 (실명이 보이는 사무실 — 신중히)
#   bash scripts/install-mac.sh --status   # 상태 점검
#   bash scripts/install-mac.sh --uninstall
#
# 띄우는 것 (launchd, 로그인하면 자동 시작 · 죽으면 재시작):
#   life.famigo.office.deskrpg   DeskRPG 3D 사무실         http://localhost:3300 (FAMIGO_DESK_PORT, 내부 +1 도 씀)
#   life.famigo.office.gateway   famigo Lark 게이트웨이    127.0.0.1:8642 (항상 로컬 전용)
#                                + 관리자 웹              http://127.0.0.1:3101 (퇴장·복귀·표시 이름·직무·외형)
#   life.famigo.office.sync      07:45·13:45 Lark 명단 수집 → office.json → 사무실 배치
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKRPG_VERSION="${DESKRPG_VERSION:-2026.927.1}"   # 검증한 버전. 올리려면 먼저 테스트.
ENV_FILE="$HOME/.config/famigo/office.env"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/famigo-office"
LABELS=(life.famigo.office.deskrpg life.famigo.office.gateway life.famigo.office.sync)
# DeskRPG 는 npx 가 아니라 고정 위치에 설치해 직접 띄운다. launchd → npx → CLI → 서버 로 층이 깊으면
# 종료 신호가 서버까지 안 가서 고아 서버가 포트와 PID 파일을 쥐고 남을 수 있다.
DESK_PREFIX="$HOME/.famigo-office/deskrpg"
DESK_CLI="$DESK_PREFIX/node_modules/deskrpg/bin/deskrpg.js"
DESK_PIDFILE="$HOME/.deskrpg/deskrpg.pid"
# DeskRPG 는 PORT 와 PORT+1(내부 Socket.io) 두 개를 쓴다. 3000 은 이 Mac 의 다른 프로그램이 쓴다(2026-09-28).
# 한 번 정한 포트는 office.env 에 남겨 sync·관리자 웹이 같은 값을 쓴다.
DESK_PORT="${FAMIGO_DESK_PORT:-}"
if [[ -z "$DESK_PORT" && -f "$ENV_FILE" ]]; then
  DESK_PORT=$(awk -F= '/^FAMIGO_DESK_PORT=/{print $2}' "$ENV_FILE")
fi
DESK_PORT="${DESK_PORT:-3300}"
DESK_URL="http://127.0.0.1:$DESK_PORT"
UID_N="$(id -u)"

die() { echo "✗ $*" >&2; exit 1; }
ok() { echo "✓ $*"; }

unload_all() {
  for l in "${LABELS[@]}"; do
    launchctl bootout "gui/$UID_N/$l" 2>/dev/null || true
  done
  # bootout 은 비동기다. 이전 프로세스가 다 내려가기 전에 bootstrap 하면
  # "Bootstrap failed: 5: Input/output error" 가 난다 (2026-09-28 실측) — 사라질 때까지 기다린다.
  for l in "${LABELS[@]}"; do
    for _ in $(seq 1 30); do
      launchctl print "gui/$UID_N/$l" >/dev/null 2>&1 || break
      sleep 0.5
    done
  done
}

load_one() {
  local l="$1"
  for attempt in 1 2 3; do
    launchctl bootstrap "gui/$UID_N" "$AGENTS/$l.plist" 2>/dev/null && return 0
    sleep $((attempt * 2))
  done
  launchctl bootstrap "gui/$UID_N" "$AGENTS/$l.plist"   # 마지막 시도는 오류를 보여 준다
}

access() {
  # shellcheck disable=SC1090
  [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }
  local host ip code lan
  host=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:HOSTNAME" "$AGENTS/life.famigo.office.deskrpg.plist" 2>/dev/null || echo "?")
  ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
  code=$(python3 -c "import json;print(json.load(open('$ROOT/out/seed_state.json')).get('invite_code') or '')" 2>/dev/null || true)
  echo "── 접속"
  echo "  나(관리자·사무실 소유자)"
  echo "    사무실   http://localhost:$DESK_PORT    로그인 famigo-office / FAMIGO_DESK_PASSWORD"
  echo "    관리자   http://127.0.0.1:3101    admin / FAMIGO_DESK_PASSWORD   (이 Mac 에서만)"
  if [[ "$host" == "0.0.0.0" ]]; then
    echo "  팀원 (같은 네트워크)"
    echo "    1) http://${ip:-<이 Mac IP>}:$DESK_PORT 에서 각자 가입"
    echo "    2) 초대 링크 http://${ip:-<이 Mac IP>}:$DESK_PORT/channels/join/${code:-<sync 후 생성>}"
    echo "    3) 채널 비밀번호 FAMIGO_CHANNEL_PASSWORD 입력  (소유자 비밀번호와 다르다 — 이것만 알려 준다)"
  else
    echo "  팀원: 지금은 이 Mac 에서만 열려 있다. 팀에 열려면  bash scripts/install-mac.sh --lan"
  fi
  echo "  비밀번호 보기:  grep -E 'DESK|CHANNEL' $ENV_FILE"
}

# 남은 DeskRPG 서버 정리 — DeskRPG 것만 죽인다. 다른 프로그램이 DeskRPG 포트를 쓰면 멈추고 알린다.
stop_stale_deskrpg() {
  local pids=() pid cmd
  [[ -f "$DESK_PIDFILE" ]] && pids+=("$(cat "$DESK_PIDFILE" 2>/dev/null)")
  while read -r pid; do [[ -n "$pid" ]] && pids+=("$pid"); done < <(lsof -nP -t -iTCP:"$DESK_PORT" -iTCP:"$((DESK_PORT + 1))" -sTCP:LISTEN 2>/dev/null)
  for pid in "${pids[@]}"; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    cmd=$(ps -p "$pid" -o command= 2>/dev/null) || continue
    if [[ "$cmd" == *deskrpg* ]]; then   # 고아 서버: …/node_modules/deskrpg/server.js
      echo "  남은 DeskRPG 프로세스 정리: pid $pid"
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    else
      die "포트 $DESK_PORT/$((DESK_PORT + 1)) 을 DeskRPG 가 아닌 프로그램이 쓰고 있다 (pid $pid: $cmd)
  → 다른 포트로:  FAMIGO_DESK_PORT=3400 bash scripts/install-mac.sh ${LAN_FLAG:-}"
    fi
  done
  rm -f "$DESK_PIDFILE"
}

status() {
  for l in "${LABELS[@]}"; do
    if launchctl print "gui/$UID_N/$l" >/dev/null 2>&1; then
      state=$(launchctl print "gui/$UID_N/$l" | awk -F'= ' '/^\tstate/ {print $2; exit}')
      echo "  $l: ${state:-loaded}"
    else
      echo "  $l: 없음"
    fi
  done
  curl -fsS -o /dev/null http://127.0.0.1:8642/health && ok "게이트웨이 응답" || echo "✗ 게이트웨이 무응답"
  curl -fsS -o /dev/null "$DESK_URL/auth" && ok "DeskRPG 응답 ($DESK_URL)" || echo "✗ DeskRPG 무응답 ($DESK_URL)"
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3101/ || true)
  [[ "$code" == "401" ]] && ok "관리자 웹 응답 (http://127.0.0.1:3101)" || echo "✗ 관리자 웹 무응답 ($code)"
  [[ -f "$ROOT/out/office.json" ]] && echo "  office.json 기준: $(python3 -c "import json;print(json.load(open('$ROOT/out/office.json'))['generated_at'])")"
  echo "── 실행 중인 프로세스 (Famigo Office 것만)"
  pgrep -fl "[d]eskrpg|[g]ateway/server.mjs|[o]ffice.sh sync" | sed 's/^/  /' || echo "  없음"
  echo "── 열린 포트"
  for port in "$DESK_PORT" "$((DESK_PORT + 1))" 8642 3101; do
    # 리스너를 전부 보인다 — 같은 포트에 두 프로그램이 서로 다른 주소로 붙어 있을 수 있다(macOS 는 허용).
    lines=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1" pid "$2" "$9}' | sort -u)
    if [[ -z "$lines" ]]; then echo "  $port: 닫힘"; else echo "$lines" | sed "s/^/  $port: /"; fi
  done
  echo "  로그: $LOGS"
  access
}

case "${1:-}" in
  --status) status; exit 0 ;;
  --access) access; exit 0 ;;
  --uninstall)
    unload_all
    stop_stale_deskrpg
    for l in "${LABELS[@]}"; do rm -f "$AGENTS/$l.plist"; done
    ok "서비스 제거 (데이터 ~/.deskrpg · $ENV_FILE · out/ 는 남겨 둠)"
    exit 0
    ;;
esac
LAN=0
[[ "${1:-}" == "--lan" ]] && LAN=1
LAN_FLAG=""
(( LAN )) && LAN_FLAG="--lan"

# ── 0. 전제 ─────────────────────────────────────────────────────────────
[[ "$(uname)" == "Darwin" ]] || die "macOS 전용 스크립트다"
NODE="$(command -v node)" || die "node 가 없다 (brew install node)"
PY="$(command -v python3)" || die "python3 가 없다"
major=$("$NODE" -p 'process.versions.node.split(".")[0]')
(( major >= 20 )) || die "node 20+ 필요 (현재 $("$NODE" -v))"
DATA_DIR="${FAMIGO_DATA_DIR:-$HOME/famigo_campaign/briefs/data}"
[[ -d "$DATA_DIR" ]] || die "Lark 데이터층이 없다: $DATA_DIR"
[[ -f "$HOME/.config/famigo/lark_credentials.json" ]] || die "Lark 자격증명 파일이 없다: ~/.config/famigo/lark_credentials.json"
PATH_FOR_AGENTS="$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
mkdir -p "$AGENTS" "$LOGS" "$ROOT/out"
ok "전제 확인 (node $("$NODE" -v) · 데이터 $DATA_DIR)"

# ── 1. 비밀값 — 저장소 밖, 0600 ────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  ( umask 077
    { echo "FAMIGO_GATEWAY_TOKEN=$(openssl rand -hex 24)"
      echo "FAMIGO_DESK_PASSWORD=$(openssl rand -hex 12)"
      echo "DESKRPG_JWT_SECRET=$(openssl rand -hex 32)"; } > "$ENV_FILE" )
  ok "비밀값 생성: $ENV_FILE"
fi
grep -q '^DESKRPG_JWT_SECRET=' "$ENV_FILE" || ( umask 077; echo "DESKRPG_JWT_SECRET=$(openssl rand -hex 32)" >> "$ENV_FILE" )
# 팀원에게 알려 주는 건 채널 비밀번호뿐이다 — 소유자·관리자 비밀번호와 분리한다.
grep -q '^FAMIGO_CHANNEL_PASSWORD=' "$ENV_FILE" || ( umask 077; echo "FAMIGO_CHANNEL_PASSWORD=$(openssl rand -hex 6)" >> "$ENV_FILE" )
# 포트 기록 (바뀌었으면 갱신)
if grep -q '^FAMIGO_DESK_PORT=' "$ENV_FILE"; then
  sed -i '' "s/^FAMIGO_DESK_PORT=.*/FAMIGO_DESK_PORT=$DESK_PORT/" "$ENV_FILE"
else
  echo "FAMIGO_DESK_PORT=$DESK_PORT" >> "$ENV_FILE"
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# ── 2. 첫 데이터 — 명단 → 모델 (게이트웨이는 모델이 있어야 뜬다) ──────
"$PY" "$ROOT/office/lark_roster.py" --out "$ROOT/out/lark_roster.json" \
  || echo "  ⚠ Lark 명단 수집 실패 — people.json 만으로 진행 (위 사유 확인)"
"$PY" "$ROOT/office/build_office.py" --data-dir "$DATA_DIR" --config "$ROOT/config/office.config.json" \
  --roster "$ROOT/out/lark_roster.json" --out "$ROOT/out/office.json" \
  || die "office.json 생성 실패 — 'bash scripts/office.sh doctor' 로 원천 스키마부터 본다"

# ── 3. DeskRPG 런타임 (~/.deskrpg, SQLite) ─────────────────────────────
installed=$("$NODE" -p "require('$DESK_PREFIX/node_modules/deskrpg/package.json').version" 2>/dev/null || true)
if [[ "$installed" != "$DESKRPG_VERSION" ]]; then
  echo "  DeskRPG $DESKRPG_VERSION 설치 중 ($DESK_PREFIX)"
  mkdir -p "$DESK_PREFIX"
  npm install --prefix "$DESK_PREFIX" "deskrpg@$DESKRPG_VERSION" --no-audit --no-fund --loglevel=error
fi
[[ -f "$HOME/.deskrpg/data/deskrpg.db" ]] || "$NODE" "$DESK_CLI" init
ok "DeskRPG 런타임 준비 (v$DESKRPG_VERSION)"

# ── 4. launchd ─────────────────────────────────────────────────────────
HOSTNAME_BIND=127.0.0.1
(( LAN )) && HOSTNAME_BIND=0.0.0.0

xml_env() { # key value ...
  echo "  <key>EnvironmentVariables</key><dict>"
  while (( $# )); do printf '    <key>%s</key><string>%s</string>\n' "$1" "$2"; shift 2; done
  echo "  </dict>"
}

write_plist() { # label, program-args-xml, env-xml, extra-xml
  cat > "$AGENTS/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$2</array>
  <key>WorkingDirectory</key><string>$ROOT</string>
$3
  <key>StandardOutPath</key><string>$LOGS/$1.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$1.log</string>
$4
</dict></plist>
EOF
  chmod 600 "$AGENTS/$1.plist"   # 비밀값이 들어 있다
}

write_plist life.famigo.office.deskrpg \
  "<string>$NODE</string><string>$DESK_CLI</string><string>start</string><string>-p</string><string>$DESK_PORT</string>" \
  "$(xml_env PATH "$PATH_FOR_AGENTS" HOSTNAME "$HOSTNAME_BIND" JWT_SECRET "$DESKRPG_JWT_SECRET" COOKIE_SECURE false)" \
  "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"

write_plist life.famigo.office.gateway \
  "<string>$NODE</string><string>$ROOT/gateway/server.mjs</string><string>--office</string><string>$ROOT/out/office.json</string><string>--host</string><string>127.0.0.1</string><string>--port</string><string>8642</string><string>--admin-port</string><string>3101</string>" \
  "$(xml_env PATH "$PATH_FOR_AGENTS" FAMIGO_GATEWAY_TOKEN "$FAMIGO_GATEWAY_TOKEN" FAMIGO_DESK_PASSWORD "$FAMIGO_DESK_PASSWORD" FAMIGO_CHANNEL_PASSWORD "$FAMIGO_CHANNEL_PASSWORD" FAMIGO_DATA_DIR "$DATA_DIR" DESKRPG_URL "$DESK_URL" FAMIGO_DESK_PORT "$DESK_PORT")" \
  "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"

write_plist life.famigo.office.sync \
  "<string>/bin/bash</string><string>$ROOT/scripts/office.sh</string><string>sync</string>" \
  "$(xml_env PATH "$PATH_FOR_AGENTS" FAMIGO_DATA_DIR "$DATA_DIR" DESKRPG_URL "$DESK_URL" FAMIGO_DESK_PORT "$DESK_PORT")" \
  "<key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>45</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>45</integer></dict>
  </array>"

unload_all
stop_stale_deskrpg
for l in "${LABELS[@]}"; do load_one "$l"; done
ok "launchd 등록 (로그인 시 자동 시작)"

# ── 5. DeskRPG 가 뜨면 첫 배치 ─────────────────────────────────────────
echo -n "  DeskRPG 기동 대기"
for _ in $(seq 1 120); do
  curl -fsS -o /dev/null "$DESK_URL/auth" 2>/dev/null && break
  echo -n "."; sleep 2
done
echo
if ! curl -fsS -o /dev/null "$DESK_URL/auth"; then
  echo "── DeskRPG 로그 끝부분 ($LOGS/life.famigo.office.deskrpg.log)"
  tail -40 "$LOGS/life.famigo.office.deskrpg.log" 2>/dev/null | sed 's/^/  /'
  die "DeskRPG 가 안 뜬다 — 위 로그를 보여 주세요"
fi
DESKRPG_URL="$DESK_URL" bash "$ROOT/scripts/office.sh" seed

echo
ok "사무실 서버 가동"
access
echo "  상태:   bash scripts/install-mac.sh --status"
