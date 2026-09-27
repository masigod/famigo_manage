#!/usr/bin/env bash
# Famigo Office — Lark 브리핑 데이터를 DeskRPG 3D 사무실로.
#
#   bash scripts/office.sh roster    # Lark API → out/lark_roster.json (지금 Lark 에 있는 구성원 전원)
#   bash scripts/office.sh build     # Lark 데이터층 + 명단 → out/office.json (반출 게이트 통과)
#   bash scripts/office.sh doctor    # 원천 스키마 점검만 (어떤 필드가 맞았는지)
#   bash scripts/office.sh gateway   # famigo Lark 게이트웨이 (127.0.0.1:8642)
#   bash scripts/office.sh seed      # DeskRPG 에 직원·사무실·보드 배치 (멱등)
#   bash scripts/office.sh sync      # roster → build → seed (launchd 가 하루 두 번 부른다)
#
# 상시 서버로 설치:  bash scripts/install-mac.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${FAMIGO_DATA_DIR:-$HOME/famigo_campaign/briefs/data}"
ENV_FILE="${FAMIGO_OFFICE_ENV:-$HOME/.config/famigo/office.env}"
APP_URL="${DESKRPG_URL:-http://127.0.0.1:3000}"
GW_PORT="${FAMIGO_GATEWAY_PORT:-8642}"

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

cd "$ROOT"
case "${1:-}" in
  roster)
    python3 office/lark_roster.py --out out/lark_roster.json
    ;;
  build)
    python3 office/build_office.py --data-dir "$DATA_DIR" --config config/office.config.json \
      --roster out/lark_roster.json --out out/office.json
    ;;
  sync)
    echo "── sync $(date '+%F %T')"
    # 명단 수집 실패는 전체 실패가 아니다 — 직전 명단으로 계속 간다. 사유는 로그에 남는다.
    bash "$ROOT/scripts/office.sh" roster || echo "⚠ 명단 수집 실패 — 직전 명단 유지"
    bash "$ROOT/scripts/office.sh" build
    bash "$ROOT/scripts/office.sh" seed
    ;;
  doctor)
    python3 office/build_office.py --data-dir "$DATA_DIR" --roster out/lark_roster.json --doctor
    ;;
  gateway)
    ensure_env
    exec node gateway/server.mjs --office out/office.json --host 127.0.0.1 --port "$GW_PORT"
    ;;
  seed)
    ensure_env
    node seed/seed.mjs --app "$APP_URL" --gateway "http://127.0.0.1:$GW_PORT" --office out/office.json
    echo "로그인: famigo-office / \$FAMIGO_DESK_PASSWORD ($ENV_FILE)"
    ;;
  *)
    sed -n '2,11p' "$0"
    exit 1
    ;;
esac
