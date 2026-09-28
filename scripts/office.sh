#!/usr/bin/env bash
# Famigo Office — Lark 브리핑 데이터를 DeskRPG 3D 사무실로.
#
#   bash scripts/office.sh roster    # Lark API → out/lark_roster.json (지금 Lark 에 있는 구성원 전원)
#   bash scripts/office.sh build     # Lark 데이터층 + 명단 + 실시간 발화 시각 → out/office.json (반출 게이트 통과)
#   bash scripts/office.sh doctor    # 원천 스키마 점검만 (어떤 필드가 맞았는지)
#   bash scripts/office.sh shape     # 원천 파일 구조만 (값 없음 — 채팅에 붙여도 되는 모양)
#   bash scripts/office.sh gateway   # famigo Lark 게이트웨이 (127.0.0.1:8642)
#   bash scripts/office.sh seed      # DeskRPG 에 직원·사무실·보드 배치 (멱등)
#   bash scripts/office.sh apply     # build → seed (관리자 웹이 부른다)
#   bash scripts/office.sh sync      # roster → build → seed (수동 전체 갱신)
#   bash scripts/office.sh live      # 실시간 반영 데몬을 앞에서 실행 (launchd 가 상시로 띄운다)
#
# 상시 서버로 설치:  bash scripts/install-mac.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${FAMIGO_DATA_DIR:-$HOME/famigo_campaign/briefs/data}"
ENV_FILE="${FAMIGO_OFFICE_ENV:-$HOME/.config/famigo/office.env}"
GW_PORT="${FAMIGO_GATEWAY_PORT:-8642}"
LIVE_PY="${FAMIGO_LIVE_PYTHON:-$HOME/.famigo-office/venv/bin/python}"
LOCK="$ROOT/out/.office.lock"
# 시더·재암호화(node)도 이 Mac 밖으로 나가지 않는다 — 외부 연결 차단기(scripts/egress-guard.cjs).
export NODE_OPTIONS="--require $ROOT/scripts/egress-guard.cjs${NODE_OPTIONS:+ $NODE_OPTIONS}"

# 토큰·비밀번호는 저장소가 아니라 사용자 설정 폴더에 0600 으로 둔다. 처음 한 번 생성한다.
ensure_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    mkdir -p "$(dirname "$ENV_FILE")"
    umask 077
    {
      echo "FAMIGO_GATEWAY_TOKEN=$(openssl rand -hex 24)"
      echo "FAMIGO_DESK_PASSWORD=$(openssl rand -hex 12)"
    } > "$ENV_FILE"
    echo "생성: $ENV_FILE (사무실 로그인 비밀번호가 여기 있다)"
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

# 산출물(out/)을 바꾸는 명령은 한 번에 하나만 돈다 — 실시간 데몬·관리자 웹·수동 실행이 겹치면
# 시더 둘이 같은 프로필을 동시에 만든다. macOS 에는 flock 이 없어서 mkdir 의 원자성을 쓴다.
# 잠금을 쥔 프로세스가 죽었으면(pid 가 없으면) 잠금을 치우고 다시 잡는다.
take_lock() {
  mkdir -p "$ROOT/out"
  local waited=0 holder
  until mkdir "$LOCK" 2>/dev/null; do
    holder=$(cat "$LOCK/pid" 2>/dev/null || true)
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$LOCK"
      continue
    fi
    if (( waited >= 600 )); then
      echo "✗ 10분 넘게 잠겨 있다 (pid ${holder:-?}) — $LOCK" >&2
      exit 75
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo $$ > "$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
}

do_roster() {
  # 인자: (없음) 전체 수집 — 24시간 안에 했으면 건너뛴다 · --chats a,b 그 방만 · --drop c 해산 · --force
  # Lark 월 호출 한도가 있다 — 호출 수는 out/lark_calls.json 에 남는다(office/lark_meter.py).
  python3 office/lark_roster.py --out out/lark_roster.json "$@"
}

do_build() {
  # 1. 사람별·관리자용 인사이트 — 게이트를 통과하지 않는 층(원문·리포트·L2·L3). 로컬 전용 0600,
  #    인증된 대시보드와 1:1 대화만 읽는다.
  python3 office/build_insights.py --data-dir "$DATA_DIR" --roster out/lark_roster.json \
    --live out/live/messages.jsonl --out out/insights.json
  # 2. 말투·성향 → 외형 (out/looks.json 은 설치 때 DeskRPG 에서 추출). 실패해도 사무실은 지금 외형으로 간다.
  python3 office/persona.py --insights out/insights.json --looks out/looks.json --config config/office.config.json \
    --seed-state out/seed_state.json --office out/office.json --out out/persona.json \
    || echo "⚠ 말투 분석 실패 — 지금 외형 유지"
  # 3. 사무실 모델 (반출 게이트 통과)
  python3 office/build_office.py --data-dir "$DATA_DIR" --config config/office.config.json \
    --roster out/lark_roster.json --activity out/lark_activity.json --live out/live/messages.jsonl \
    --persona out/persona.json --out out/office.json
}

do_seed() {
  ensure_env
  # 시더는 입구(Famigo Office)가 아니라 이 Mac 안의 엔진에 바로 닿는다 — 엔진 = 입구 포트 + 10 (install-mac.sh).
  APP_URL="${DESKRPG_URL:-http://127.0.0.1:$(( ${FAMIGO_DESK_PORT:-3300} + 10 ))}"
  node seed/seed.mjs --app "$APP_URL" --gateway "http://127.0.0.1:$GW_PORT" --office out/office.json
  echo "로그인: famigo-office / \$FAMIGO_DESK_PASSWORD ($ENV_FILE)"
}

cd "$ROOT"
case "${1:-}" in
  roster) take_lock; do_roster "${@:2}" ;;
  build) take_lock; do_build ;;
  seed) take_lock; do_seed ;;
  apply)
    take_lock
    do_build
    do_seed
    ;;
  sync)
    take_lock
    echo "── sync $(date '+%F %T')"
    # 명단 수집 실패는 전체 실패가 아니다 — 직전 명단으로 계속 간다. 사유는 로그에 남는다.
    do_roster || echo "⚠ 명단 수집 실패 — 직전 명단 유지"
    do_build
    do_seed
    ;;
  shape)
    python3 office/shape.py --data-dir "$DATA_DIR"
    ;;
  doctor)
    python3 office/build_office.py --data-dir "$DATA_DIR" --config config/office.config.json \
      --roster out/lark_roster.json --activity out/lark_activity.json --doctor
    ;;
  gateway)
    ensure_env
    exec node gateway/server.mjs --office out/office.json --host 127.0.0.1 --port "$GW_PORT" --admin-port "${FAMIGO_ADMIN_PORT:-3101}" \
      --dashboard-port "$(( ${FAMIGO_DESK_PORT:-3300} + 2 ))"
    ;;
  live)
    [[ -x "$LIVE_PY" ]] || { echo "✗ 실시간 데몬용 Python 이 없다: $LIVE_PY (bash scripts/install-mac.sh 가 만든다)" >&2; exit 1; }
    exec "$LIVE_PY" office/lark_live.py --root "$ROOT" --data-dir "$DATA_DIR"
    ;;
  *)
    sed -n '2,14p' "$0"
    exit 1
    ;;
esac
