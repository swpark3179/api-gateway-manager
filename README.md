# API Gateway 관리자

APISIX Admin API 기반 **Windows 데스크톱 앱** (Tauri 2 + React 19 + TypeScript).
Route / Consumer 관리와 Consumer용 JWT 토큰 발급·조회가 주 용도다.
OAS 3.0 스펙을 읽어 "이 API 가 게이트웨이에 등록돼 있는지" 대조하는 Import 화면도 있다.

화면은 Claude Design 프로젝트 `05e631b1` 의 설계를 그대로 구현했다.

---

## 빠른 시작

```bash
npm install
npm run tauri dev        # 개발 실행
npm run tauri build      # 릴리스 빌드 (MSI · NSIS)
cargo test --lib --manifest-path src-tauri/Cargo.toml   # 회귀 테스트 (25건)
npm run build                                          # tsc --noEmit + vite build
```

첫 실행 시 **설정** 화면에서 환경별 `baseUrl` 과 관리 토큰(X-API-KEY)을 등록해야 한다.
토큰이 없는 환경은 잠금 화면이 뜨고 조회·변경이 막힌다.

---

## 프록시 우회 — 이 앱의 핵심 제약

사내 PC 에 시스템 프록시가 걸려 있어도 게이트웨이 통신은 **반드시 직접(non-proxy)** 나가야 한다.
"조심해서 지키기"가 아니라 구조로 강제했다.

| 방어선 | 위치 |
|---|---|
| `reqwest::ClientBuilder::no_proxy()` — 시스템 프록시 자동탐지와 `HTTP(S)_PROXY` 환경변수를 모두 무시 | `src-tauri/src/apisix/client.rs` `build()` |
| reqwest 클라이언트 생성 지점을 위 함수 하나로 통일 (다른 곳에서 `Client::new()` 금지) | 〃 |
| 웹뷰의 외부 통신을 CSP 로 차단 → 프런트에서 게이트웨이를 fetch 하면 즉시 에러 | `src-tauri/tauri.conf.json` `security.csp` |
| `tauri-plugin-http` 미도입 — 프런트에 우회 경로 자체를 만들지 않음 | `src-tauri/Cargo.toml` |
| OAS 스펙 URL 조회도 같은 `build()` 를 타되, 우회 여부는 Import 화면에서 따로 고른다 | `client.rs` `fetch_text()` |
| 웹폰트를 전부 로컬 번들 (Google Fonts `@import` 제거) | `src/styles/colors_and_type.css` |

### 검증

`cargo test` 의 `proxy::no_proxy_bypasses_env_proxy` 가 이걸 실측한다:
로컬 스텁 서버를 띄우고 `HTTP_PROXY` 를 아무도 듣지 않는 주소로 지정한 뒤,

- `no_proxy = true` → 직접 연결되어 **200 응답** (우회 성공)
- `no_proxy = false` → 죽은 프록시로 가서 **실패** (토글이 실제로 동작함)

실제 PC 에서 확인하려면:

```powershell
netsh winhttp set proxy 127.0.0.1:9
$env:HTTPS_PROXY = "http://127.0.0.1:9"
npm run tauri dev
# → 설정 화면 '연결 테스트'가 200 OK 를 반환하면 통과
netsh winhttp reset proxy
```

WebView2 DevTools 의 Network 탭에 게이트웨이 요청이 **하나도 보이지 않아야** 정상이다
(모두 IPC 를 타고 Rust 로 넘어간다).

---

## 구조

```
src/                        프런트엔드 (React 19 + TS + zustand)
├─ App.tsx                  38px 타이틀바 + [64px 레일 | 232px 패널 | 본문] 셸
├─ store.ts                 디자인의 DCLogic 상태 트리를 1:1 이식
├─ api.ts                   Rust 커맨드 래퍼 — 게이트웨이 HTTP 의 유일한 통로
├─ lib/design.ts            디자인 원본의 순수 헬퍼 (JSON 모양 · 아이콘 · 스타일)
├─ styles/                  OPUS-X 토큰 CSS (디자인 원본을 그대로 복사)
├─ components/              TitleBar · IconRail · SidePanel · Toast · BootProgress · GroupCombo · MetaList · ErrorBanner
└─ screens/                 Locked · Dashboard · List · Upstreams · Services · Import · Settings · edit/*

src-tauri/src/
├─ lib.rs                   플러그인/커맨드 등록, 창 셋업
├─ commands.rs              IPC 커맨드 전부
├─ config.rs                환경 설정 + Windows 자격 증명 관리자(토큰)
├─ apisix/client.rs         ★ no_proxy HTTP 클라이언트 (단일 진입점)
├─ apisix/{routes,consumers,services,upstreams,meta,models}.rs
├─ db.rs                    Route·Consumer·Upstream·Service 목록 · 접근 권한 조인 · Import 비교용 메모리 SQLite
├─ oas.rs                   OAS 3.0 파싱 + uri 정규화 (순수 함수)
├─ jwt.rs                   HS256 서명
├─ history.rs               대시보드 "최근 관리 API 호출" 이력
├─ win/mod.rs               Snap Layouts · 라운드 코너 (WM_NCHITTEST 서브클래스)
└─ tests.rs                 회귀 테스트
```

---

## Windows 네이티브 창 처리

디자인의 38px 커스텀 다크 타이틀바를 유지하기 위해 `decorations: false` 로 띄우되,
네이티브 동작은 HWND 를 서브클래싱해 보강했다 (`src-tauri/src/win/mod.rs`).

| 동작 | 구현 |
|---|---|
| **Snap Layouts** (최대화 버튼 호버 → 레이아웃 팝업) | `WM_NCHITTEST` 가 버튼 위에서 `HTMAXBUTTON` 반환 |
| 버튼 하이라이트 | Rust → 프런트 `window://max-button-hover` 이벤트 |
| 에어로 스냅 · 드래그 · 더블클릭 최대화 | `data-tauri-drag-region` |
| 4변·4모서리 리사이즈 | tao 기본 (서브클래스가 `DefSubclassProc` 로 위임) |
| Win11 라운드 코너 | `DWMWA_WINDOW_CORNER_PREFERENCE` |
| 창 위치·크기·최대화 상태 기억 | `tauri-plugin-window-state` |
| 중복 실행 방지 | `tauri-plugin-single-instance` |

---

## APISIX Admin API 매핑

경로 접두사 `{baseUrl}/apisix/admin`, 헤더 `X-API-KEY`.
응답은 v3(`{total, list:[{key,value}]}`) 기준이며 v2(`{node:{nodes:[…]}}`)도 흡수한다.

| 화면 동작 | 호출 |
|---|---|
| Route 목록 · 리프레시 | `GET /routes` (→ 내장 SQLite 갱신, 아래 절) |
| Route 신규 | `POST /routes` — id 를 비워 APISIX 가 자동 생성 |
| Route 수정 | `PUT /routes/{id}` |
| Route 삭제 | `DELETE /routes/{id}` |
| Consumer 목록 | `GET /consumers` |
| Consumer 저장 (신규·수정 공통) | `PUT /consumers` (본문에 username) |
| Consumer 삭제 | `DELETE /consumers/{username}` |
| Upstream 목록 · 동기화 | `GET /upstreams` (→ 내장 SQLite 갱신) |
| Upstream 신규 · 수정 · 삭제 | `POST /upstreams`, `PUT /upstreams/{id}`, `DELETE /upstreams/{id}` |
| Service 목록 · 동기화 | `GET /services` (→ 내장 SQLite 갱신) |
| Service 신규 · 수정 · 삭제 | `POST /services`, `PUT /services/{id}`, `DELETE /services/{id}` |
| 대시보드 KPI | `GET /services`, `GET /upstreams` (건수만 — 라이브 실측) |

### 플러그인 보존

디자인의 `routeJson()` 은 `plugins` 를 통째로 교체한다. 그대로 구현하면 게이트웨이에
이미 붙어 있던 `limit-count` 같은 플러그인이 저장 시 **사라진다**.

그래서 저장 직전 원본을 GET 해 와 앱이 관리하는 키만 덮어쓰는 **머지 방식**으로 처리한다:

- Route → `proxy-rewrite.uri`, 그룹 필드(기본 `shi-auth.allowed_groups`)
- Consumer → `jwt-auth.key`, `jwt-auth.secret`, 그룹 필드(기본 `jwt-auth.auth-groups`)
- Service → `shi-log.key`, `jwt-auth`(**없을 때만** `{}` 추가), `labels.spec_url`
- Upstream → `name`, `desc`, `nodes`, `timeout` (`checks`·`retries`·`scheme`·`type` 은 보존)

그룹 필드의 실제 위치는 조회 때 찾아낸 자리를 그대로 쓴다 — 아래 절 참조.

같은 플러그인 안의 다른 필드(`proxy-rewrite.headers`, `jwt-auth.algorithm` 등)도 보존된다.
회귀 테스트: `route_save_preserves_unknown_plugins`, `consumer_save_preserves_jwt_auth_extras`.

**저장 전 GET 이 실패하면 저장 자체를 중단한다.** 빈 객체로 머지를 진행하면 플러그인을
지키려고 만든 경로가 오히려 전부 날려버리게 되므로, 조용한 실패를 허용하지 않고
"저장 전 원본을 읽지 못해 중단했습니다" 로 알린다.

JSON 탭은 디자인대로 **앱이 관리하는 키만** 보여준다. 거기 없는 플러그인도 저장 시 유지된다.

### auth-groups 를 어디에 넣어 뒀든 찾아 읽는다

이 앱 밖에서 등록된 Route/Consumer 는 그룹 필드의 표기가 다를 수 있다. 표준 위치만 보면
게이트웨이에는 값이 있는데 화면은 공란으로 보인다. 그래서 **읽기는 관대하게, 쓰기는 읽은 그 자리에**
를 규칙으로 삼았다 (`src-tauri/src/apisix/models.rs` `find_groups` · `set_groups_at`).

찾는 순서 — 각 단계에서 `auth-groups` / `auth_groups` / `authGroups` / `allowed_groups` /
`allowed-groups` / `groups` 를 모두 훑는다:

1. 해당 리소스가 원래 쓰는 플러그인 (Consumer → `jwt-auth`, Route → `shi-auth`)
2. 나머지 플러그인 전부
3. 최상위 필드

값이 **있는** 자리를 우선한다. 표준 위치가 빈 배열이고 값은 다른 곳에 있으면 값이 있는 쪽을 택한다.
값의 형태도 배열 · `"a,b"` 콤마 문자열 · 숫자 배열을 모두 받아들인다.

저장할 때는 **찾은 그 자리에, 찾은 그 형태로** 되쓴다. 표준 위치로 "정규화"하면 기존 키가 남아
둘로 갈라지고, 배열↔문자열 타입을 바꾸면 게이트웨이 스키마 검증에 걸리기 때문이다.
회귀 테스트: `finds_auth_groups_in_nonstandard_places`, `saves_auth_groups_back_to_where_they_were_found`.

실제로 어디에 들어 있는지는 화면에서 확인할 수 있다:

- **상세 → JSON 탭 → `게이트웨이 원본`** — Admin API 가 돌려준 객체 그대로 (읽기 전용)
- 같은 탭 하단과 그룹 편집 카드 제목에 `plugins.jwt-auth.auth_groups` 처럼 **찾아낸 위치**를 표시


---

## 목록 — 내장 SQLite 캐시

목록 화면은 게이트웨이를 부르지 않는다. `GET /routes` · `GET /consumers` 결과를
**메모리 SQLite**(`Connection::open_in_memory()`, `src-tauri/src/db.rs`)에 통째로 넣고,
검색어·chip·컨슈머 필터를 SQL 로 처리한다. 예전에는 프런트가 배열을 들고 매 키 입력마다
`JSON.stringify(route)` 를 훑었다 — 라우트가 수백 건이면 눈에 띄게 느려지고, Import 의 등록
여부 판정은 (스펙 오퍼레이션 수) × (라우트 수) 번 비교가 된다. uri 를 정규화해 인덱스로
만들면 둘이 같이 풀린다.

### 채우기와 읽기를 나눈다

| 커맨드 | 게이트웨이 호출 | 하는 일 |
|---|---|---|
| `routes_sync` | O | Route 전체 재조회 → 캐시 전면 교체 (건수만 반환) |
| `consumers_sync` | O | Consumer 전체 재조회 → 캐시 전면 교체 → 목록 반환 |
| `routes_query` | X | 캐시 조회 (chip · 검색어 · 컨슈머) |
| `consumers_cached` | X | 캐시의 Consumer 전체 목록 |
| `route_cached` | X | 캐시에서 단건 (Import 결과 → 상세 이동) |
| `consumer_access_counts` | X | 컨슈머별 접근 가능 Route 수 (좌측 패널) |
| `upstreams_sync` | O | Upstream 전체 재조회 → 캐시 전면 교체 → 목록 반환 |
| `upstreams_cached` | X | 캐시의 Upstream 전체 목록 |
| `services_sync` | O | Service 전체 재조회 → 캐시 전면 교체 → 목록 반환 |
| `services_cached` | X | 캐시의 Service 전체 목록 (`service_id` 셀렉트 · Import 의 spec_url) |

sync 가 조회 결과를 돌려주지 않는 이유: 조회 축이 셋(chip · 검색어 · 컨슈머)이라 채우기에
필터를 실어 보내면 호출부마다 세 인자를 끌고 다녀야 한다. 메모리 SQLite 라 왕복 비용이 없으니
프런트가 sync → query 를 이어 부른다.

캐시를 채우는 경로는 두 가지다.

- **부트스트랩** (`store.bootstrap`) — 기동, 환경 전환, 상단 새로고침 버튼.
  Route → Consumer → **Upstream → Service** → 접근 권한 집계 다섯 단계를 순차로 돌며
  진행률을 보여준다 (`components/BootProgress.tsx`). Tauri 이벤트를 새로 깔지 않고 프런트가
  커맨드를 하나씩 부르며 단계를 갱신한다.
  Upstream 이 Service 보다 먼저인 이유: service 셀렉트 라벨의 `(host:port)` 를 **캐시된**
  upstream 에서 찾아 온다 (`GET /upstreams` 를 두 번 부르지 않기 위해). 순서가 뒤바뀌면
  라벨의 그 조각만 빈다 — 조회 자체는 성립한다.
- **저장·삭제 직후** (`store.syncTouched`) — 건드린 리소스만 전체 재조회한다.
  단 Upstream 을 고치면 Service 까지 다시 받는다 — 노드가 바뀌면 service 라벨이 바뀐다.
- **화면별 동기화 버튼** (`store.syncUpstreams` · `syncServices`) — Upstream·Service 목록
  헤더의 아이콘 버튼. 전체 부트스트랩을 돌리지 않고 그 목록만 갱신한다.

부분 갱신(upsert)을 하지 않는 이유는 게이트웨이에서 삭제된 항목이 캐시에 남으면 Import 가
"등록됨"으로 잘못 판정하고, 좌측 패널에 유령 컨슈머가 뜨기 때문이다.

**디스크에 남기지 않는다.** 앱을 다시 켜면 캐시는 비어 있고 기동 시의 전체 조회가 첫
채우기다. 게이트웨이가 진실의 원천이고 이건 조회 가속용 사본이라, 디스크에 stale 데이터가
남을 위험은 아예 만들지 않았다. 대신 사본이 얼마나 오래된 것인지를 목록 상단의
**마지막 동기화 시각**으로 드러낸다 — route·consumer 두 단계가 모두 성공했을 때만 찍는다.

대시보드의 route·consumer KPI 도 캐시에서 센다 (`db::overview_counts`). 그러지 않으면
대시보드를 열 때마다 같은 전체 목록을 다시 받아 "기동 시 1회 조회"가 무의미해진다.
version·latency 는 라이브 값이라야 의미가 있어 그대로 호출한다.

### 건수는 세 종류다

`store.routes` 는 **현재 조회 결과**이므로 배열 길이로 전체 건수를 세면 검색 중에 숫자가
흔들린다. 반영하는 조건이 서로 달라 세 값을 따로 본다.

| 값 | 반영하는 조건 | 쓰는 곳 |
|---|---|---|
| `routesTotal` | chip + 검색어 + 컨슈머 | 하단 `총 N건` |
| `routeCounts` | 검색어 + 컨슈머 (chip 제외) | 상단 chip 라벨 |
| `access` | **아무것도 반영 안 함** | 좌측 패널 |

좌측 패널이 `routeCounts` 를 쓰면 순환한다 — 컨슈머를 고른 순간 '전체 Route' 행이 그 컨슈머의
건수를 표시하게 된다. 그래서 패널은 필터를 반영하지 않는 고정 집계(`consumer_access_counts`)를
본다. 컨슈머를 고르면 chip 숫자는 함께 줄어드는데, 컨슈머는 chip 과 나란한 필터가 아니라
조회 범위이기 때문이다.

Consumer 목록 화면의 검색·chip 은 건수가 적어 프런트 배열 필터를 그대로 쓴다
(`store.filterConsumers`). 캐시에서 읽어 온 배열을 필터링하므로 게이트웨이는 부르지 않는다.

---

## 컨슈머 접근 권한 — Route 화면 좌측 패널

좌측 패널은 예전에 전체/활성/비활성이었는데, 같은 조건을 상단 토글 칩이 이미 제공한다.
그래서 **컨슈머 목록**으로 바꿨다. 컨슈머를 고르면 그 컨슈머가 접근할 수 있는 Route 만 남는다.

판정 규칙은 **교집합**이다 — 컨슈머의 `auth-groups` 중 하나라도 라우트의 `allowed_groups` 에
있으면 권한이 있다. 두 값 모두 `models::find_groups` 가 이미 정규화해 둔 것을 쓴다
(비표준 표기까지 훑어 찾은 값이다. 아래 "auth-groups 를 어디에 넣어 뒀든 찾아 읽는다" 참조).

SQL 로는 정션 테이블 두 개의 세미조인이다.

```sql
EXISTS (SELECT 1 FROM route_groups rg
          JOIN consumer_groups cg ON cg.env = rg.env AND cg.grp = rg.grp
         WHERE rg.env = ?1 AND rg.route_id = routes.id AND cg.username = ?3)
```

- `EXISTS` 는 첫 일치에서 멈추므로 그룹을 둘 이상 공유해도 라우트가 중복으로 나오지 않는다.
  평범한 `JOIN` 으로 바꾸면 중복이 생긴다 (`tests.rs` 의 `consumer_filter_returns_each_route_once`).
- 정션 테이블은 PK 와 보조 인덱스를 **둘 다** 둔다. PK 는 `(env, route_id) → grp` 방향(위 조건),
  보조 인덱스는 `(env, grp) → route_id` 방향(접근 건수 집계)을 탄다.
- 그룹 비교는 **대소문자를 구분한다.** 게이트웨이가 요청 시점에 하는 비교를 화면이 그대로
  흉내를 내야 한다 — 화면이 "접근 가능"이라 했는데 실제 호출이 403 이면 화면이 깐깐한 것보다
  훨씬 나쁘다. `COLLATE NOCASE` 는 ASCII 만 접어서 한글 그룹명에는 효과가 없기도 하다.
- `allowed_groups` 가 **빈** 라우트는 어떤 컨슈머로도 걸리지 않는다. 화면에서 사라지지 않도록
  패널이 `그룹 제한 없음 (N)` 행으로 건수를 따로 보여준다.

상단 status chip 과 좌측 패널은 서로 **다른 축**이라 AND 로 겹쳐 적용된다. `store.chip` 하나에
둘을 담을 수 없어서 `routeConsumer` 를 따로 둔다.

---

## 담당자 — labels 의 name{n} / dept{n}

Consumer 상세의 폼 편집 탭에 담당자 그리드가 있다. 게이트웨이 `labels` 에
`name1`/`dept1`, `name2`/`dept2`, … 쌍으로 저장돼 있는 값이고, `n` 은 상한이 없으며
`dept{n}` 없이 `name{n}` 만 있는 경우도 있다.

번호 규칙은 **Rust 한 곳에만** 둔다 (`models::contacts_of` · `set_contacts_at`).
JSON 탭의 요청 본문에 `labels` 를 넣지 않는 것도 같은 이유다 — 규칙이 두 곳에 있으면 반드시
어긋난다. (`jsonToForm` 이 `...current` 를 펼치므로 담당자는 JSON 탭을 왕복해도 살아남는다.)

- 읽기: `BTreeMap<usize, _>` 에 모아 **숫자 순**으로 정렬한다. serde_json 이 `preserve_order`
  없이 빌드돼 `Map` 이 BTreeMap 이라, 키 문자열을 그대로 순회하면 `name1, name10, name2` 순이
  되어 10번째 담당자가 2번째 앞에 온다.
- 앞자리 0 은 우리 키로 보지 않는다. `name01` 을 인식하면 재번호 과정에서 `name1` 과 충돌해
  한쪽이 조용히 사라진다. `name01` · `name0` · `nameX` · 맨 `name` 은 다른 라벨처럼 보존한다.
- 쓰기: 인식한 키만 지우고 1..N 으로 **조밀하게 재번호**한다. 중간 행을 지우면 뒤가 당겨진다.
  그래서 아무것도 고치지 않고 저장해도 `name1`/`name3` 은 `name1`/`name2` 가 된다.
- `name`/`dept` 이외의 labels 키는 손대지 않는다 (`set_groups_at` 이 다른 플러그인을 보존하는
  것과 같은 규칙).
- `ConsumerForm.contacts` 는 `Option<Vec<Contact>>` 다. `null` = 기존 labels 를 건드리지 않고,
  `[]` = 담당자 라벨을 전부 지운다. `Vec<Contact>` + `serde(default)` 로 두면 `api.ts` 에서
  필드 한 줄을 빠뜨린 순간 게이트웨이의 담당자 라벨이 전부 지워진다 — 빠뜨렸을 때
  **지워지는 쪽이 아니라 유지되는 쪽**으로 degrade 해야 한다.

### APISIX labels 제약

`apisix/schema_def.lua` 의 `label_value_def` 기준이다.

| 제약 | 값 |
|---|---|
| 값 패턴 | `^\S+$` — **공백이 하나라도 있으면 400** |
| 길이 | 1 ~ 256 **바이트** (Lua 의 `#str`. 한글 약 85자) |
| 개수 상한 | 없음 |

한글 자체는 문제없다 — `\S` 가 바이트 단위라 한글 바이트는 전부 non-space 다. 순수하게 ASCII
공백만 걸린다. 그래서 `플랫폼 개발팀` 같은 부서명은 게이트웨이가 거절한다.
`ConsumerForm::validate()` 가 저장 전에 막고 무엇을 어떻게 고쳐야 하는지 알려 주며, 폼에서도
공백이 있으면 경고를 띄운다. **자동 치환은 하지 않는다** — `_` 치환은 데이터를 몰래 바꾸는
것이고, U+00A0 은 패턴을 통과하면서 화면상 공백과 구분이 안 된다.

---

## API 스펙 Import

Route 목록 상단의 `Import` 버튼 → OAS 3.0 스펙을 읽어 선택한 service 안의 라우트와 대조한다.

### 스펙을 어디서 읽는가 — 두 모드

주소를 손으로 붙여 넣는 입력란은 **없다**. 스펙 주소는 service 의 속성이므로
(`labels.spec_url`) service 를 고르면 따라와야 한다. 매번 같은 URL 을 붙여 넣는 것은
그 정보를 아무 데도 저장하지 않는다는 뜻이었다.

| 상태 | 무엇으로 비교하나 | service 를 바꾸면 |
|---|---|---|
| **파일 첨부함** | 첨부한 스펙 | 비교(`oas_compare`)만 다시 돌린다 — 스펙은 이미 캐시에 적재돼 있다 |
| **파일 미첨부** | 고른 service 의 `labels.spec_url` | 그 service 의 주소를 읽어 다시 파싱·비교한다 |

갈림길은 `store.setImportService` 에 있고, 판단 기준은 `importFileName` 이 비었는지다.
첨부한 파일은 파일명 칩으로 보여 주고 `×` 로 해제할 수 있다 — 해제하면 빈 화면이 되는 대신
그 service 의 `spec_url` 쪽 결과로 되돌아간다. 파일을 떼어 낸 사용자가 보고 싶은 것은
빈 화면이 아니다.

`spec_url` 이 없는 service 를 고르면 어디서 채우면 되는지 알려 준다 (Service 화면 또는 첨부).

| 읽기 경로 | 구현 | 왜 이렇게 |
|---|---|---|
| 드래그&드롭 | 웹뷰에서 `file.text()` → `oas_load({kind:"text"})` | `tauri.conf.json` 의 `dragDropEnabled: false` 가 HTML5 DnD 를 쓰기 위한 조건이다 (Tauri 가 OS 드롭을 가로채지 않는다) |
| 파일 다이얼로그 | `@tauri-apps/plugin-dialog` `open()` → 경로 → Rust 가 `read_to_string` | 웹뷰에 `fs:` 권한을 주지 않기 위해 읽기는 Rust 가 한다 (`capabilities/default.json` 무변경) |
| service 의 `spec_url` | `oas_load({kind:"url"})` → `client::fetch_text` | CSP 가 웹뷰의 외부 통신을 막고 있어 프런트에서 fetch 할 수 없다 |

드롭존 **밖**에 파일을 떨어뜨리면 WebView2 가 그 파일로 내비게이션해 앱 화면이 사라진다.
그래서 `App.tsx` 가 창 전체의 `dragover`·`drop` 기본 동작을 막는다.

### 파싱 — 엄격하게 읽고, 실패하면 관대하게

`openapiv3` 로 타입 파싱을 하면 문서가 진짜 OAS 3.0 인지 검증되고 `operationId`·`summary`·`tags`
를 구조적으로 얻는다. 그런데 현장 스펙은 스키마를 어기는 일이 흔하다 (`type: [string, null]`
같은 3.1 문법 혼용, 벤더 확장, 오타). 그 한 줄 때문에 수백 개 API 비교가 통째로 막히는 것이
더 나쁘므로, 엄격 파싱이 실패하면 `paths` 를 직접 훑는 경로로 내려가고 **경고 배너만** 띄운다.
swagger 2.0 은 구조가 달라 명시적으로 거부한다.

YAML 파서(`serde_norway`)가 JSON 의 상위집합이라 `.json` 스펙도 같은 경로로 읽힌다.

### 판정 — 등록 / 메서드 불일치 / 미등록

게이트웨이와 OAS 가 경로 파라미터를 다르게 쓰므로 **양쪽을 같은 표현으로 접어** 비교한다
(`oas::normalize`):

```
/pets/{petId}/toys  ==  /pets/:petId/toys  ==  /pets/*/toys   →  /pets/{}/toys
```

끝의 `*` 만 접두 매칭(`wildcard`)으로 다룬다 — APISIX 의 uri 매칭이 그렇다. 대소문자는 보존한다.

| 판정 | 조건 |
|---|---|
| **등록** | uri 가 맞고, route 의 `methods` 에 해당 메서드가 있음 — 또는 `methods` 키가 아예 없음(APISIX 는 전 메서드 허용) |
| **메서드 불일치** | uri 는 맞지만 그 메서드가 없음. 클릭하면 그 route 상세로 가서 메서드를 추가할 수 있다 |
| **미등록** | 선택한 service 안에 맞는 uri 가 없음. 클릭하면 값이 채워진 신규 등록 화면으로 간다 |

후보가 여럿이면 **메서드가 맞는 쪽을 먼저**, 같으면 정확 일치를 먼저 고른다. uri 만 같고
메서드가 다른 route 와 와일드카드지만 메서드가 맞는 route 가 함께 있으면 실제 호출은
후자로 흘러가므로, 그 상황에서 "등록됨"이 정직한 답이다.

"메서드 불일치"를 따로 두는 이유는 2단계(등록/미등록)로 뭉치면 **uri 는 이미 있는데 미등록으로
보여** 같은 uri 의 route 를 새로 만들게 되기 때문이다.

### 경로 접두사

스펙의 `servers[0].url` 경로 부분(`https://api.example.com/v1` → `/v1`)을 기본값으로 채우고
화면에서 편집할 수 있다. 게이트웨이 uri 가 `/v1/pets` 인데 스펙 path 는 `/pets` 인 경우를 위한 것이다.
`{basePath}` 처럼 템플릿이 남아 있으면 게이트웨이 uri 와 맞을 수 없으므로 쓰지 않는다.

이 접두사는 **route 명 접두사**도 만든다 — 앞 슬래시를 떼고 · 대문자로 바꾸고 · 뒤에 슬래시를
붙인다 (`oas::name_prefix`).

| 경로 접두사 | route 명 접두사 |
|---|---|
| `/v1` | `V1/` |
| `/v1/api` | `V1/API/` |
| `/ep/` | `EP/` |
| 없음 · `/` | *(없음)* — `/` 만 남기면 이름이 슬래시로 시작해 버린다 |

접두사를 입력하는 중에 파생 결과를 화면에 같이 보여 준다 — 행을 눌러 보기 전에 어떤 이름이
채워질지 알 수 있어야 한다.

### 신규 등록 화면 프리필

미등록 행을 누르면 `name`·`uri`·`proxy-rewrite.uri`·`methods`·`service_id`·`desc` 가 채워진
신규 폼이 열린다. 저장은 **기존 `route_save` 경로를 그대로 탄다** — Import 전용 저장 경로를
만들지 않았으므로 플러그인 보존 머지가 그대로 적용된다. 저장하면 비교 결과로 돌아오고, 방금
만든 API 가 `등록` 으로 바뀐다 (캐시를 갱신한 뒤 비교를 다시 돌린다).

이미 등록된 행을 눌러 들어가는 **편집 모드에는 접두사가 개입하지 않는다.** 게이트웨이에 있는
값을 그대로 읽어 오는 경로(`routeToForm`)라 프리필 규칙이 낄 자리가 없다.

`servers: https://host/v1` · path `/orders/{orderId}/items` 인 경우 세 값은 이렇게 갈린다:

| 필드 | 값 | 무엇인가 |
|---|---|---|
| `name` | `V1/orders/{orderId}/items` | route 명 접두사 + **접두사를 뗀 원본 path**. 사람이 읽는 값이라 스펙과 같은 표기를 유지한다 |
| `uri` | `/v1/orders/:orderId/items` | 게이트웨이가 매칭하는 표기 (접두사 포함, 변환 규칙은 아래 표) |
| `plugins.proxy-rewrite.uri` | `/orders/{orderId}/items` | upstream 이 아는 경로 — **접두사가 붙지 않는다** |

세 값은 모두 Rust 가 계산해 `CompareRow` 로 내려준다 (`oas::suggested_name` ·
`oas::to_apisix_uri`). 프런트에서 다시 만들지 않는다 — 규칙이 두 곳에 있으면 반드시 어긋나고,
Rust 쪽에는 테스트가 붙어 있다. `name` 은 APISIX 제한(100자)에 맞춰 char 경계에서 자른다.

`uri` 변환 규칙은 `oas::to_apisix_uri` 한 곳에만 있다:

| OAS path | 프리필 uri | 왜 |
|---|---|---|
| `/pets` | `/pets` | 그대로 |
| `/pets/{petId}` | `/pets/*` | 마지막 세그먼트면 접두 매칭으로 둘 수 있다 |
| `/pets/{petId}/toys` | `/pets/:petId/toys` | 중간에 `*` 를 넣으면 기본 라우터(`radixtree_uri`)가 매칭하지 못한다. 이 형태는 게이트웨이가 `radixtree_uri_with_parameter` 여야 동작한다 |

어차피 사용자가 저장 전에 검토·수정하는 값이라 "가장 그럴듯한 출발점"을 준다.

### spec_url 과 프록시

게이트웨이는 반드시 프록시를 우회해야 하지만, 스펙 주소는 사외일 수 있어 오히려 사내 프록시를
타야 할 수 있다. 그래서 Import 화면에 `프록시 우회` 체크박스를 두고 기본값을 현재 환경의
설정으로 준다. 이 선택은 스펙 조회에만 적용되고 게이트웨이 호출 경로는 건드리지 않는다.
`http` / `https` 스킴만 허용하고(주소가 임의 파일 읽기가 되지 않도록) 응답은 8 MiB 로 제한한다.
Service 폼도 저장 시점에 같은 스킴 제한을 걸어, 나중에 `fetch_text` 가 거부할 값이 애초에
저장되지 않게 한다.

---

## Upstream · Service 관리

아이콘 레일에 `Upstream` · `Service` 두 화면이 있다. 각각 목록(검색 + 동기화 버튼) 과
편집 화면을 갖고, 편집 화면은 Route·Consumer 와 같은 `EditScreen` 껍데기를 공유한다 —
저장·취소·삭제 헤더를 네 번 복붙하지 않기 위해서다. 두 형태는 **폼 탭만** 있다
(JSON 탭은 `labels`·`nodes` 표기 규칙을 TS 에 다시 구현해야 해서 두지 않았다).

### 왜 필요했나

Import 화면이 파일 첨부 없이도 동작하려면 "이 service 의 스펙은 여기"라는 정보를 어딘가
저장해야 한다. 그 자리를 만들려면 Service 를 앱에서 편집할 수 있어야 하고, Service 는
`upstream_id` 를 요구하므로 Upstream 도 함께 필요해진다.

### spec_url 을 labels 에 두는 이유

APISIX 의 service 스키마는 `additionalProperties: false` 라 **최상위에 임의 필드를 넣을 수
없다.** `labels` 는 값 제약만 지키면 무엇이든 담을 수 있고, URL 은 공백이 없어 그 제약을
자연히 통과한다.

| 제약 | 값 |
|---|---|
| 값 패턴 | `^\S+$` — 공백이 하나라도 있으면 400 |
| 길이 | 1 ~ 256 **바이트** (`minLength = 1` 이라 빈 값은 `""` 가 아니라 **키 생략**) |
| 스킴 | `http` / `https` 만 (저장 시점에 막는다 — `client::fetch_text` 와 같은 규칙) |

폼에서 세 가지를 저장 전에 인라인 경고로 짚어 준다. 게이트웨이의 400 은 어느 값이 왜 틀렸는지
알려 주지 않으므로, 담당자 `labels` 를 검사하는 것과 같은 이유다.

`spec_url` 을 비우면 그 **키만** 지운다 — 담당자(`name{n}`/`dept{n}`) 같은 다른 라벨은
그대로 남고, 라벨이 하나도 남지 않으면 `labels` 키 자체를 없앤다.

### Service 폼

| 필드 | 저장 위치 |
|---|---|
| `name` (필수) | `name` |
| `upstream_id` (필수) | `upstream_id` — 캐시된 Upstream 목록에서 고르는 셀렉트 |
| `desc` | `desc` |
| `spec_url` | `labels.spec_url` |
| `log-key` (필수, placeholder `ep`) | `plugins.shi-log.key` |

`plugins.jwt-auth` 는 저장할 때 **없을 때만** `{}` 로 넣는다. 이미 붙어 있으면 그 설정
(`header`·`hide_credentials` 등)을 보존한다 — `{}` 로 덮으면 게이트웨이에 설정된 옵션이
조용히 사라진다. `shi-log` 도 `key` 만 갈아 끼우고 나머지 필드는 남긴다.

### Upstream 폼

노드를 여러 개 등록할 수 있고 각 행은 `host` · `port` 다. `timeout` 은 요구된 기본값
`connect 10` · `send 10` · `read 60` (초) 으로 채워져 열린다.

`weight` 는 **화면에 두지 않지만 조회한 값을 그대로 되쓴다.** 보이지 않는 값을 저장 한 번으로
1 로 덮으면 게이트웨이에 설정된 가중치가 사라진다. 새 노드는 1 이다.

`nodes` 는 게이트웨이가 두 표기를 모두 주므로 **읽기는 둘 다** 받는다:

```
{"10.0.0.1:8080": 1}            맵 표기 — 키가 host:port, 값이 weight
[{host, port, weight}]          배열 표기
```

**쓰기는 배열로 고정한다.** 맵 키에 `host:port` 를 조립해 넣으면 포트가 없는 노드
(`example.com`)나 IPv6 주소(`[::1]:8080`)에서 표기가 애매해지고, weight 를 값 자리에
숨겨야 한다. 맵 표기를 읽을 때는 **마지막 콜론 뒤가 숫자일 때만** 나눈다 — 그러지 않으면
`::1` 이 host `:` + port `1` 로 갈린다.

`type`(로드밸런싱 방식)은 폼에 없다. 없을 때만 `roundrobin` 을 넣고, 이미 있으면 손대지
않는다 — `chash` 로 운영 중인 upstream 을 저장 한 번으로 바꿔 버리면 안 된다.
`checks`(헬스체크)·`retries`·`scheme`·`pass_host` 도 같은 이유로 보존한다.

---

## 보안

- 관리 토큰은 **Windows 자격 증명 관리자**에 저장한다 (`api-gateway-manager` / `apisix-admin-token::dev|prod`).
  디스크에 평문으로 남기지 않으며, 프런트로는 마스킹된 문자열만 내려간다.
- 설정 화면의 토큰 입력란을 비워 두면 "기존 토큰 유지"로 동작한다. 지우려면 `토큰 삭제` 를 누른다.
- `인증서 검증 건너뛰기` 는 기본 OFF 다. 켜면 경고 문구가 뜬다.
  가능하면 사내 CA 를 Windows 인증서 저장소에 설치하는 편이 안전하다
  (reqwest 를 `rustls-tls-native-roots` 로 빌드해 OS 인증서 저장소를 사용한다).

---

## 디자인 원본과 다른 점

목업의 하드코딩 값을 실데이터로 바꾸면서 생긴 차이. 그 외 색·간격·컴포넌트는 원본 그대로다.

| 항목 | 원본 | 구현 | 이유 |
|---|---|---|---|
| 대시보드 `etcd 3 nodes · healthy` | 고정 문자열 | `Service N개 · Upstream M개` | Admin API 로 etcd 상태를 알 수 없음 |
| `APISIX 버전` · `응답 시간` | 고정값 | `Server` 헤더 파싱 · 실제 왕복 시간 | 실측 |
| `최근 관리 API 호출` | 목업 5건 | 앱이 수행한 호출 이력 (최근 50건) | Admin API 에 감사 로그가 없음 |
| KPI delta | `변경 없음`, `health 정상` | `활성 N · 비활성 M`, `조회 전용` 등 | 검증할 수 없는 문구를 쓰지 않음 |
| `editSub` | 항상 `PUT …/routes/{name}` | 신규는 `POST …/routes` | 실제 호출과 일치시킴 |
| JSON 탭 `status` | 항상 `1` | 실제 status | 비활성 라우트를 잘못 표시하지 않도록 |
| Consumer `username` | 항상 편집 가능 | 상세에서는 읽기 전용 | APISIX 식별자라 바꾸면 다른 consumer 가 됨 |
| Consumer 좌측 탭·칩 | 전체 / 제휴사 / 내부 시스템 고정 | 실제 `auth-groups` 값별 버킷 + `(그룹 없음)` | `partner`·`internal` 이라는 특정 문자열을 가정한 구분이라 조직마다 맞지 않음 |
| JWT `nbf` | 발급 시각(now) | **로컬 2025-08-01 00:00 고정** | 누를 때마다 토큰이 달라지면 이미 배포된 토큰과 값이 어긋남 |
| JSON 탭 | 앱 관리 키만 | + `게이트웨이 원본` 읽기 전용 보기 | 그룹 필드가 실제로 어디 있는지 확인해야 할 때가 있음 |
| 설정 토글 | 프록시 우회 1개 | + 인증서 검증 건너뛰기 | 사설 인증서 환경 대응 |
| JWT 안내 문구 | "Authorization 헤더 없이 `Authorization: Bearer …`" | "호출 시 `Authorization: Bearer …`" | 원문이 모순된 문장이라 정정 |
| Route 목록 헤더 | 검색 + `신규 Route` | + 리프레시 · `Import` 버튼 | 원본에 없던 화면. 목록 캐시를 명시적으로 갱신할 수단과 스펙 대조 진입점이 필요하다 |
| Route 목록 chip | `전체` / `status 1` / `status 0` | 각 라벨에 건수 표기 | Consumer chip 은 이미 건수를 보여 주고 있어 맞췄다 |
| Route 검색 | 배열 전문 검색 | 내장 SQLite 조회 | 위 'Route 목록 — 내장 SQLite 캐시' 절 |
| methods 칩 | `METHODS` 7개 고정 | + 폼에 실제로 들어 있는 비표준 메서드 | `CONNECT`·`TRACE`·`PURGE` 를 쓰는 라우트가 칩 하나 눌렀다고 조용히 그 값을 잃으면 안 된다 (`sortMethods` 가 버리지 않고 뒤에 붙인다) |
| `API 스펙 Import` 화면 | 없음 | 신규 | 요청 기능 |
| 아이콘 레일 | 대시보드 / Route / Consumer / 설정 | + `Upstream` · `Service` | service 에 `spec_url` 을 붙여야 Import 가 파일 없이도 동작한다. 그러려면 두 리소스를 앱에서 편집할 수 있어야 한다 |

Service / Upstream 은 각각 레일 메뉴와 편집 화면을 갖는다 (아래 'Upstream · Service 관리' 절).

디자인의 프리뷰 전용 props(`density` 기본/컴팩트, `showActivity`)는 목업 노브로 보고
기본 밀도만 구현했다. 필요하면 설정 화면에 옵션으로 추가하면 된다.

### JWT 토큰

`nbf` 는 **로컬 2025-08-01 00:00**, `exp` 는 디자인이 고정한 **로컬 3000-12-31 17:59** 로 둘 다 고정이다.

그 결과 토큰은 `(key, secret)` 의 순수 함수가 된다 — 같은 Consumer 면 언제 눌러도 **같은 토큰**이
나오고, 이미 배포한 토큰과 화면에 보이는 토큰이 어긋나지 않는다. 뒤집어 말하면 `재발급` 버튼만으로는
토큰이 바뀌지 않는다. **토큰을 실제로 회전시키려면 secret 을 새로 생성해 저장**해야 한다.

값을 바꿔야 하면 `jwt_sign` 커맨드가 이미 `nbf` · `exp` 인자를 받으므로
(`src-tauri/src/jwt.rs` `fixed_nbf` · `design_exp`) 상수만 고치거나 JWT 탭에 입력란을 붙이면 된다.
