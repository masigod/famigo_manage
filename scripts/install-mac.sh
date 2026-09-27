#!/usr/bin/env bash
# Famigo Office — 이 Mac 을 사무실 서버로.
#
#   bash scripts/install-mac.sh            # 설치·시작 (다시 돌려도 안전)
#   bash scripts/install-mac.sh --lan      # 같은 네트워크의 팀원도 접속 (실명이 보이는 사무실 — 신중히)
#   bash scripts/install-mac.sh --status   # 상태 점검
#   bash scripts/install-mac.sh --uninstall
#
# 띄우는 것 (launchd, 로그인하면 자동 시작 · 죽으면 재시작):
#   life.famigo.office.deskrpg   DeskRPG 3D 사무실         http://localhost:3000
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
UID_N="$(id -u)"

die() { echo "✗ $*" >&2; exit 1; }
ok() { echo "✓ $*"; }

unload_all() {
  for l in "${LABELS[@]}"; do
    launchctl bootout "gui/$UID_N/$l" 2>/dev/null || true
  done
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
  curl -fsS -o /dev/null http://127.0.0.1:3000/auth && ok "DeskRPG 응답" || echo "✗ DeskRPG 무응답"
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3101/ || true)
  [[ "$code" == "401" ]] && ok "관리자 웹 응답 (http://127.0.0.1:3101)" || echo "✗ 관리자 웹 무응답 ($code)"
  [[ -f "$ROOT/out/office.json" ]] && echo "  office.json 기준: $(python3 -c "import json;print(json.load(open('$ROOT/out/office.json'))['generated_at'])")"
  echo "  로그: $LOGS"
}

case "${1:-}" in
  --status) status; exit 0 ;;
  --uninstall)
    unload_all
    for l in "${LABELS[@]}"; do rm -f "$AGENTS/$l.plist"; done
    ok "서비스 제거 (데이터 ~/.deskrpg · $ENV_FILE · out/ 는 남겨 둠)"
    exit 0
    ;;
esac
LAN=0
[[ "${1:-}" == "--lan" ]] && LAN=1

# ── 0. 전제 ─────────────────────────────────────────────────────────────
[[ "$(uname)" == "Darwin" ]] || die "macOS 전용 스크립트다"
NODE="$(command -v node)" || die "node 가 없다 (brew install node)"
NPX="$(command -v npx)"
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
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# ── 2. 첫 데이터 — 명단 → 모델 (게이트웨이는 모델이 있어야 뜬다) ──────
"$PY" "$ROOT/office/lark_roster.py" --out "$ROOT/out/lark_roster.json" \
  || echo "  ⚠ Lark 명단 수집 실패 — people.json 만으로 진행 (위 사유 확인)"
"$PY" "$ROOT/office/build_office.py" --data-dir "$DATA_DIR" --config "$ROOT/config/office.config.json" \
  --roster "$ROOT/out/lark_roster.json" --out "$ROOT/out/office.json" \
  || die "office.json 생성 실패 — 'bash scripts/office.sh doctor' 로 원천 스키마부터 본다"

# ── 3. DeskRPG 런타임 (~/.deskrpg, SQLite) ─────────────────────────────
if [[ ! -f "$HOME/.deskrpg/data/deskrpg.db" ]]; then
  "$NPX" -y "deskrpg@$DESKRPG_VERSION" init
fi
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
  "<string>$NPX</string><string>-y</string><string>deskrpg@$DESKRPG_VERSION</string><string>start</string><string>-p</string><string>3000</string>" \
  "$(xml_env PATH "$PATH_FOR_AGENTS" HOSTNAME "$HOSTNAME_BIND" JWT_SECRET "$DESKRPG_JWT_SECRET" COOKIE_SECURE false)" \
  "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"

write_plist life.famigo.office.gateway \
  "<string>$NODE</string><string>$ROOT/gateway/server.mjs</string><string>--office</string><string>$ROOT/out/office.json</string><string>--host</string><string>127.0.0.1</string><string>--port</string><string>8642</string><string>--admin-port</string><string>3101</string>" \
  "$(xml_env PATH "$PATH_FOR_AGENTS" FAMIGO_GATEWAY_TOKEN "$FAMIGO_GATEWAY_TOKEN" FAMIGO_DESK_PASSWORD "$FAMIGO_DESK_PASSWORD" FAMIGO_DATA_DIR "$DATA_DIR" DESKRPG_URL http://127.0.0.1:3000)" \
  "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"

write_plist life.famigo.office.sync \
  "<string>/bin/bash</string><string>$ROOT/scripts/office.sh</string><string>sync</string>" \
  "$(xml_env PATH "$PATH_FOR_AGENTS" FAMIGO_DATA_DIR "$DATA_DIR" DESKRPG_URL http://127.0.0.1:3000)" \
  "<key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>45</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>45</integer></dict>
  </array>"

unload_all
for l in "${LABELS[@]}"; do launchctl bootstrap "gui/$UID_N" "$AGENTS/$l.plist"; done
ok "launchd 등록 (로그인 시 자동 시작)"

# ── 5. DeskRPG 가 뜨면 첫 배치 ─────────────────────────────────────────
echo -n "  DeskRPG 기동 대기"
for _ in $(seq 1 90); do
  curl -fsS -o /dev/null http://127.0.0.1:3000/auth 2>/dev/null && break
  echo -n "."; sleep 2
done
echo
curl -fsS -o /dev/null http://127.0.0.1:3000/auth || die "DeskRPG 가 안 뜬다 — $LOGS/life.famigo.office.deskrpg.log"
DESKRPG_URL=http://127.0.0.1:3000 bash "$ROOT/scripts/office.sh" seed

echo
ok "사무실 서버 가동"
echo "  열기:   http://localhost:3000   (로그인 famigo-office / 비밀번호는 $ENV_FILE 의 FAMIGO_DESK_PASSWORD)"
if (( LAN )); then
  ip=$(ipconfig getifaddr en0 2>/dev/null || true)
  echo "  팀원:   http://${ip:-<이 Mac 의 IP>}:3000  — 같은 네트워크에서. 각자 가입 후 사무실 비밀번호로 입장"
fi
echo "  관리:   http://127.0.0.1:3101   (아이디 admin · 비밀번호는 위와 같음) — 퇴장·복귀·표시 이름·직무·외형"
echo "  상태:   bash scripts/install-mac.sh --status"
