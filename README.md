# API Gateway 관리자

APISIX Admin API 기반 **Windows 데스크톱 앱** (Tauri 2 + React 19 + TypeScript).
Route / Consumer 관리와 Consumer용 JWT 토큰 발급·조회가 주 용도다.

화면은 Claude Design 프로젝트 `05e631b1` 의 설계를 그대로 구현했다.

---

## 빠른 시작

```bash
npm install
npm run tauri dev        # 개발 실행
npm run tauri build      # 릴리스 빌드 (MSI · NSIS)
cargo test --lib --manifest-path src-tauri/Cargo.toml   # 회귀 테스트
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
└─ screens/                 Locked · Dashboard · List · Settings · edit/*

src-tauri/src/
├─ lib.rs                   플러그인/커맨드 등록, 창 셋업
├─ commands.rs              IPC 커맨드 전부
├─ config.rs                환경 설정 + Windows 자격 증명 관리자(토큰)
├─ apisix/client.rs         ★ no_proxy HTTP 클라이언트 (단일 진입점)
├─ apisix/{routes,consumers,meta,models}.rs
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
| Route 목록 | `GET /routes` |
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
