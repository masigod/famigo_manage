# Famigo Office — Lark 브리핑을 3D 사무실로

아울러스 Lark 브리핑 파이프라인(`lark-daily-brief` 예약 루틴)이 매일 쌓는 데이터층을
[DeskRPG](https://github.com/dandacompany/deskrpg) 3D 가상 사무실로 보여 주는 다리.

- **Lark 구성원**은 사무실 **직원(NPC)**이 되어 자리에 앉는다.
- **To-do 장부**(`todos.jsonl`)는 사무실 **칸반 보드**가 된다.
- **캠페인 파이프라인**(방 이름 접두사)은 두 번째 보드가 된다.
- **Syn**(브리핑 분석가)에게 말을 걸면 오늘 결정할 것, 파이프라인, 방 위생을 답한다.

## 왜 이런 구조인가

DeskRPG는 직원과 칸반을 **Hermes 에이전트 게이트웨이**를 통해서만 본다. 진짜 Hermes를 붙이면
두 가지가 틀어진다.

1. **카드가 만들어지는 순간 에이전트가 일을 시작한다**(DeskRPG `createTask` → `dispatch`).
   장부 항목이 에이전트 작업으로 바뀌면 안 된다.
2. **Lark가 정본이다.** 사무실에서 카드를 옮겨도 Lark는 바뀌지 않는다. 두 곳이 어긋나면 둘 다
   못 믿게 된다.

그래서 이 저장소는 **Lark 데이터를 Hermes 플러그인 계약 모양으로 서빙하는 읽기 전용
게이트웨이**를 둔다. LLM 키도 에이전트 실행 비용도 필요 없다.

```
~/famigo_campaign/briefs/data/          (Lark 브리핑이 매일 쌓는 층 — 정본)
  people.json · rooms.json · todos.jsonl · campaigns.json · lark_daily.jsonl
        │  office/build_office.py   L1만 읽기 · 봇/DM 제외 · export_for_slack() 게이트 (fail-closed)
        ▼
out/office.json                          (로컬 전용, 0600, gitignore)
        │  gateway/server.mjs       Hermes + deskrpg 플러그인 0.6.0 계약 · 읽기 전용 · 127.0.0.1
        ▼
DeskRPG (npx deskrpg start)              3D 사무실 · 칸반 · 사무실 채팅
        ▲
        └─ seed/seed.mjs            직원·사무실·보드 배치 (멱등)
```

## 무엇이 무엇이 되나

| Lark 데이터 | DeskRPG | 규칙 |
|---|---|---|
| `people.json` L1 (이름·직무·팀) | 직원 NPC 1명 | L2·L3는 키째 읽지 않는다. `active:false`면 제외 |
| — | 직원 **Syn** | 브리핑 분석가. `include_syn:false`면 제외 |
| `todos.jsonl` (id별 마지막 전이) | 기본 보드 카드 | **행이 아니라 키를 센다** |
| `kind=decision` 열림 | `review` (결정 대기) | 사람이 정할 자리 |
| `blocked` | `blocked` | |
| 그 밖의 열림 | `todo` | 7일 이상이면 경고 표시와 우선순위 high |
| `resolved` | `done` | |
| `closed_wrong` · `superseded` | `archived` | 지우지 않고 보관 |
| 장부 `owner` | 카드 담당자 | 직원 이름이나 별칭과 맞을 때만. **추측으로 채우지 않는다** |
| `준비중 -` | `scheduled` | 방 이름 접두사가 곧 상태다 (§3.2) |
| `진행중 -` | `running` | |
| `대기 -` | `blocked` | |
| `종료 -` · `완료(…)` | `done` | |
| `Cancel -` | `archived` | |
| 진행중·준비중인데 21일 이상 조용 | 🔴 좀비 표시 | 조용한 기간을 모르면 `미확인`으로 둔다. 0으로 채우지 않는다 |

## 경계 (lark-daily-brief §0 승계)

- **public 저장소다.** 코드와 합성 픽스처만 올린다. 실데이터(`out/`)와 구성원 설정
  (`config/office.config.json`), 토큰은 gitignore 대상이고 Mac 로컬에만 둔다.
- 빌더는 산출물 전체를 **`lark_store.export_for_slack()`**에 통과시킨다. 게이트를 못 찾거나
  반환 모양이 이상하면 **파일을 쓰지 않고 exit 3으로 멈춘다.**
- 봇 방(`봇`·`chatbot`, 2FA 코드가 흐름)과 DM(`dm_*`)은 통째로 제외한다.
- 게이트웨이는 `127.0.0.1`에만 바인딩한다. 카드 생성·이동·댓글 같은 모든 쓰기는
  `403 read_only`로 거절한다.
- 직원의 대화는 `office.json`에 있는 사실만 말한다. 없는 것은 "없음"이 아니라
  "기록 없음/이 창에 없음"으로 말한다.

## Mac에서 띄우기

```bash
git clone https://github.com/masigod/famigo_manage.git ~/famigo_manage && cd ~/famigo_manage

# 0) 원천 스키마 점검 — 이 저장소는 원천 스키마를 소유하지 않는다. 먼저 무엇이 맞는지 본다.
bash scripts/office.sh doctor

# 1) (선택) 구성원별 외형·별칭 설정
cp config/office.config.example.json config/office.config.json   # 로컬 전용

# 2) DeskRPG — 한 번 init, 이후 start
npx deskrpg init && npx deskrpg start          # http://localhost:3000

# 3) 오피스 모델 → 게이트웨이 → 배치
bash scripts/office.sh build
bash scripts/office.sh gateway                 # 별도 터미널에 계속 띄워 둔다
bash scripts/office.sh seed                    # 로그인 정보가 ~/.config/famigo/office.env 에 생긴다
```

브라우저에서 `http://localhost:3000`을 열고 `famigo-office`로 로그인하면 **아울러스 · Famigo**
사무실이 있다.

**매일 갱신**: 게이트웨이는 `out/office.json`의 수정 시각이 바뀌면 재시작 없이 다시 읽는다.
그래서 브리핑 루틴의 대시보드 재생성 단계 뒤에 아래 한 줄만 붙이면 사무실이 매일 아침 바뀐다.

```bash
bash ~/famigo_manage/scripts/office.sh build
```

## 검증된 것과 아직 아닌 것

**검증됨** — 클라우드 샌드박스에서 DeskRPG `v2026.927.1`(SQLite 모드)을 실제로 띄우고 합성
픽스처로 확인했다.
- 게이트웨이가 DeskRPG의 probe를 통과해 "AI 연결"로 표시되고, 직원 4명이 출근·착석했다.
- 칸반의 두 보드(장부, 파이프라인)가 상태·경과일·담당·경고와 함께 표시된다.
- Syn을 호출하면 걸어와서 결정 대기와 방치 항목을 경과일과 함께 답한다.
- 카드 생성은 403 `read_only`로 거절되고, 그 사유가 사무실 화면에 전달된다.
- 시드를 두 번 실행해도 아무것도 새로 생기지 않는다(멱등).
- 테스트: `npm test` (Python 10, Node 9).

**아직 아님** — 실제 Lark 데이터로는 돌려 보지 않았다. 원천 파일(`people.json` 등)의 실제
필드명은 이 저장소 밖(Mac)에 있다.
- 빌더는 필드를 **후보 목록**으로 읽는다. `doctor`가 실제로 어떤 필드가 맞았는지 보고한다.
- 맞는 필드가 없으면 그 값은 비어 있게 된다. 추측으로 채우지 않는다.
- 첫 실행에서는 `doctor` 출력을 보고 필요하면 후보 목록(`office/build_office.py` 상단)을 고친다.

**DeskRPG 쪽에서 보이는 것**
- 칸반 상단의 "디스패처가 없어 카드가 자동으로 실행되지 않습니다" 배너는 **의도된 것**이다.
- 외부 그룹 4개(API 불가)와 Lark 밖(구두·전화·메일)은 원천에 없으므로 사무실에도 없다.

## 구조

```
office/build_office.py     Lark 데이터층 → office.json (게이트 · doctor)
gateway/server.mjs         Hermes/deskrpg 플러그인 계약 게이트웨이 (읽기 전용)
gateway/office-model.mjs   office.json → 칸반 카드
gateway/replies.mjs        직원·Syn 대화 (LLM 없음, 사실만)
seed/seed.mjs              DeskRPG REST 배치 (멱등)
seed/looks.mjs             DeskRPG 오피스 룩 50종 (deskrpg 소스에서 추출)
scripts/office.sh          build · doctor · gateway · seed
tests/                     합성 픽스처 + 회귀 테스트 (가상 이름·가상 캠페인)
```
