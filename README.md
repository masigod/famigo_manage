# Famigo Office — 아울러스의 Lark 업무가 살아 움직이는 3D 사무실

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
- **예외 층(2026-09-28 Dylan 결정): 사람별·관리자용 인사이트(`out/insights.json`).** 원문·리포트·L2·L3가 들어 있어
  게이트를 통과하지 않는다. 0600 로컬 파일이고, **인증된 대시보드와 1:1 대화만** 읽으며, 누가 무엇을 보는지는
  `gateway/access.mjs` 한 곳에서 정한다(아래 "대시보드와 개인별 반영").

## Famigo Office — 독립 서비스 구조 (2026-09-28)

팀원은 **Famigo Office**로 들어온다. 사무실 엔진(DeskRPG)은 이 Mac 안에 숨어 있다.

```
팀원 브라우저 ──▶ :3300 화면 · :3301 실시간   life.famigo.office.front  (front/server.mjs)
                        │  이름·문구·기본 언어(한국어)를 입힌다 · 외부 링크 버튼 숨김 · 내부 RPC(/_internal) 차단
                        ▼
                127.0.0.1:3310 · :3311       life.famigo.office.engine (DeskRPG — LAN 에 열리지 않는다)
```

- **이름을 입히되 DeskRPG 파일은 고치지 않는다.** DeskRPG는 Dante Labs의 **Sustainable Use License**다.
  - 내부 업무용 사용·수정은 허용된다.
  - **라이선스·저작권 표시를 가리면 안 되고, 수정했다는 고지를 눈에 띄게 달아야 한다.**
  - 그래서 앞단이 실행 중에만 화면을 입힌다. 저장소에는 DeskRPG 코드나 내용을 싣지 않는다.
  - 외형 목록도 설치 때 이 Mac의 엔진에서 추출해 `out/looks.json`에 둔다. 테스트는 합성 목록을 쓴다.
- **고지와 라이선스**: 로그인 화면 아래에 "Famigo Office는 Dante Labs의 DeskRPG를 수정해 사용합니다" 고지를 단다. 원본 라이선스 전문은 `/__famigo/license`로 제공한다. 원본의 저자 표시(`rel=author dante-labs.com`)와 저작권·라이선스 문구는 손대지 않는다(`front/brand.js`의 보호 규칙).
- **팀원 주소는 그대로다**(3300). 엔진은 입구 포트 + 10(3310)이다. 옛 서비스(`life.famigo.office.deskrpg`)는 재설치할 때 자동으로 내려간다.
- 이미지 속 건물 간판처럼 그림에 박힌 글자는 바꾸지 않는다(원본 작품).

## 캐릭터 매칭 — 말투·성향으로 외형을 고른다 (2026-09-28)

`office/persona.py`는 각자 **자기가 쓴 글**(15건 이상)에서 다음을 잰다.
- 말투: 격식체 · 해요체 · 반말 · 개조식(보고체) 비율
- 분위기: 이모지·웃음 빈도, 평균 길이
- 역할: 요청·결정 표현, 크리에이티브 어휘

이 값을 **팀 안의 상대 순위**로 바꿔 외형 분류(리더십·크리에이티브·캐주얼·클래식)와 자세(차분·밝음·편안)를 정한다. 그다음 같은 분류·몸형 중 겹치지 않는 외형을 고른다.

- **우선순위**: 관리자 웹에서 고른 외형 > 말투 분석 > 지금 외형. 관리자 웹 직원 행에 판정 근거가 뜬다(마우스를 올리면 수치).
- **성별(몸형)은 대화로 정하지 않는다.** 실측(2026-09-28): 17명·1만여 건 원문에서 이름 뒤 호칭(언니·형 등), 자기 지칭, L2·L3 분석문 속 성별 표현이 **모두 0건**이었다. 그래서 몸형은 **관리자 웹의 '몸형' 칸 > 지금 외형의 몸형** 순으로 정한다. 영어 닉네임으로 짐작하지 않는다.

## 외부 전송 차단 — FAMIGO 데이터는 이 Mac 밖으로 나가지 않는다 (2026-09-28)

사무실은 이 Mac 안의 로컬 모델로만 돈다. 바깥으로 허용되는 연결은 원천인 **Lark API**뿐이다.

| 프로세스 | 차단기 | 허용 목적지 |
|---|---|---|
| DeskRPG 서버 · 게이트웨이/관리자 웹/대시보드 · 시더 | `scripts/egress-guard.cjs` (`NODE_OPTIONS=--require`) | 루프백 · 이 Mac 의 IP |
| 명단 수집기 · 실시간 데몬 | `office/egress.py` (`socket.getaddrinfo`) | 루프백 · `*.larksuite.com` |

- **설정이 아니라 차단기로 막는다.** DeskRPG에는 끌 수 없는 외부 호출이 있다. GitHub 별 개수·릴리스 확인을 6시간마다 하고, 채팅 링크 미리보기는 채팅에 올라온 URL을 서버가 직접 가져간다. 차단기는 코드가 무엇을 하든 목적지로 막는다. 호스트 이름도 바깥 DNS로 나가지 않는다. 막힌 시도는 서비스 로그에 `[egress-guard] 차단: host:port`로 남는다.
- 실측(2026-09-28): 실제 DeskRPG에서 링크 미리보기(`example.com`)와 GitHub 호출(`api.github.com`)이 막혔다. 상단 GitHub 별 배지는 숫자 없이 보인다. Lark 장기 연결은 그대로 유지된다. 그 전까지 나간 외부 호출은 GitHub 별 개수 조회뿐이었고 Famigo 데이터는 없었다. 채팅 기록 0건이라 링크 미리보기는 한 번도 돌지 않았다.
- **차단기가 닿지 않는 것**
  - 설치 때 소프트웨어를 받는 `npm`(DeskRPG)·`pip`(lark-oapi) — 데이터를 보내지 않는다.
  - DeskRPG 관리 화면의 'Hermes 설치'(쉘 `curl`) — 이 사무실은 쓰지 않으니 누르지 않는다.
  - 사람이 직접 누르는 외부 링크(GitHub·피드백).
- DeskRPG 버전을 올리면 차단 기록(`grep egress-guard ~/Library/Logs/famigo-office/*.log`)으로 새 외부 호출이 생겼는지 본다.

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
5. 실시간 반영용 Python을 준비한다. `~/.famigo-office/venv`에 공식 SDK `lark-oapi 1.7.3`만 버전 고정으로 설치한다.
6. launchd에 서비스 셋을 등록한다. 로그인하면 자동으로 시작되고, 죽으면 다시 뜬다.
   - `life.famigo.office.deskrpg`: DeskRPG `v2026.927.1`, http://localhost:3300
     (내부적으로 3301도 쓴다. 3000은 이 Mac의 다른 프로그램이 쓰고 있다. 바꾸려면 `FAMIGO_DESK_PORT=3400 bash scripts/install-mac.sh`)
   - `life.famigo.office.gateway`: Lark 게이트웨이, 127.0.0.1:8642(항상 로컬 전용)
   - `life.famigo.office.live`: **실시간 반영 데몬**(`office/lark_live.py`). 아래 "실시간 반영" 참고.
     예전의 하루 두 번 예약 갱신(`life.famigo.office.sync`)을 대체하며, 재설치하면 옛 서비스는 자동으로 내려간다.
7. 첫 배치를 한다. 직원을 착석시키고 사무실과 보드 두 개를 만든다.

## 실시간 반영 — Lark가 바뀌면 사무실이 따라 바뀐다

```
Lark ──장기 연결(WebSocket, 공개 URL 불필요)──▶ lark_live.py ──office.sh(잠금)──▶ roster · build · seed
briefs/data 파일 · 관리자 설정 ──파일 감시(2초)──▶      │
10분마다 전체 대조 ─────────────────────────────▶      ▼
                                                  out/office.json
                                                        │ mtime 이 바뀌면 게이트웨이가 직전 판과 비교
                                                        ▼
                         /deskrpg/events (task.created · task.status · task.updated · task.deleted)
                                                        │ DeskRPG 가 5~60초마다 폴링
                                                        ▼
                         열린 칸반 갱신 · review/blocked/done 전환은 사무실 채팅에 공지
```

| Lark에서 일어난 일 | 사무실에 반영 | 걸리는 시간 |
|---|---|---|
| 방에 사람이 들어오거나 나감 (`im.chat.member.user.*`) | 그 방만 다시 읽음 → 새 직원 착석 / 퇴장 후보 표시 | 몇 초 + 엔진 확인(2~5초) |
| 방 이름 접두사 변경 (`im.chat.updated_v1`) | 파이프라인 카드 상태 이동 · 채팅 공지 | 몇 초 + 엔진 확인 |
| 방에 사람이 말함 (`im.message.receive_v1`) | 그 방의 조용한 기간 0일 → 좀비 해제 | 몇 초 + 폴링 |
| 07:00 브리핑이 장부·캠페인을 새로 씀 | 카드 생성·상태 이동 · 채팅 공지 | 몇 초 + 폴링 |
| 관리자 웹에서 저장 | 설정 반영 | 즉시 |
| 날짜가 바뀜 (경과일·방치) | 10분 대조 때 반영 | 최대 10분 |

- **메시지 원문도 받는다(2026-09-28 결정 — 개인별 반영).** 예약 루틴과 **같은 거름망**을 거친다. `briefs/tools`의 `lark_api._text_of`·`lark_store.SECRET_PAT`·`scrub_pii`·`is_bot`을 그대로 불러 쓴다. 자격증명·인증코드 패턴은 메시지째 폐기하고, 전화·이메일·주민·계좌는 부분 마스킹한다. 이 함수들을 못 불러오면 본문을 저장하지 않는다(fail-closed).
  - 저장은 `out/live/messages.jsonl`(파일 0600, 폴더 0700)에 한다. **예약 원문 층(`briefs/data/raw`)에는 쓰지 않는다**(주인은 브리핑). 07:00 수집 전까지의 보충이고, 14일 뒤 지운다.
  - 발신자는 명단 수집기와 같은 해시로 이름을 찾는다. open_id 원문은 남기지 않는다. 1:1·봇 발신·봇 방·외부 방·명단에 없는 방은 저장하지 않는다.
  - 방별 마지막 사람 발화 시각(`out/lark_activity.json`)은 좀비 판정에 쓴다.
- **SDK 로그는 INFO로 고정한다.** SDK는 DEBUG에서 이벤트 본문을 찍는다. INFO에서 찍히는 연결 URL의 `access_key`·`ticket`은 가려서 남긴다.
- **보드만 바뀌면 시더를 돌리지 않는다.** 게이트웨이가 `office.json`에서 바로 서빙한다. 직원 이름·외형·퇴장이 바뀔 때만 DeskRPG에 다시 배치한다.
- **실시간 데몬, 관리자 웹, 수동 실행은 같은 잠금(`out/.office.lock`)을 쓴다.** 시더 둘이 겹치지 않는다. 잠금을 쥔 프로세스가 죽었으면 다음 실행이 잠금을 치운다.
- 카드 이벤트 기록(`out/gateway-events.json`)은 재시작해도 이어진다. 커서 없는 첫 호출은 과거를 재생하지 않는다. 그래서 설치 직후 공지가 쏟아지지 않는다.

## 3D 사무실에 녹아든 업무 — 누가 지금 무엇을 하는가

직원을 누르면 오른쪽 '카드' 탭에 **그 사람의 실제 일**이 보인다. DeskRPG는 사무실 기본 보드를 담당자(assignee)로 걸러 이 탭을 채운다. 그래서 기본 보드에는 장부와 **업무 카드**가 함께 올라간다.

| 원천 | 카드 상태 | 3D 사무실에서 |
|---|---|---|
| 최신 일일보고(14일 이내)의 '진행 중' — 보고가 36시간 이내 | running | 이름표 **작업 중** |
| 같은 '진행 중'이지만 보고가 36시간보다 오래됨 | todo | — (옛 보고로 계속 일하는 척하지 않는다) |
| '막힘 · 이슈' | blocked | 사무실 채팅에 공지 |
| '지원 필요 · 협조 필요' | review (결정 대기) | 사무실 채팅에 공지 |
| '우선순위 High' · '다음 할 일' | todo | — |
| '오늘 한 일' | done | — |
| 30분 안에 Lark에서 발화 | running `지금 Lark · <방 이름>` | 이름표 **작업 중** (본문은 옮기지 않음) |

- 일일보고는 Lark의 공용 방(`일일업무` 등)에 팀이 함께 보라고 올린 글이라 보드에 오른다. 그 밖의 원문은 보드에 오르지 않는다.
- '작업 중'은 **기본 보드 카드만** 켠다. 캠페인이 '진행중'이라는 이유로 담당자가 몇 주씩 작업 중으로 보이면 신호가 죽는다. 파이프라인 카드는 담당을 본문에 적는다.
- 공용 대화(방·남이 묻는 1:1)에서도 직원은 보드에 오른 자기 일(진행 중·막힘·지원 요청)을 말한다.
- 5분마다 다시 짓는다. 그래서 '지금 Lark'(30분)와 '진행 중'(36시간)은 새 이벤트가 없어도 제때 꺼진다.

## 대시보드와 개인별 반영 — 예약 결과를 사람별로

**대시보드**: `http://<이 Mac>:3302` (사무실 포트 + 2). 사무실 로그인을 그대로 쓴다. 사무실(DeskRPG)의 로그인 쿠키를 DeskRPG와 같은 JWT 비밀로 검증한다. 쿠키는 포트를 가리지 않으므로 다시 로그인할 필요가 없다.

| 탭 | 팀원 | 관리자 (Dylan과 Dylan이 지정한 사람) |
|---|---|---|
| 내 일 | 자기 일일보고(한 일·진행 중·다음·우선순위·막힘·지원 요청), 자기 장부 항목·캠페인, 자기가 쓴 글·검색 | 같음 |
| 팀 현황 | 결정 대기·방치·좀비·파이프라인 (반출 게이트를 통과한 `office.json`) | 같음 |
| 문제 한눈에 | — | 각자 최신 일일보고의 막힘·지원 요청, 브리핑의 '오늘 결정할 것' |
| 사람별 | — | 모든 사람의 '내 일' + L2·L3(추론·미검증 배지) |
| 방 원문 | — | 모든 방 원문·검색 |
| 리포트 · 분석 | — | 브리핑·일간·주간·월간·종합 분석 (예약 루틴 산출물 그대로) |
| 브리핑 대시보드 | 공유판 | 전체판 (예약 루틴의 6탭, 스크립트를 막고 띄움) |

- **서버가 역할에 맞춰 자른 뒤에 보낸다.** 팀원의 응답에는 다른 사람의 원문이 애초에 들어 있지 않다(`tests/dashboard.test.mjs`).
- **권한은 관리자 웹의 "대시보드 계정 연결"로만 생긴다.** DeskRPG는 누구나 아무 닉네임으로 가입할 수 있으므로 닉네임으로는 권한을 주지 않는다. 예외는 사무실 소유자 계정(`famigo-office`) 하나로, 자동으로 Dylan·관리자다. 연결되지 않은 계정은 아무것도 보지 않는다.
  - 다른 관리자 온보딩: 그 사람이 사무실에 가입한다 → 이 Mac의 관리자 웹에서 그 계정을 Lark의 그 사람 · `관리자`로 연결한다.
- **사무실 직원과 1:1 대화도 같은 규칙이다.** DeskRPG가 1:1 세션 키(`…-dm-<userId>`)에 묻는 사람을 담아 보낸다. 본인이나 관리자가 물으면 그 사람의 최근 일일보고, 막힘, 장부 항목을 답한다. 남이 물으면 공용 답만 한다. **방·회의 대화는 모두가 보므로 언제나 공용 답이다.** Syn은 관리자에게 '오늘 결정할 것'과 전원의 막힘을, 팀원에게는 그 사람 자신의 일을 답한다.
- **기존 내역**: 예약 루틴이 1월부터 쌓은 원문(1,615파일 · 11,384건), 일일보고 321건, 리포트 341건을 그대로 읽는다. 일일보고는 실제 머리줄 빈도(오늘 업무·내일 업무·현재 막혀있는 부분·지원 필요: …)로 여섯 칸으로 나눈다. `이슈: 없음`처럼 '없음'인 항목은 세지 않는다.
- **갱신**: 원문, 리포트, 대시보드 HTML, 관리자 설정이 바뀌면 실시간 데몬이 인사이트를 다시 만든다(0.3초). 이벤트를 켰으면 새 메시지도 몇 초 안에 반영된다.

**경계 변경 기록**: 브리핑 스킬 §0.3·§7은 L2·L3·DM 본문·정산 금액·인사 판단을 "다른 수신자에게 DM으로도 나가지 않는 로컬 전용"으로 정했다. 2026-09-28 Dylan이 **"다른 관리자도 Dylan과 완전히 동일"**로 바꿨다. 이 저장소는 그 결정대로 관리자에게 전부를 보여 준다. 조직 동기화 스킬 문서(`lark-daily-brief`·`lark-weekly-analysis`·`lark-monthly-analysis`)의 해당 조항은 이 저장소가 고칠 수 없으니 스킬 쪽에서 맞춰야 한다.

### Lark 월 API 호출 한도 — 실시간 반영의 전제 (2026-09-28 사고)

Lark 앱에는 **월 API 호출 한도**가 있다. 같은 앱을 07:00 예약 브리핑도 쓴다.
- **사고**: 처음 설계는 10분마다 73개 방 구성원을 전부 다시 모았다(1회 약 75호출). 하루 만에 수천 호출을 썼고, 분당 메시지 폴링까지 더하자 한도가 다 찼다 — `99991403 This month's API call quota has been exceeded`. 이 상태에서는 예약 브리핑의 수집도 막힌다.
- **지금 규칙**
  - 모든 Lark 호출은 `office/lark_meter.py`를 지난다. 하루 예산은 100호출(`FAMIGO_LARK_DAILY_BUDGET`)이다. `99991403`을 한 번 보면 다음 달 1일까지 **아무것도 호출하지 않는다**(재시도 없음). 기록은 `out/lark_calls.json`에 남는다.
  - 대조(10분)는 **Lark를 부르지 않는다**(빌드만).
  - 전체 명단은 **7일에 한 번**, 설치 때도 24시간 안에 했으면 건너뛴다.
  - 구성원·방 이름 이벤트는 **그 방만** 다시 읽는다(방마다 2~3호출). 해산은 0호출이다.
  - 메시지 폴링은 없다. 한도 안에서 불가능하다(73방 × 1분 = 하루 10만 호출).
  - 장기 연결의 주소 조회(연결·재연결마다 1회)도 계량기를 지난다. SDK가 HTTP 거절에 120초마다 끝없이 재시도하는 고리를 끊는다.
- **실시간의 원천은 Lark 이벤트 푸시다.** 이벤트 전달은 API 호출이 아니라서 한도를 쓰지 않는다. 그래서 아래 콘솔 설정이 실시간 반영의 필수 조건이다.

### Lark 콘솔에서 한 번 켜야 하는 것 (Dylan)

이벤트가 꺼져 있어도 파일 감시와 10분 대조로 반영된다. 켜면 초 단위가 된다.

1. Lark 개발자 콘솔(open.larksuite.com)에서 앱 `famigo_larkchat`을 연다 → **Events & Callbacks → Event Configuration**
2. Subscription mode를 **Receive events through persistent connection**(장기 연결)으로 바꾸고 저장한다.
   저장하려면 연결이 살아 있어야 한다. `live` 서비스가 이미 연결해 두었다.
3. **Add events**로 아래 8개를 추가한다.
   - `im.message.receive_v1`
   - `im.chat.member.user.added_v1` · `im.chat.member.user.deleted_v1` · `im.chat.member.user.withdrawn_v1`
   - `im.chat.member.bot.added_v1` · `im.chat.member.bot.deleted_v1`
   - `im.chat.updated_v1` · `im.chat.disbanded_v1`
   콘솔이 권한을 더 요구하면 그 화면이 알려 주는 스코프를 추가한다.
4. **Version Management & Release**에서 새 버전을 발행한다.
5. 확인: `tail -f ~/Library/Logs/famigo-office/life.famigo.office.live.log`를 켜 두고 봇이 있는 방에서 말해 본다.
   `반영 시작 (발화)`가 찍히면 된다. 같은 방은 하루에 한 번만 찍힌다(조용한 기간은 일 단위다).

### LAN 접속과 서버 비밀 (2026-09-28 실측으로 고친 것)

- **실시간 소켓은 `사무실 포트 + 1`(3301)이다.** DeskRPG 브라우저 코드는 소켓을 `페이지 주소:포트+1`로 직접 붙는다. DeskRPG는 그 소켓 서버를 `INTERNAL_HOSTNAME`(기본 127.0.0.1)에 띄운다. 그래서 `--lan`이면 설치 스크립트가 3301도 같이 연다. 안 열면 팀원 화면이 "연결이 끊어졌습니다"에 머문다.
- **3301에는 DeskRPG 내부 RPC(`/_internal/*`)도 붙어 있다.** 그래서 전용 비밀 `DESKRPG_INTERNAL_RPC_SECRET`을 둔다. 로그인 서명 비밀(JWT)과는 분리한다. 비밀 없이 부르면 403이다.
- **DeskRPG는 저장 토큰도 이 비밀로 암호화한다.** 그래서 비밀을 바꾸면 기존 토큰을 풀 수 없다(칸반 500). 설치 스크립트는 DeskRPG를 내린 상태에서 `seed/rekey.mjs`로 토큰을 새 키로 옮긴다. 멱등이고, 먼저 백업(0600)하고, 한 트랜잭션으로 처리한다.
- **DeskRPG는 계정당 한 세션만 허용한다.** 같은 계정으로 두 곳에서 들어가면 먼저 들어간 쪽이 튕긴다(`session:kicked`). 팀원은 각자 가입한 계정으로 들어온다.

### 알려진 한계

- **퇴장은 열린 화면에 바로 반영되지 않는다.** DeskRPG가 REST로 삭제된 NPC를 열린 지도에 알리는 경로를 두지 않았다. 고용은 서버가 알린다. 퇴장은 관리자가 가끔 정하는 일이므로, 보고 있는 사람은 새로고침하면 된다.
- 외부 방과 1:1 대화는 Lark API 구조상 이벤트를 받을 수 없다(브리핑과 같은 한계).

그다음 http://localhost:3300 에서 `famigo-office`로 로그인한다. 비밀번호는 `office.env`의
`FAMIGO_DESK_PASSWORD`다.

| 명령 | 용도 |
|---|---|
| `bash scripts/install-mac.sh --status` | 서비스, 응답, 데이터 기준 시각 점검 |
| `bash scripts/install-mac.sh --lan` | **같은 네트워크의 팀원도 접속하게 연다.** 실명이 보이는 사무실이라 신중히. 기본은 이 Mac에서만 접속 가능 |
| `bash scripts/office.sh doctor` | 원천 스키마 점검. 어떤 필드가 맞았는지, 명단과 people.json이 몇 명 겹치는지 |
| `bash scripts/office.sh shape` | 원천 파일의 구조만 출력. 값과 이름은 가려서 채팅에 붙여도 된다 |
| `bash scripts/office.sh sync` | 지금 바로 전체 갱신 (명단 → 모델 → 배치) |
| `bash scripts/office.sh apply` | 모델 → 배치 (관리자 웹이 쓰는 것) |
| `bash scripts/office.sh live` | 실시간 데몬을 앞에서 실행 (디버깅용. 평소에는 launchd가 띄운다) |
| `bash scripts/install-mac.sh --uninstall` | 서비스 제거. 데이터는 남긴다 |

로그는 `~/Library/Logs/famigo-office/`에 쌓인다(0700). 실시간 반영은 `life.famigo.office.live.log`에 남는다.

### 관리자 웹: http://127.0.0.1:3101

- **로그인 없음.** 이 Mac에서 Dylan만 쓴다. 대신 두 겹으로 막는다.
  - `127.0.0.1`에만 열려서 LAN에서는 연결 자체가 안 된다.
  - Host가 `127.0.0.1`·`localhost`가 아니면 거절한다. 로그인 없는 로컬 관리 화면을 악성 페이지가 DNS 리바인딩으로 조작하는 것을 막는다.
- **할 수 있는 것**
  - 퇴장과 복귀. Lark에는 영향이 없다.
  - 표시 이름, 직무, 팀, 외형(50종) 지정.
  - 저장하면 바로 사무실에 반영된다.
- **정본의 분담**
  - 명단은 Lark가 정본이다. 관리자 웹은 사무실에 앉힐지와 보이는 모습만 정한다.
  - 관리자 웹이 고친 내용은 `config/office.config.json`에 남는다(로컬 전용).
- **직무와 팀은 여기서만 정한다.** `people.json`의 L1은 활동 통계라 직무 필드가 없다.
  최근 발화일과 일일보고 횟수는 L1에서 가져와 보여 준다.
- **퇴장은 사람이 정한다.** 자동으로 지우는 경우는 두 가지뿐이다.
  - 관리자가 퇴장시킨 사람.
  - 플레이어 본인. 아바타로 이미 사무실에 있기 때문이다.
- **Lark 명단에서 사라진 사람**은 지우지 않고 **퇴장 후보**로 보여 준다. 관리자가 확정해야 나간다.
- **외형은 한 번 정해지면 유지된다.** 새로 들어온 사람만 비어 있는 외형을 자동으로 받는다.
- **접속 범위**: 관리자 웹은 설정을 바꾸는 창구라서, `--lan`으로 설치해도 **항상 이 Mac에서만** 열린다.
- 기존 설치에서 업데이트할 때는 `git pull && bash scripts/install-mac.sh`를 한 번 다시 돌린다.
  게이트웨이 서비스에 관리자 웹 설정이 들어가야 하기 때문이다.

## 검증된 것과 아직 아닌 것

**검증됨** — 클라우드 샌드박스에서 DeskRPG `v2026.927.1`(SQLite 모드)을 실제로 띄우고 합성
픽스처로 확인했다.
- 게이트웨이가 DeskRPG의 probe를 통과해 "AI 연결"로 표시되고, 직원 4명이 출근·착석했다.
- 칸반의 두 보드(장부, 파이프라인)가 상태·경과일·담당·경고와 함께 표시된다.
- Syn을 호출하면 걸어와서 결정 대기와 방치 항목을 경과일과 함께 답한다.
- 카드 생성은 403 `read_only`로 거절되고, 그 사유가 사무실 화면에 전달된다.
- 시드를 두 번 실행해도 아무것도 새로 생기지 않는다(멱등).
- 테스트: `npm test` (Python 59, Node 49).
- 관리자 웹은 실제 DeskRPG에 연결해 확인했다. 화면에서 직무와 외형을 저장하고 한 명을 퇴장시키면,
  설정 파일, 빌드, 배치, NPC 제거까지 이어진다. 다른 사람의 외형은 유지된다.
- Lark 명단 수집기는 공식 SDK(`larksuite/oapi-sdk-python`) 응답 모델 그대로 만든 가짜 서버로
  테스트했다. 페이지 넘김, 봇·외부·해산 방 제외, 외부 테넌트 제외, open_id와 비밀값 미저장,
  실패 시 기존 명단 보존을 확인했다. 새 직원 등록과 퇴장 처리는 실제 DeskRPG에서 확인했다.

**실데이터** — Mac에서 실제로 설치했다. Lark 명단 20명, 방 73개, 장부 102건을 읽었다.
`shape` 출력으로 원천 구조를 확인한 뒤 빌더를 그 구조에 맞췄다.
- 레코드는 `people`·`rooms`·`campaigns` 래퍼 키 아래에 있다.
- 방의 마지막 발화는 `rooms[].last_seen`이다.
- 오탐 캠페인 목록은 `campaigns._manual.exclude`다.
- 테스트 픽스처도 같은 구조로 만들었다(값은 가상). 원천 파일(`people.json` 등)의 실제
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
office/lark_live.py        실시간 반영 데몬 (장기 연결 이벤트 · 원문 수신 · 파일 감시 · 10분 대조)
office/build_insights.py   원문 + 예약 산출물 → 사람별·관리자용 인사이트 (로컬 전용 0600)
gateway/access.mjs         누가 무엇을 보는가 (DeskRPG JWT 검증 · 계정 연결 · 역할)
gateway/personal.mjs       직원 1:1 대화의 개인화
dashboard/server.mjs       대시보드 (:3302) — 역할에 맞춰 자른 응답
dashboard/page.mjs         대시보드 화면 (외부 리소스 0 · textContent 전용)
seed/rekey.mjs             DeskRPG 저장 토큰 재암호화 (서버 비밀 교체 시)
scripts/egress-guard.cjs   외부 연결 차단기 (Node — DeskRPG·게이트웨이)
scripts/extract-looks.mjs  설치된 엔진에서 외형 목록 추출 → out/looks.json (저장소에 싣지 않음)
front/server.mjs           Famigo Office 입구 (:3300 화면 · :3301 실시간 → 이 Mac 안의 엔진)
front/brand.js · brand.css 화면 입히기 (라이선스·저작권 표시 보호 · 수정 고지)
office/persona.py          말투·성향 → 외형 매칭
office/lark_meter.py       Lark API 호출 계량기 (하루 예산 · 월 한도 초과 시 다음 달까지 중단)
office/egress.py           외부 연결 차단기 (Python — Lark 만 허용)
office/daily_report.py     일일보고 파서 · 최근 원문 (대시보드·업무 카드 공용)
office/build_office.py     Lark 데이터층 + 명단 + 실시간 발화 시각 → office.json (게이트 · doctor)
gateway/server.mjs         Hermes/deskrpg 플러그인 계약 게이트웨이 (읽기 전용)
gateway/events.mjs         office.json 판 사이 카드 변화 → /deskrpg/events
gateway/office-model.mjs   office.json → 칸반 카드
gateway/replies.mjs        직원·Syn 대화 (LLM 없음, 사실만)
seed/seed.mjs              DeskRPG REST 배치 (멱등)
seed/looks.mjs             DeskRPG 오피스 룩 50종 (deskrpg 소스에서 추출)
scripts/office.sh          roster · build · doctor · gateway · seed · apply · sync · live (잠금 공유)
scripts/install-mac.sh     Mac 상시 서버 설치 (launchd)
tests/                     합성 픽스처 + 회귀 테스트 (가상 이름·가상 캠페인)
```
