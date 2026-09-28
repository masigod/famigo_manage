#!/usr/bin/env bash
# Famigo Office — 이 Mac 을 사무실 서버로.
#
#   bash scripts/install-mac.sh            # 설치·시작 (다시 돌려도 안전)
#   bash scripts/install-mac.sh --lan      # 같은 네트워크의 팀원도 접속 (실명이 보이는 사무실 — 신중히)
#   bash scripts/install-mac.sh --status   # 상태 점검
#   bash scripts/install-mac.sh --uninstall
#
# 띄우는 것 (launchd, 로그인하면 자동 시작 · 죽으면 재시작):
#   life.famigo.office.front     Famigo Office 입구         http://<이 Mac>:3300 (화면) · :3301 (실시간) — 팀원이 들어오는 곳
#   life.famigo.office.engine    사무실 엔진(DeskRPG)       127.0.0.1:3310 · :3311 — 이 Mac 안에만. 입구가 이름을 입혀 보낸다
#   life.famigo.office.gateway   famigo Lark 게이트웨이    127.0.0.1:8642 (항상 로컬 전용)
#                                + 관리자 웹              http://127.0.0.1:3101 (퇴장·복귀·표시 이름·직무·외형·계정 연결)
#                                + 대시보드               http://<이 Mac>:3302 (예약 결과 · 사람별 · 관리자 보기)
#   life.famigo.office.live      실시간 반영 — Lark 장기 연결 이벤트 · 데이터층 파일 감시 · 10분 전체 대조
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKRPG_VERSION="${DESKRPG_VERSION:-2026.927.1}"   # 검증한 버전. 올리려면 먼저 테스트.
LARK_OAPI_VERSION="${LARK_OAPI_VERSION:-1.7.3}"    # 공식 SDK(장기 연결). 검증한 버전.
VENV="$HOME/.famigo-office/venv"
ENV_FILE="$HOME/.config/famigo/office.env"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/famigo-office"
LABELS=(life.famigo.office.engine life.famigo.office.front life.famigo.office.gateway life.famigo.office.live)
# 옛 설치에 남아 있으면 내린다: 하루 두 번 예약 갱신(sync) → 실시간 데몬(live),
# DeskRPG 를 LAN 에 바로 열던 서비스(deskrpg) → 엔진(engine, 이 Mac 안) + 입구(front, Famigo Office).
LEGACY_LABELS=(life.famigo.office.sync life.famigo.office.deskrpg)
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
DESK_PORT="${DESK_PORT:-3300}"              # Famigo Office 입구 — 팀원 주소가 바뀌지 않게 그대로 둔다
ENGINE_PORT=$((DESK_PORT + 10))             # 사무실 엔진(DeskRPG) — 127.0.0.1 에만. 내부 소켓은 +1
DESK_URL="http://127.0.0.1:$ENGINE_PORT"    # 시더·관리자 웹·게이트웨이는 엔진에 바로 닿는다
PUBLIC_URL="http://127.0.0.1:$DESK_PORT"
# 대시보드(예약 결과 · 사람별 · 관리자 보기) = 사무실 포트 + 2. 사무실 로그인 쿠키를 그대로 쓴다.
DASH_PORT=$((DESK_PORT + 2))
UID_N="$(id -u)"

die() { echo "✗ $*" >&2; exit 1; }
ok() { echo "✓ $*"; }

unload_all() {
  for l in "${LABELS[@]}" "${LEGACY_LABELS[@]}"; do
    launchctl bootout "gui/$UID_N/$l" 2>/dev/null || true
  done
  for l in "${LEGACY_LABELS[@]}"; do rm -f "$AGENTS/$l.plist"; done
  # bootout 은 비동기다. 이전 프로세스가 다 내려가기 전에 bootstrap 하면
  # "Bootstrap failed: 5: Input/output error" 가 난다 (2026-09-28 실측) — 사라질 때까지 기다린다.
  for l in "${LABELS[@]}" "${LEGACY_LABELS[@]}"; do
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
  local ip code
  ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
  code=$(python3 -c "import json;print(json.load(open('$ROOT/out/seed_state.json')).get('invite_code') or '')" 2>/dev/null || true)
  echo "── 접속"
  echo "  나(관리자·사무실 소유자)"
  echo "    사무실   http://localhost:$DESK_PORT    로그인 famigo-office / FAMIGO_DESK_PASSWORD"
  echo "    관리자   http://127.0.0.1:3101    로그인 없음 (이 Mac 에서만 열린다) — 대시보드 계정 연결도 여기서"
  echo "    대시보드 http://localhost:$DASH_PORT    사무실 로그인 그대로"
  if [[ "${FAMIGO_LAN:-0}" == "1" ]]; then
    echo "  팀원 (같은 네트워크)"
    echo "    1) http://${ip:-<이 Mac IP>}:$DESK_PORT 에서 각자 가입"
    echo "    2) 초대 링크 http://${ip:-<이 Mac IP>}:$DESK_PORT/channels/join/${code:-<sync 후 생성>}"
    echo "    3) 채널 비밀번호 FAMIGO_CHANNEL_PASSWORD 입력  (소유자 비밀번호와 다르다 — 이것만 알려 준다)"
    echo "    4) 대시보드 http://${ip:-<이 Mac IP>}:$DASH_PORT  (관리자 웹에서 계정을 Lark 사람과 연결해야 보인다)"
  else
    echo "  팀원: 지금은 이 Mac 에서만 열려 있다. 팀에 열려면  bash scripts/install-mac.sh --lan"
  fi
  echo "  비밀번호 보기:  grep -E 'DESK|CHANNEL' $ENV_FILE"
}

# 남은 사무실 프로세스 정리 — 우리 것(엔진=DeskRPG, 입구=front/server.mjs)만 죽인다.
# 다른 프로그램이 입구·엔진 포트를 쓰면 멈추고 알린다.
stop_stale_deskrpg() {
  local pids=() pid cmd
  [[ -f "$DESK_PIDFILE" ]] && pids+=("$(cat "$DESK_PIDFILE" 2>/dev/null)")
  while read -r pid; do [[ -n "$pid" ]] && pids+=("$pid"); done < <(lsof -nP -t -iTCP:"$DESK_PORT" -iTCP:"$((DESK_PORT + 1))" -iTCP:"$ENGINE_PORT" -iTCP:"$((ENGINE_PORT + 1))" -sTCP:LISTEN 2>/dev/null)
  # macOS 기본 bash 3.2 는 set -u 에서 빈 배열 "${pids[@]}" 를 unbound 로 죽는다 — 비었을 때를 따로 둔다.
  for pid in ${pids[@]+"${pids[@]}"}; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    cmd=$(ps -p "$pid" -o command= 2>/dev/null) || continue
    if [[ "$cmd" == *deskrpg* || "$cmd" == *famigo_manage/front/server.mjs* || "$cmd" == *next-server* ]]; then
      echo "  남은 사무실 프로세스 정리: pid $pid"
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    else
      die "포트 $DESK_PORT/$((DESK_PORT + 1))/$ENGINE_PORT/$((ENGINE_PORT + 1)) 을 다른 프로그램이 쓰고 있다 (pid $pid: $cmd)
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
  curl -fsS -o /dev/null "$PUBLIC_URL/auth" && ok "Famigo Office 입구 응답 ($PUBLIC_URL)" || echo "✗ Famigo Office 입구 무응답 ($PUBLIC_URL)"
  curl -fsS -o /dev/null "$DESK_URL/auth" && ok "사무실 엔진 응답 ($DESK_URL, 이 Mac 안)" || echo "✗ 사무실 엔진 무응답 ($DESK_URL)"
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3101/ || true)
  [[ "$code" == "200" ]] && ok "관리자 웹 응답 (http://127.0.0.1:3101)" || echo "✗ 관리자 웹 무응답 ($code)"
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$DASH_PORT/" || true)
  [[ "$code" == "200" ]] && ok "대시보드 응답 (http://127.0.0.1:$DASH_PORT)" || echo "✗ 대시보드 무응답 ($code)"
  [[ -f "$ROOT/out/insights.json" ]] && echo "  insights.json 기준: $(python3 -c "import json;print(json.load(open('$ROOT/out/insights.json'))['generated_at'])")"
  [[ -f "$ROOT/out/office.json" ]] && echo "  office.json 기준: $(python3 -c "import json;print(json.load(open('$ROOT/out/office.json'))['generated_at'])")"
  echo "── 실행 중인 프로세스 (Famigo Office 것만)"
  pgrep -fl "[d]eskrpg|[f]ront/server.mjs|[g]ateway/server.mjs|[l]ark_live.py|[o]ffice.sh (sync|apply|seed|build)" | sed 's/^/  /' || echo "  없음"
  echo "── 실시간 반영 (최근 기록)"
  local live_log="$LOGS/life.famigo.office.live.log"
  if [[ -f "$live_log" ]]; then
    # Lark 장기 연결 상태: 마지막 연결/끊김 줄, 그리고 마지막 반영 줄.
    grep -E "connected to|disconnected|장기 연결" "$live_log" | tail -1 | sed 's/^/  /' || true
    grep -E "반영 (끝|미완)" "$live_log" | tail -1 | sed 's/^/  /' || true
  else
    echo "  기록 없음"
  fi
  echo "── 열린 포트"
  for port in "$DESK_PORT" "$((DESK_PORT + 1))" "$ENGINE_PORT" "$((ENGINE_PORT + 1))" "$DASH_PORT" 8642 3101; do
    # 리스너를 전부 보인다 — 같은 포트에 두 프로그램이 서로 다른 주소로 붙어 있을 수 있다(macOS 는 허용).
    # 리스너가 없으면 lsof 가 1 을 내고, pipefail + set -e 가 스크립트를 끊는다 → || true
    lines=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1" pid "$2" "$9}' | sort -u || true)
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
    for l in "${LABELS[@]}" "${LEGACY_LABELS[@]}"; do rm -f "$AGENTS/$l.plist"; done
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
chmod 700 "$LOGS" "$ROOT/out"   # 로그·산출물에 구성원 이름·원문이 있다 — 이 Mac 의 다른 계정이 못 읽게
ok "전제 확인 (node $("$NODE" -v) · 데이터 $DATA_DIR)"

EGRESS_GUARD_EARLY="--require $ROOT/scripts/egress-guard.cjs"   # 설치 중의 node 도 이 Mac 밖으로 나가지 않는다(npm 설치 제외)

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
# DeskRPG 내부 RPC(/_internal/emit 등) 비밀. 없으면 JWT 비밀로 대신 쓰는데(DeskRPG 가 시작 때 경고한다),
# --lan 에서는 이 창구가 소켓 포트와 함께 LAN 에 열리므로 로그인 토큰 서명 비밀과 반드시 분리한다.
grep -q '^DESKRPG_INTERNAL_RPC_SECRET=' "$ENV_FILE" || ( umask 077; echo "DESKRPG_INTERNAL_RPC_SECRET=$(openssl rand -hex 32)" >> "$ENV_FILE" )
# 포트 기록 (바뀌었으면 갱신). `sed -i` 는 쓰지 않는다 — BSD 는 `-i ''`, GNU 는 `-i` 로 문법이 갈리고
# 이 Mac 은 Homebrew gnu-sed 가 PATH 앞에 있다(2026-09-28 실측: BSD 문법이 GNU 에서 깨졌다).
set_env_var() { # key value — 0600 을 유지한 채 한 줄만 바꾸거나 붙인다
  local tmp
  tmp=$(umask 077; mktemp "$ENV_FILE.XXXXXX")
  awk -v k="$1" -v v="$2" 'BEGIN{done=0} index($0, k"=")==1 {print k"="v; done=1; next} {print} END{if(!done) print k"="v}' \
    "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}
set_env_var FAMIGO_DESK_PORT "$DESK_PORT"
set_env_var FAMIGO_LAN "$LAN"   # 접속 안내·상태 점검이 같은 값을 본다
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# ── 2. 사무실 엔진(DeskRPG) 런타임 (~/.deskrpg, SQLite) ─────────────────────────────
installed=$("$NODE" -p "require('$DESK_PREFIX/node_modules/deskrpg/package.json').version" 2>/dev/null || true)
if [[ "$installed" != "$DESKRPG_VERSION" ]]; then
  echo "  DeskRPG $DESKRPG_VERSION 설치 중 ($DESK_PREFIX)"
  mkdir -p "$DESK_PREFIX"
  npm install --prefix "$DESK_PREFIX" "deskrpg@$DESKRPG_VERSION" --no-audit --no-fund --loglevel=error
fi
[[ -f "$HOME/.deskrpg/data/deskrpg.db" ]] || "$NODE" "$DESK_CLI" init
# 사무실 DB(계정·비밀번호 해시·채팅·암호화된 토큰)와 엔진 설정은 이 Mac 의 다른 계정이 못 읽게 한다
# (DeskRPG 가 0755/0644 로 만든다 — 2026-09-28 실측).
chmod 700 "$HOME/.deskrpg" "$HOME/.deskrpg/data" 2>/dev/null || true
chmod 600 "$HOME/.deskrpg/.env.local" "$HOME/.deskrpg/data/"deskrpg.db* 2>/dev/null || true
ok "DeskRPG 런타임 준비 (v$DESKRPG_VERSION)"
# 외형 목록은 설치된 엔진에서 뽑는다(저장소에 싣지 않는다 — DeskRPG 내용 · Sustainable Use License).
NODE_OPTIONS="$EGRESS_GUARD_EARLY" "$NODE" "$ROOT/scripts/extract-looks.mjs" --deskrpg "$DESK_PREFIX/node_modules/deskrpg" --out "$ROOT/out/looks.json" \
  || die "외형 목록 추출 실패"

# ── 3. 첫 데이터 — 명단 → 모델 (게이트웨이는 모델이 있어야 뜬다) ──────
# office.sh 를 거친다 — 재설치 중에도 돌고 있을 실시간 데몬과 같은 잠금을 쓴다.
export FAMIGO_DATA_DIR="$DATA_DIR"
bash "$ROOT/scripts/office.sh" roster \
  || echo "  ⚠ Lark 명단 수집 실패 — people.json 만으로 진행 (위 사유 확인)"
bash "$ROOT/scripts/office.sh" build \
  || die "office.json 생성 실패 — 'bash scripts/office.sh doctor' 로 원천 스키마부터 본다"

# ── 3-1. 실시간 반영용 Python (전용 venv, lark-oapi 버전 고정) ──────────
# 기반 인터프리터는 지금 셸의 python3 실체(pyenv 등). Homebrew python 은 올라갈 때 venv 가 깨질 수 있다.
BASE_PY="$("$PY" -c 'import sys; print(sys.executable)')"
have=$("$VENV/bin/python" -c "import importlib.metadata as m; print(m.version('lark-oapi'))" 2>/dev/null || true)
if [[ "$have" != "$LARK_OAPI_VERSION" ]]; then
  echo "  lark-oapi $LARK_OAPI_VERSION 설치 중 ($VENV, 기반 $BASE_PY)"
  rm -rf "$VENV"
  "$BASE_PY" -m venv "$VENV"
  "$VENV/bin/pip" install -q --disable-pip-version-check "lark-oapi==$LARK_OAPI_VERSION"
fi
"$VENV/bin/python" -c "import lark_oapi" || die "lark-oapi 를 불러올 수 없다 ($VENV)"
ok "실시간 반영 런타임 준비 (lark-oapi $LARK_OAPI_VERSION)"

# ── 4. launchd ─────────────────────────────────────────────────────────
HOSTNAME_BIND=127.0.0.1
(( LAN )) && HOSTNAME_BIND=0.0.0.0
# FAMIGO 데이터는 이 Mac 밖으로 나가지 않는다(2026-09-28). DeskRPG·게이트웨이의 모든 TCP 연결을 목적지로 검사해
# 이 Mac 자신 말고는 막는다 — DeskRPG 의 끌 수 없는 외부 호출(GitHub 별 개수·릴리스 확인·채팅 링크 미리보기)까지.
# 실시간 데몬·명단 수집기(Python)는 office/egress.py 가 Lark 만 허용한다.
EGRESS_GUARD="--require $ROOT/scripts/egress-guard.cjs"
# 직원이 1:1 대화에서 알려 줄 대시보드 주소 — LAN 이면 이 Mac 의 LAN 주소.
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
DASH_URL="http://localhost:$DASH_PORT"
(( LAN )) && [[ -n "$LAN_IP" ]] && DASH_URL="http://$LAN_IP:$DASH_PORT"
# 대시보드 포트를 다른 프로그램이 쓰면 멈춘다(우리 게이트웨이는 곧 내려간다).
if owner_pid=$(lsof -nP -t -iTCP:"$DASH_PORT" -sTCP:LISTEN 2>/dev/null | head -1) && [[ -n "$owner_pid" ]]; then
  cmd=$(ps -p "$owner_pid" -o command= 2>/dev/null || true)
  [[ "$cmd" == *gateway/server.mjs* ]] || die "대시보드 포트 $DASH_PORT 를 다른 프로그램이 쓴다 (pid $owner_pid: $cmd)
  → 다른 포트로:  FAMIGO_DESK_PORT=3400 bash scripts/install-mac.sh ${LAN_FLAG:-}"
fi

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

# 사무실 엔진(DeskRPG) — 언제나 이 Mac 안(127.0.0.1)에만.
# 실시간: 엔진이 게이트웨이의 카드 변화(/deskrpg/events)를 확인하는 간격을 2초(보는 중)·5초(아무도 안 볼 때)로 줄인다
# (기본 5초·60초 — DeskRPG automation-poller.ts). 게이트웨이도 이 Mac 안이라 부담이 없다. 화면·실시간 소켓은 입구(front)가 받아 넘긴다.
# 브라우저는 소켓을 '페이지 포트 + 1' 로 붙으므로(DeskRPG 클라이언트) 입구가 3300·3301 둘 다 받는다.
# 엔진의 내부 RPC(/_internal/*)는 소켓 포트에 함께 붙어 있다 — 입구가 LAN 에 열지 않는다.
write_plist life.famigo.office.engine \
  "<string>$NODE</string><string>$DESK_CLI</string><string>start</string><string>-p</string><string>$ENGINE_PORT</string>" \
  "$(xml_env PATH "$PATH_FOR_AGENTS" HOSTNAME 127.0.0.1 INTERNAL_HOSTNAME 127.0.0.1 \
      JWT_SECRET "$DESKRPG_JWT_SECRET" INTERNAL_RPC_SECRET "$DESKRPG_INTERNAL_RPC_SECRET" COOKIE_SECURE false \
      NODE_OPTIONS "$EGRESS_GUARD" NEXT_TELEMETRY_DISABLED 1 \
      AUTOMATION_POLL_ACTIVE_MS 2000 AUTOMATION_POLL_IDLE_MS 5000)" \
  "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"

# Famigo Office 입구 — 팀원이 들어오는 곳. 엔진 화면에 이름·안내·기본 언어(한국어)를 입히고 라이선스 표시는 그대로 둔다.
write_plist life.famigo.office.front \
  "<string>$NODE</string><string>$ROOT/front/server.mjs</string><string>--port</string><string>$DESK_PORT</string><string>--host</string><string>$HOSTNAME_BIND</string><string>--engine-port</string><string>$ENGINE_PORT</string><string>--deskrpg</string><string>$DESK_PREFIX/node_modules/deskrpg</string>" \
  "$(xml_env PATH "$PATH_FOR_AGENTS" NODE_OPTIONS "$EGRESS_GUARD")" \
  "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"

write_plist life.famigo.office.gateway \
  "<string>$NODE</string><string>$ROOT/gateway/server.mjs</string><string>--office</string><string>$ROOT/out/office.json</string><string>--host</string><string>127.0.0.1</string><string>--port</string><string>8642</string><string>--admin-port</string><string>3101</string><string>--dashboard-port</string><string>$DASH_PORT</string><string>--dashboard-host</string><string>$HOSTNAME_BIND</string>" \
  "$(xml_env PATH "$PATH_FOR_AGENTS" FAMIGO_GATEWAY_TOKEN "$FAMIGO_GATEWAY_TOKEN" FAMIGO_DESK_PASSWORD "$FAMIGO_DESK_PASSWORD" FAMIGO_CHANNEL_PASSWORD "$FAMIGO_CHANNEL_PASSWORD" FAMIGO_DATA_DIR "$DATA_DIR" DESKRPG_URL "$DESK_URL" FAMIGO_DESK_PORT "$DESK_PORT" \
      DESKRPG_JWT_SECRET "$DESKRPG_JWT_SECRET" FAMIGO_DESKRPG_DIR "$DESK_PREFIX/node_modules/deskrpg" FAMIGO_DASHBOARD_URL "$DASH_URL" \
      NODE_OPTIONS "$EGRESS_GUARD")" \
  "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"

# 실시간 반영 — 비밀값은 plist 에 넣지 않는다(office.sh seed 가 office.env 를 직접 읽는다).
write_plist life.famigo.office.live \
  "<string>$VENV/bin/python</string><string>$ROOT/office/lark_live.py</string><string>--root</string><string>$ROOT</string><string>--data-dir</string><string>$DATA_DIR</string>" \
  "$(xml_env PATH "$PATH_FOR_AGENTS" FAMIGO_DATA_DIR "$DATA_DIR" DESKRPG_URL "$DESK_URL" FAMIGO_DESK_PORT "$DESK_PORT" PYTHONUNBUFFERED 1)" \
  "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>"

unload_all
stop_stale_deskrpg
# DeskRPG 가 꺼진 지금, 저장 토큰을 서버 비밀(INTERNAL_RPC_SECRET) 키로 옮긴다. 옛 설치는 JWT 비밀 키로
# 암호화돼 있다 — 안 옮기면 칸반이 500 이다. 멱등이라 매번 돌려도 된다(이미 옮겼으면 아무것도 안 쓴다).
if [[ -f "$HOME/.deskrpg/data/deskrpg.db" ]]; then
  DESKRPG_FROM_SECRET="$DESKRPG_JWT_SECRET" DESKRPG_TO_SECRET="$DESKRPG_INTERNAL_RPC_SECRET" \
    "$NODE" "$ROOT/seed/rekey.mjs" --db "$HOME/.deskrpg/data/deskrpg.db" --deskrpg "$DESK_PREFIX/node_modules/deskrpg" \
    || die "저장 토큰 재암호화 실패 — DeskRPG 를 올리지 않았다 (위 사유 확인)"
fi
for l in "${LABELS[@]}"; do load_one "$l"; done
ok "launchd 등록 (로그인 시 자동 시작)"

# ── 5. 엔진이 뜨면 첫 배치 ─────────────────────────────────────────────
echo -n "  사무실 엔진 기동 대기"
for _ in $(seq 1 120); do
  curl -fsS -o /dev/null "$DESK_URL/auth" 2>/dev/null && break
  echo -n "."; sleep 2
done
echo
if ! curl -fsS -o /dev/null "$DESK_URL/auth"; then
  echo "── 엔진 로그 끝부분 ($LOGS/life.famigo.office.engine.log)"
  tail -40 "$LOGS/life.famigo.office.engine.log" 2>/dev/null | sed 's/^/  /'
  die "사무실 엔진이 안 뜬다 — 위 로그를 보여 주세요"
fi
curl -fsS -o /dev/null "$PUBLIC_URL/auth" || die "Famigo Office 입구가 안 뜬다 — $LOGS/life.famigo.office.front.log"
DESKRPG_URL="$DESK_URL" bash "$ROOT/scripts/office.sh" seed

echo
ok "Famigo Office 가동"
access
echo "  상태:   bash scripts/install-mac.sh --status"
