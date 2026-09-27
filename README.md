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

## Mac을 사무실 서버로 (설치 한 번)

Lark 수집 파이프라인, 자격증명, 데이터가 모두 이 Mac에 있으므로 **서버도 이 Mac**이다.
데이터는 Mac 밖으로 나가지 않는다.

```bash
git clone https://github.com/masigod/famigo_manage.git ~/famigo_manage && cd ~/famigo_manage
bash scripts/install-mac.sh
```

이 한 줄이 하는 일:

1. 전제를 확인한다. node 20 이상, python3, `~/famigo_campaign/briefs/data`,
   `~/.config/famigo/lark_credentials.json`이 있어야 한다.
2. 비밀값을 만든다. `~/.config/famigo/office.env`(0600)에 게이트웨이 토큰, 사무실 비밀번호,
   JWT 비밀을 둔다.
3. **Lark API로 실제 구성원 명단을 수집한다**(`office/lark_roster.py`).
   - 앱 `famigo_larkchat`이 들어가 있는 내부 방의 구성원을 합친다.
   - 봇 방, 외부 방, 해산된 방, 다른 테넌트 사람은 뺀다.
   - 메시지는 읽지 않는다. 읽는 것은 방 목록과 구성원 이름뿐이다(GET만 사용).
4. `office.json`을 만든다. **지금 Lark에 있는 사람 전원**이 직원이 되고, 직무와 팀은
   `people.json` L1과 이름이 맞을 때만 붙는다.
5. launchd에 서비스 셋을 등록한다. 로그인하면 자동으로 시작되고, 죽으면 다시 뜬다.
   - `life.famigo.office.deskrpg`: DeskRPG `v2026.927.1`, http://localhost:3000
   - `life.famigo.office.gateway`: Lark 게이트웨이, 127.0.0.1:8642(항상 로컬 전용)
   - `life.famigo.office.sync`: **매일 07:45와 13:45**에 명단 → 모델 → 배치를 돈다.
     07:00 브리핑 뒤에 돈다.
6. 첫 배치를 한다. 직원을 착석시키고 사무실과 보드 두 개를 만든다.

그다음 http://localhost:3000 에서 `famigo-office`로 로그인한다. 비밀번호는 `office.env`의
`FAMIGO_DESK_PASSWORD`다.

| 명령 | 용도 |
|---|---|
| `bash scripts/install-mac.sh --status` | 서비스, 응답, 데이터 기준 시각 점검 |
| `bash scripts/install-mac.sh --lan` | **같은 네트워크의 팀원도 접속하게 연다.** 실명이 보이는 사무실이라 신중히. 기본은 이 Mac에서만 접속 가능 |
| `bash scripts/office.sh doctor` | 원천 스키마 점검. 어떤 필드가 맞았는지, 명단과 people.json이 몇 명 겹치는지 |
| `bash scripts/office.sh sync` | 지금 바로 갱신 |
| `bash scripts/install-mac.sh --uninstall` | 서비스 제거. 데이터는 남긴다 |

로그는 `~/Library/Logs/famigo-office/`에 쌓인다.

**구성원 변화**
- Lark에 새로 들어온 사람은 다음 sync 때 직원으로 등록된다.
- Lark에서 사라진 사람은 퇴장한다.
- 한 번에 절반 넘게 사라지면 데이터 사고로 보고 **퇴장하지 않고 멈춘다.**
  확인한 뒤 `FAMIGO_ALLOW_MASS_RETIRE=1`로 다시 돌린다.
- 직원 키는 이름에서 만든다. 명단 수집이 하루 실패해도 같은 사람은 같은 자리에 남는다.

## 검증된 것과 아직 아닌 것

**검증됨** — 클라우드 샌드박스에서 DeskRPG `v2026.927.1`(SQLite 모드)을 실제로 띄우고 합성
픽스처로 확인했다.
- 게이트웨이가 DeskRPG의 probe를 통과해 "AI 연결"로 표시되고, 직원 4명이 출근·착석했다.
- 칸반의 두 보드(장부, 파이프라인)가 상태·경과일·담당·경고와 함께 표시된다.
- Syn을 호출하면 걸어와서 결정 대기와 방치 항목을 경과일과 함께 답한다.
- 카드 생성은 403 `read_only`로 거절되고, 그 사유가 사무실 화면에 전달된다.
- 시드를 두 번 실행해도 아무것도 새로 생기지 않는다(멱등).
- 테스트: `npm test` (Python 18, Node 10).
- Lark 명단 수집기는 공식 SDK(`larksuite/oapi-sdk-python`) 응답 모델 그대로 만든 가짜 서버로
  테스트했다. 페이지 넘김, 봇·외부·해산 방 제외, 외부 테넌트 제외, open_id와 비밀값 미저장,
  실패 시 기존 명단 보존을 확인했다. 새 직원 등록과 퇴장 처리는 실제 DeskRPG에서 확인했다.

**아직 아님** — 실제 Lark API와 데이터로는 돌려 보지 않았다. 클라우드 샌드박스에서는 Lark 도메인이
네트워크 정책으로 막혀 있다. 원천 파일(`people.json` 등)의 실제
필드명은 이 저장소 밖(Mac)에 있다.
- 빌더는 필드를 **후보 목록**으로 읽는다. `doctor`가 실제로 어떤 필드가 맞았는지 보고한다.
- 맞는 필드가 없으면 그 값은 비어 있게 된다. 추측으로 채우지 않는다.
- 첫 실행에서는 `doctor` 출력을 보고 필요하면 후보 목록(`office/build_office.py` 상단)을 고친다.

**DeskRPG 쪽에서 보이는 것**
- 칸반 상단의 "디스패처가 없어 카드가 자동으로 실행되지 않습니다" 배너는 **의도된 것**이다.
- 외부 그룹 4개(API 불가)와 Lark 밖(구두·전화·메일)은 원천에 없으므로 사무실에도 없다.

## 구조

```
office/lark_roster.py      Lark API → 실제 구성원 명단 (읽기 전용)
office/build_office.py     Lark 데이터층 + 명단 → office.json (게이트 · doctor)
gateway/server.mjs         Hermes/deskrpg 플러그인 계약 게이트웨이 (읽기 전용)
gateway/office-model.mjs   office.json → 칸반 카드
gateway/replies.mjs        직원·Syn 대화 (LLM 없음, 사실만)
seed/seed.mjs              DeskRPG REST 배치 (멱등)
seed/looks.mjs             DeskRPG 오피스 룩 50종 (deskrpg 소스에서 추출)
scripts/office.sh          roster · build · doctor · gateway · seed · sync
scripts/install-mac.sh     Mac 상시 서버 설치 (launchd)
tests/                     합성 픽스처 + 회귀 테스트 (가상 이름·가상 캠페인)
```
