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
├─ components/              TitleBar · IconRail · SidePanel · Toast
└─ screens/                 Locked · Dashboard · List · Import · Settings · edit/*

src-tauri/src/
├─ lib.rs                   플러그인/커맨드 등록, 창 셋업
├─ commands.rs              IPC 커맨드 전부
├─ config.rs                환경 설정 + Windows 자격 증명 관리자(토큰)
├─ apisix/client.rs         ★ no_proxy HTTP 클라이언트 (단일 진입점)
├─ apisix/{routes,consumers,meta,models}.rs
├─ db.rs                    Route 목록 검색 · Import 비교용 메모리 SQLite
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
| service_id 셀렉트 · KPI | `GET /services`, `GET /upstreams` (읽기 전용) |

### 플러그인 보존

디자인의 `routeJson()` 은 `plugins` 를 통째로 교체한다. 그대로 구현하면 게이트웨이에
이미 붙어 있던 `limit-count` 같은 플러그인이 저장 시 **사라진다**.

그래서 저장 직전 원본을 GET 해 와 앱이 관리하는 키만 덮어쓰는 **머지 방식**으로 처리한다:

- Route → `proxy-rewrite.uri`, 그룹 필드(기본 `shi-auth.allowed_groups`)
- Consumer → `jwt-auth.key`, `jwt-auth.secret`, 그룹 필드(기본 `jwt-auth.auth-groups`)

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

## Route 목록 — 내장 SQLite 캐시

목록 검색·필터가 게이트웨이를 다시 부르지 않는다. `GET /routes` 결과를 **메모리 SQLite**
(`Connection::open_in_memory()`, `src-tauri/src/db.rs`)에 통째로 넣고, 검색어와 chip 은
SQL 로 처리한다. 예전에는 프런트가 배열을 들고 매 키 입력마다 `JSON.stringify(route)` 를
훑었다 — 라우트가 수백 건이면 눈에 띄게 느려지고, Import 의 등록 여부 판정은
(스펙 오퍼레이션 수) × (라우트 수) 번 비교가 된다. uri 를 정규화해 인덱스로 만들면 둘이 같이 풀린다.

| 커맨드 | 게이트웨이 호출 | 하는 일 |
|---|---|---|
| `routes_sync` | O | 전체 재조회 → 캐시 전면 교체 → 첫 조회 결과 반환 |
| `routes_query` | X | 캐시만 조회 (검색어·chip) |
| `route_cached` | X | 캐시에서 단건 (Import 결과 → 상세 이동) |

캐시를 채우는 경로는 `routes_sync` 하나다. 목록 화면 진입, **상단 리프레시 버튼**,
저장·삭제 직후, 그리고 Import 에서 스펙을 읽는 시점에 호출된다.
부분 갱신(upsert)을 하지 않는 이유는 게이트웨이에서 삭제된 라우트가 캐시에 남으면
Import 가 "등록됨"으로 잘못 판정하기 때문이다.

**디스크에 남기지 않는다.** 앱을 다시 켜면 캐시는 비어 있고 전체 조회가 유일한 채우기
경로다. 게이트웨이가 진실의 원천이고 이건 조회 가속용 사본이라, stale 데이터를 들고 있을
위험을 아예 만들지 않는 편을 택했다.

건수 표기에 주의할 점이 있다. `store.routes` 는 **현재 조회 결과**이므로 배열 길이로
전체 건수를 세면 검색 중에 숫자가 흔들린다. chip 라벨과 사이드 패널은 캐시가 따로 돌려주는
`routeCounts`(chip 을 빼고 검색어만 적용한 상태별 건수)를 쓴다.

Consumer 목록은 그대로 배열 필터를 쓴다 (`store.filterConsumers`).

---

## API 스펙 Import

Route 목록 상단의 `Import` 버튼 → OAS 3.0 스펙을 읽어 선택한 service 안의 라우트와 대조한다.

### 입력 세 경로

| 방식 | 구현 | 왜 이렇게 |
|---|---|---|
| 드래그&드롭 | 웹뷰에서 `file.text()` → `oas_load({kind:"text"})` | `tauri.conf.json` 의 `dragDropEnabled: false` 가 HTML5 DnD 를 쓰기 위한 조건이다 (Tauri 가 OS 드롭을 가로채지 않는다) |
| 파일 다이얼로그 | `@tauri-apps/plugin-dialog` `open()` → 경로 → Rust 가 `read_to_string` | 웹뷰에 `fs:` 권한을 주지 않기 위해 읽기는 Rust 가 한다 (`capabilities/default.json` 무변경) |
| URL | `oas_load({kind:"url"})` → `client::fetch_text` | CSP 가 웹뷰의 외부 통신을 막고 있어 프런트에서 fetch 할 수 없다 |

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

### 신규 등록 화면 프리필

미등록 행을 누르면 `name`·`uri`·`methods`·`service_id`·`desc` 가 채워진 신규 폼이 열린다.
저장은 **기존 `route_save` 경로를 그대로 탄다** — Import 전용 저장 경로를 만들지 않았으므로
플러그인 보존 머지가 그대로 적용된다. 저장하면 비교 결과로 돌아오고, 방금 만든 API 가
`등록` 으로 바뀐다 (캐시를 갱신한 뒤 비교를 다시 돌린다).

`uri` 변환 규칙은 `oas::to_apisix_uri` 한 곳에만 있다 (프런트에서 다시 만들지 않는다):

| OAS path | 프리필 uri | 왜 |
|---|---|---|
| `/pets` | `/pets` | 그대로 |
| `/pets/{petId}` | `/pets/*` | 마지막 세그먼트면 접두 매칭으로 둘 수 있다 |
| `/pets/{petId}/toys` | `/pets/:petId/toys` | 중간에 `*` 를 넣으면 기본 라우터(`radixtree_uri`)가 매칭하지 못한다. 이 형태는 게이트웨이가 `radixtree_uri_with_parameter` 여야 동작한다 |

어차피 사용자가 저장 전에 검토·수정하는 값이라 "가장 그럴듯한 출발점"을 준다.

### 스펙 URL 과 프록시

게이트웨이는 반드시 프록시를 우회해야 하지만, 스펙 URL 은 사외 주소라 오히려 사내 프록시를
타야 할 수 있다. 그래서 Import 화면에 `프록시 우회` 체크박스를 두고 기본값을 현재 환경의
설정으로 준다. 이 선택은 스펙 조회에만 적용되고 게이트웨이 호출 경로는 건드리지 않는다.
`http` / `https` 스킴만 허용하고(URL 입력란이 임의 파일 읽기가 되지 않도록) 응답은 8 MiB 로 제한한다.

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

Service / Upstream 은 **읽기 전용**이다. 레일에 화면이 없고 주 용도가 Route·Consumer 관리라,
`service_id` 셀렉트와 KPI 를 채우기 위한 조회만 구현했다.

디자인의 프리뷰 전용 props(`density` 기본/컴팩트, `showActivity`)는 목업 노브로 보고
기본 밀도만 구현했다. 필요하면 설정 화면에 옵션으로 추가하면 된다.

### JWT 토큰

`nbf` 는 **로컬 2025-08-01 00:00**, `exp` 는 디자인이 고정한 **로컬 3000-12-31 17:59** 로 둘 다 고정이다.

그 결과 토큰은 `(key, secret)` 의 순수 함수가 된다 — 같은 Consumer 면 언제 눌러도 **같은 토큰**이
나오고, 이미 배포한 토큰과 화면에 보이는 토큰이 어긋나지 않는다. 뒤집어 말하면 `재발급` 버튼만으로는
토큰이 바뀌지 않는다. **토큰을 실제로 회전시키려면 secret 을 새로 생성해 저장**해야 한다.

값을 바꿔야 하면 `jwt_sign` 커맨드가 이미 `nbf` · `exp` 인자를 받으므로
(`src-tauri/src/jwt.rs` `fixed_nbf` · `design_exp`) 상수만 고치거나 JWT 탭에 입력란을 붙이면 된다.
