//! 프런트가 부르는 모든 IPC 커맨드.
//!
//! 게이트웨이로 나가는 HTTP 는 전부 여기를 거친다 — 웹뷰는 게이트웨이를 직접 호출하지 않는다
//! (그래야 시스템 프록시를 확실히 우회할 수 있다. apisix/client.rs 주석 참조).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

use crate::apisix::consumers::{self, ConsumerForm};
use crate::apisix::meta::{self, Overview};
use crate::apisix::models::{ConsumerView, RouteView, ServiceView, UpstreamView};
use crate::apisix::routes::{self, RouteForm};
use crate::apisix::services::{self, ServiceForm};
use crate::apisix::upstreams::{self, UpstreamForm};
use crate::apisix::client;
use crate::config::{self, Env, EnvConfig, SettingsView};
use crate::db::{self, AccessCounts, Cache, CompareRow, RouteScope, RoutesPage};
use crate::error::{AppError, AppResult};
use crate::history::{self, EntryView};
use crate::jwt::{self, JwtResult};
use crate::oas::{self, OasDoc};
use crate::perm::{self, Perm};

// ── 설정 ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvPayload {
    pub base_url: String,
    /// `null` = 기존 토큰 유지, `""` = 삭제, 그 외 = 교체
    #[serde(default)]
    pub token: Option<String>,
}

impl EnvPayload {
    /// 프록시 우회 · 인증서 검증 건너뛰기는 설정 화면에서 고를 수 없다 — 항상 켠다
    /// (`config.rs` 모듈 주석).
    fn to_cfg(&self) -> EnvConfig {
        EnvConfig {
            base_url: self.base_url.trim().to_string(),
            no_proxy: true,
            insecure_tls: true,
        }
    }
}

// ── 관리 권한 ────────────────────────────────────────────────
//
// 화면은 이미 메뉴를 숨기고 목록을 걸러 주지만, 커맨드도 각자 확인한다 — 화면 상태와
// 무관하게 IPC 는 호출될 수 있고, 권한 판정을 한 층에만 두면 그 층을 건너뛰는 경로가
// 생기는 순간 조용히 뚫린다. (실제 인가 경계는 게이트웨이다 — `perm.rs` 모듈 주석)

/// 전체 관리자 전용 커맨드의 문턱.
fn require_admin(env: Env) -> AppResult<()> {
    if perm::resolve(env).is_admin() {
        return Ok(());
    }
    Err(AppError::new(
        crate::error::ErrorKind::Unauthorized,
        "이 작업은 전체 관리자 토큰으로만 할 수 있습니다.",
    )
    .with_hint("설정 화면에서 관리키를 확인하세요."))
}

/// 이 service 를 만질 권한이 있는지.
fn require_service(env: Env, service_id: &str) -> AppResult<()> {
    if perm::resolve(env).allows(service_id) {
        return Ok(());
    }
    Err(AppError::new(
        crate::error::ErrorKind::Unauthorized,
        "관리 권한이 없는 service 입니다.",
    )
    .with_hint("관리 토큰에 포함된 service 만 다룰 수 있습니다."))
}

#[tauri::command]
pub fn settings_get(app: AppHandle<Wry>) -> SettingsView {
    config::settings_view(&app)
}

#[tauri::command]
pub fn settings_save(app: AppHandle<Wry>, env: Env, payload: EnvPayload) -> AppResult<SettingsView> {
    if payload.base_url.trim().is_empty() {
        return Err(AppError::config("baseUrl 은 필수입니다."));
    }
    // baseUrl 형식을 미리 검증해 저장 후에야 실패하는 상황을 막는다.
    payload.to_cfg().admin_base()?;

    if let Some(t) = &payload.token {
        // 형식만 본다 — `secret$token` 이 아니면 저장 자체를 막아 잠금 화면까지 가지 않게 한다.
        // 서명·기간은 검사하지 않는다: 만료된 관리키도 저장한 뒤 설정 화면에서 시작일·종료일과
        // 사유를 보여 줘야 사용자가 왜 막혔는지 알 수 있다 (`perm::view`).
        if !t.trim().is_empty() {
            perm::split(t).map_err(|reason| {
                AppError::config(reason.message())
                    .with_hint("발급받은 관리키를 secret$token 형태 그대로 붙여넣으세요.")
            })?;
        }
        config::set_token(env, t)?;
    }
    config::save_env(&app, env, payload.to_cfg())?;
    Ok(config::settings_view(&app))
}

/// 설정 화면의 `표시` 토글이 부르는 커맨드 — 저장된 관리키의 **원문**을 준다.
///
/// 평소 프런트로는 마스킹 문자열만 내려가지만(`config::mask`), 사용자가 자기 관리키를
/// 확인하고 복사할 수 있어야 표시/가리기 토글이 성립한다. secret 이 함께 나가지만
/// 그것은 이 사용자가 이미 가진 자기 관리키이고, 원문은 화면에서만 쓰이며 저장 경로는
/// 그대로 자격 증명 관리자다. (README '보안' 절)
#[tauri::command]
pub fn settings_reveal_token(env: Env) -> AppResult<String> {
    config::get_token(env).ok_or_else(|| {
        AppError::config(format!("{} 서버에 저장된 관리키가 없습니다.", env.label()))
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    /// 디자인 형식: `200 OK · APISIX 3.9.1 · 42ms`
    pub text: String,
}

/// 연결 테스트는 **저장 전 입력값**으로 즉석 호출한다.
/// token 이 null 이면 이미 저장된 관리키를 쓴다.
#[tauri::command]
pub async fn settings_test(app: AppHandle<Wry>, env: Env, payload: EnvPayload) -> TestResult {
    let raw = match &payload.token {
        Some(t) if !t.trim().is_empty() => t.clone(),
        _ => match config::get_token(env) {
            Some(t) => t,
            None => {
                return TestResult { ok: false, text: "관리키가 없어 호출할 수 없습니다.".into() }
            }
        },
    };

    // 게이트웨이에는 관리키의 **토큰 부분만** 보낸다 (`config::resolve` 와 같은 규칙).
    let token = match perm::split(&raw) {
        Ok(k) => k.token,
        Err(reason) => return TestResult { ok: false, text: reason.message().into() },
    };

    let cfg = payload.to_cfg();
    match client::test_connection(&cfg, &token).await {
        Ok(m) => {
            let ver = m
                .server_version
                .map(|v| format!("APISIX {v}"))
                .unwrap_or_else(|| "APISIX".into());
            history::record(
                &app,
                env,
                "GET",
                "routes",
                format!("연결 테스트 성공 · {}ms", m.elapsed_ms),
                "/apisix/admin/routes?page=1&page_size=1",
            );
            TestResult { ok: true, text: format!("{} OK · {} · {}ms", m.status, ver, m.elapsed_ms) }
        }
        Err(e) => {
            history::record_failure(&app, env, "GET", "/apisix/admin/routes", &e.message);
            TestResult { ok: false, text: e.message }
        }
    }
}

// ── Route ────────────────────────────────────────────────────
//
// 목록 조회 커맨드는 `routes_sync` 다 — 게이트웨이 응답을 그대로 내려보내는 대신
// 캐시를 갱신하고 조회 결과를 돌려준다 (아래 'Route 캐시' 절).

#[tauri::command]
pub async fn route_save(app: AppHandle<Wry>, env: Env, form: RouteForm) -> AppResult<RouteView> {
    // 콤보에 권한 있는 service 만 담아 두지만, 저장 본문은 그것과 무관하게 올 수 있다.
    require_service(env, &form.service_id)?;
    routes::save(&app, env, form).await
}

#[tauri::command]
pub async fn route_delete(
    app: AppHandle<Wry>,
    env: Env,
    id: String,
    name: Option<String>,
) -> AppResult<()> {
    // 목록에 안 보이는 라우트를 id 로 지우는 경로를 막는다. 캐시에 없으면(동기화 전) 통과시킨다
    // — 게이트웨이가 404 로 답할 몫이고, 여기서 막으면 정상 삭제까지 못 하게 된다.
    if let Some(rv) = cache(&app)?.with(|conn| db::route_view(conn, env.as_str(), &id))? {
        require_service(env, &rv.service_id)?;
    }
    routes::delete(&app, env, &id, name.as_deref().unwrap_or("")).await
}

// ── 로컬 캐시 (내장 SQLite) ──────────────────────────────────
//
// 목록 화면은 게이트웨이를 부르지 않고 캐시만 조회한다. 캐시를 채우는 경로는
// `routes_sync` · `consumers_sync` 두 개뿐이다 — 프런트의 부트스트랩(기동 · 환경 전환 ·
// 상단 새로고침 버튼)과 저장·삭제 직후의 재동기화가 이들을 호출한다.
//
// sync 커맨드는 조회 결과를 돌려주지 않고 건수만 준다. 조회 축이 셋(chip · 검색어 · 컨슈머)이라
// 채우기에 필터를 실어 보내면 호출부마다 세 인자를 끌고 다녀야 하기 때문이다.
// 채우기와 읽기를 나누고 프런트가 둘을 이어 부른다 — 메모리 SQLite 라 왕복 비용이 없다.

fn cache(app: &AppHandle<Wry>) -> AppResult<tauri::State<'_, Cache>> {
    app.try_state::<Cache>()
        .ok_or_else(|| AppError::internal("로컬 캐시가 초기화되지 않았습니다."))
}

/// 게이트웨이에서 Route 전체 목록을 다시 받아 캐시를 통째로 갱신한다. 반환값은 건수다.
///
/// 잠금을 `.await` 너머로 들고 가지 않는다 — `Cache::with` 가 잡는 `MutexGuard` 는 `!Send` 라
/// 그 상태로 await 하면 커맨드 future 가 `!Send` 가 되고 `#[tauri::command]` 매크로가
/// 알아보기 힘든 에러를 낸다. 반드시 먼저 받아 오고, 그 다음 캐시에 넣는다.
#[tauri::command]
pub async fn routes_sync(app: AppHandle<Wry>, env: Env) -> AppResult<usize> {
    let routes = routes::list(&app, env).await?;
    let n = routes.len();
    cache(&app)?.with(|conn| db::sync_routes(conn, env.as_str(), &routes))?;
    Ok(n)
}

/// 캐시만 조회한다 (게이트웨이 호출 없음).
#[tauri::command]
pub fn routes_query(
    app: AppHandle<Wry>,
    env: Env,
    chip: String,
    q: String,
    // 프런트는 `namePrefix` 로 보낸다 — Tauri 가 camelCase 를 snake_case 로 맞춰 준다
    // (`oas_compare` 의 `service_id` 와 같다).
    name_prefix: String,
    scope: RouteScope,
) -> AppResult<RoutesPage> {
    // 다섯 번째 축은 프런트가 고르는 것이 아니라 토큰이 정한다 (`db::SERVICE_CLAUSE`).
    let allow = perm::resolve(env).allow_blob();
    cache(&app)?
        .with(|conn| db::query_routes(conn, env.as_str(), &chip, &q, &name_prefix, &scope, &allow))
}

/// 게이트웨이에서 Consumer 전체 목록을 다시 받아 캐시를 갱신하고, 그 목록을 돌려준다.
///
/// Route 와 달리 목록을 그대로 돌려주는 이유: Consumer 는 건수가 적어 프런트가 배열을 통째로
/// 들고 필터링하고(`store.filterConsumers`), 권한그룹 콤보 옵션도 이 배열에서 파생한다.
#[tauri::command]
pub async fn consumers_sync(app: AppHandle<Wry>, env: Env) -> AppResult<Vec<ConsumerView>> {
    let items = consumers::list(&app, env).await?;
    cache(&app)?.with(|conn| db::sync_consumers(conn, env.as_str(), &items))?;
    Ok(items)
}

/// 캐시의 Consumer 전체 목록 (게이트웨이 호출 없음).
#[tauri::command]
pub fn consumers_cached(app: AppHandle<Wry>, env: Env) -> AppResult<Vec<ConsumerView>> {
    cache(&app)?.with(|conn| db::consumers_cached(conn, env.as_str()))
}

/// Route 화면 좌측 패널이 쓰는 컨슈머별 접근 가능 건수. routes·consumers 가 모두 동기화된
/// 뒤에 부른다.
#[tauri::command]
pub fn consumer_access_counts(app: AppHandle<Wry>, env: Env) -> AppResult<AccessCounts> {
    let allow = perm::resolve(env).allow_blob();
    cache(&app)?.with(|conn| db::consumer_access_counts(conn, env.as_str(), &allow))
}

/// 캐시에서 라우트 한 건. 목록이 필터돼 있어도 상세로 갈 수 있게 해 준다.
#[tauri::command]
pub fn route_cached(app: AppHandle<Wry>, env: Env, id: String) -> AppResult<Option<RouteView>> {
    cache(&app)?.with(|conn| db::route_view(conn, env.as_str(), &id))
}

// ── OAS Import ───────────────────────────────────────────────

/// 스펙을 어디서 읽을지. 프런트는 세 경로 모두 이 커맨드로 모은다.
///
/// - `text` — 드래그&드롭. 웹뷰가 이미 내용을 들고 있으므로 그대로 넘긴다.
/// - `path` — 파일 다이얼로그가 준 경로. 웹뷰에 `fs:` 권한을 주지 않으려고 Rust 가 읽는다.
/// - `url`  — CSP 가 프런트 fetch 를 막고 있으므로 반드시 여기서 받아야 한다.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub kind: String,
    pub value: String,
}

/// URL 로 받는 스펙의 크기 상한. 이보다 큰 OAS 문서는 실무에서 나오지 않는다.
const MAX_SPEC_BYTES: usize = 8 * 1024 * 1024;

/// 스펙을 읽어 파싱하고, 비교용으로 캐시에 적재한다.
#[tauri::command]
pub async fn oas_load(app: AppHandle<Wry>, env: Env, source: ImportSource) -> AppResult<OasDoc> {
    let text = match source.kind.as_str() {
        "text" => source.value.clone(),
        "path" => std::fs::read_to_string(&source.value).map_err(|e| {
            AppError::new(
                crate::error::ErrorKind::BadRequest,
                format!("파일을 읽지 못했습니다: {e}"),
            )
            .with_hint("파일이 이동·삭제되지 않았는지 확인하세요.")
        })?,
        "url" => {
            // 프록시 우회는 화면에서 고르지 않는다 — `config::load` 가 항상 켜 두고
            // (`config.rs` 모듈 주석), 스펙 조회도 게이트웨이와 같은 정책을 따른다.
            let settings = config::load(&app);
            let cfg = settings.get(env);
            client::fetch_text(cfg, &source.value, MAX_SPEC_BYTES).await?
        }
        other => {
            return Err(AppError::internal(format!("알 수 없는 입력 방식입니다: {other}")));
        }
    };

    let doc = oas::parse(&text)?;
    cache(&app)?.with(|conn| db::load_oas_ops(conn, &doc.ops))?;
    Ok(doc)
}

/// 적재된 스펙을 선택한 service 안의 라우트와 비교한다.
#[tauri::command]
pub fn oas_compare(
    app: AppHandle<Wry>,
    env: Env,
    service_id: String,
    prefix: String,
) -> AppResult<Vec<CompareRow>> {
    if service_id.trim().is_empty() {
        return Err(AppError::config("비교할 service 를 선택하세요."));
    }
    require_service(env, &service_id)?;
    cache(&app)?.with(|conn| db::compare(conn, env.as_str(), service_id.trim(), &prefix))
}

// ── Consumer ─────────────────────────────────────────────────

#[tauri::command]
pub async fn consumer_save(
    app: AppHandle<Wry>,
    env: Env,
    form: ConsumerForm,
) -> AppResult<ConsumerView> {
    consumers::save(&app, env, form).await
}

#[tauri::command]
pub async fn consumer_delete(app: AppHandle<Wry>, env: Env, username: String) -> AppResult<()> {
    consumers::delete(&app, env, &username).await
}

// ── Upstream ─────────────────────────────────────────────────
//
// 전체 관리자가 아니면 레일에서 Upstream 메뉴가 사라지지만, **조회는 막지 않는다** —
// Service 콤보의 `(host:port)` 라벨이 upstream 캐시에서 오므로 부트스트랩이 이걸 돌려야
// Route 폼의 service 목록이 온전해진다. 변경(save · delete)만 admin 전용이다.

/// 게이트웨이에서 Upstream 전체 목록을 다시 받아 캐시를 갱신하고, 그 목록을 돌려준다.
///
/// `routes_sync` 와 달리 목록을 그대로 돌려주는 이유는 `consumers_sync` 와 같다 — 건수가
/// 적고, Service 폼의 upstream 콤보가 이 배열에서 곧바로 파생한다.
#[tauri::command]
pub async fn upstreams_sync(app: AppHandle<Wry>, env: Env) -> AppResult<Vec<UpstreamView>> {
    let items = upstreams::list(&app, env).await?;
    cache(&app)?.with(|conn| db::sync_upstreams(conn, env.as_str(), &items))?;
    Ok(items)
}

/// 캐시의 Upstream 전체 목록 (게이트웨이 호출 없음).
#[tauri::command]
pub fn upstreams_cached(app: AppHandle<Wry>, env: Env) -> AppResult<Vec<UpstreamView>> {
    cache(&app)?.with(|conn| db::upstreams_cached(conn, env.as_str()))
}

#[tauri::command]
pub async fn upstream_save(
    app: AppHandle<Wry>,
    env: Env,
    form: UpstreamForm,
) -> AppResult<UpstreamView> {
    require_admin(env)?;
    upstreams::save(&app, env, form).await
}

#[tauri::command]
pub async fn upstream_delete(
    app: AppHandle<Wry>,
    env: Env,
    id: String,
    name: Option<String>,
) -> AppResult<()> {
    require_admin(env)?;
    upstreams::delete(&app, env, &id, name.as_deref().unwrap_or("")).await
}

// ── Service ──────────────────────────────────────────────────

/// 게이트웨이에서 Service 전체 목록을 다시 받아 캐시를 갱신하고, 그 목록을 돌려준다.
///
/// upstream 라벨(`10.20.3.11:8080`)은 **캐시**에서 읽는다. `GET /upstreams` 를 한 번 더
/// 부르지 않기 위한 것이고, 부트스트랩이 upstream 을 먼저 돌리므로 정상 흐름에서는 항상
/// 채워져 있다. 비어 있어도 라벨의 `(host:port)` 조각만 빠질 뿐 조회는 성립한다.
#[tauri::command]
pub async fn services_sync(app: AppHandle<Wry>, env: Env) -> AppResult<Vec<ServiceView>> {
    let ups = cached_upstreams(&app, env)?;
    let items = services::list(&app, env, &ups).await?;
    // 캐시에는 **전체**를 넣는다 — Route 목록의 name 접두사, upstream 라벨, OAS 비교가
    // 권한과 무관하게 전체 service 를 참조한다. 프런트로는 권한 있는 것만 내려보낸다.
    cache(&app)?.with(|conn| db::sync_services(conn, env.as_str(), &items))?;
    Ok(perm::resolve(env).filter_services(items))
}

/// 캐시의 Service 전체 목록 (게이트웨이 호출 없음).
#[tauri::command]
pub fn services_cached(app: AppHandle<Wry>, env: Env) -> AppResult<Vec<ServiceView>> {
    let items = cache(&app)?.with(|conn| db::services_cached(conn, env.as_str()))?;
    // 프런트의 `services` 배열은 Service 화면 · Route 폼의 콤보 · Import 화면이 함께 읽는다.
    // 여기서 한 번 걸러 두면 세 화면이 각자 필터를 들 필요가 없다.
    Ok(perm::resolve(env).filter_services(items))
}

#[tauri::command]
pub async fn service_save(
    app: AppHandle<Wry>,
    env: Env,
    form: ServiceForm,
) -> AppResult<ServiceView> {
    require_admin(env)?;
    let ups = cached_upstreams(&app, env)?;
    services::save(&app, env, form, &ups).await
}

#[tauri::command]
pub async fn service_delete(
    app: AppHandle<Wry>,
    env: Env,
    id: String,
    name: Option<String>,
) -> AppResult<()> {
    require_admin(env)?;
    services::delete(&app, env, &id, name.as_deref().unwrap_or("")).await
}

/// 잠금을 `.await` 너머로 들고 가지 않으려고 따로 뽑아 둔 헬퍼 (위 `routes_sync` 주석 참조).
fn cached_upstreams(app: &AppHandle<Wry>, env: Env) -> AppResult<Vec<UpstreamView>> {
    cache(app)?.with(|conn| db::upstreams_cached(conn, env.as_str()))
}

// ── 대시보드 ─────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardPayload {
    pub overview: Overview,
    pub activity: Vec<EntryView>,
    pub base_url: String,
    pub admin_base: String,
    pub token_masked: String,
    pub no_proxy: bool,
    pub insecure_tls: bool,
}

#[tauri::command]
pub async fn dashboard(app: AppHandle<Wry>, env: Env) -> AppResult<DashboardPayload> {
    // KPI 중 route·consumer 건수는 캐시에서 센다 — 대시보드를 열 때마다 전체 목록을 다시
    // 받으면 "기동 시 1회 조회"가 무의미해진다. 잠금은 await 전에 풀어 둔다.
    let allow = perm::resolve(env).allow_blob();
    let counts = cache(&app)?.with(|conn| db::overview_counts(conn, env.as_str(), &allow))?;
    let overview = meta::overview(&app, env, counts).await?;
    let settings = config::load(&app);
    let cfg = settings.get(env);
    Ok(DashboardPayload {
        overview,
        activity: history::list(&app, env, 6),
        base_url: cfg.base_url.clone(),
        admin_base: cfg.admin_base().unwrap_or_else(|_| cfg.base_url.clone()),
        token_masked: config::get_token(env)
            .as_deref()
            .map(config::mask)
            .unwrap_or_else(|| "미설정".into()),
        no_proxy: cfg.no_proxy,
        insecure_tls: cfg.insecure_tls,
    })
}

// ── JWT ──────────────────────────────────────────────────────

/// nbf · exp 를 넘기지 않으면 고정값을 쓴다 (nbf 2025-08-01 00:00, exp 3000-12-31 17:59).
#[tauri::command]
pub fn jwt_sign(
    key: String,
    secret: String,
    nbf: Option<i64>,
    exp: Option<i64>,
) -> AppResult<JwtResult> {
    jwt::sign(&key, &secret, nbf, exp)
}

#[tauri::command]
pub fn gen_secret() -> String {
    jwt::gen_secret()
}

// ── 관리키 발급 (전체 관리자 전용) ───────────────────────────

/// 발급 요청. `perm` 은 `"admin"` 이거나 service id 목록이다.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminTokenRequest {
    /// 서명 secret. 발급자가 직접 입력한다 — 게이트웨이의 관리 consumer 에 등록된
    /// `jwt-auth.secret` 과 같아야 발급한 관리키가 실제로 통한다.
    pub secret: String,
    /// 시작일 unix 초 (로컬 자정)
    pub nbf: i64,
    /// 종료일 unix 초
    pub exp: i64,
    /// true 면 전체 관리자 토큰, false 면 `services` 에 나열한 service 만
    pub admin: bool,
    #[serde(default)]
    pub services: Vec<String>,
}

/// 발급 결과. 화면이 보여 주고 복사하는 것은 `admin_key` — 받는 사람이 설정 화면에
/// 그대로 붙여넣는 값이다. 토큰 하나만 건네면 secret 이 빠져 아무데도 쓸 수 없다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminTokenResult {
    /// 배포용 관리키 — `secret$token`.
    pub admin_key: String,
    /// 서명 결과 자체 (payload · nbf · exp 표시에 쓴다).
    #[serde(flatten)]
    pub jwt: JwtResult,
}

/// 관리키를 발급한다. **서명만 한다** — 실제로 쓰려면 게이트웨이에 같은 key·secret 의
/// consumer 가 등록돼 있어야 한다 (화면에 안내한다).
///
/// `env` 는 "누가 요청했는가" 를 판정하기 위한 것이다. 개발이 전체 관리자이고 운영이 아닐 수
/// 있으므로, 지금 보고 있는 환경의 관리키가 admin 일 때만 발급을 허용한다.
#[tauri::command]
pub fn admin_token_create(env: Env, req: AdminTokenRequest) -> AppResult<AdminTokenResult> {
    require_admin(env)?;
    // 정렬·중복 제거·빈 목록 거부와 secret 검사는 `jwt::sign_admin` 이 한다 — 토큰 문자열의
    // 모양을 정하는 곳이 한 군데여야 같은 권한이 언제나 같은 토큰이 된다.
    let perm = if req.admin { Perm::Admin } else { Perm::Services(req.services) };
    let jwt = jwt::sign_admin(&req.secret, req.nbf, req.exp, &perm)?;
    // 합치는 규칙은 `perm::join` 이 정한다 — 쪼개는 `split` 과 짝이어야 한다.
    Ok(AdminTokenResult { admin_key: perm::join(&req.secret, &jwt.token), jwt })
}

// ── 창 ───────────────────────────────────────────────────────

/// 프런트가 첫 렌더를 마친 뒤 호출한다. 흰 화면이 번쩍이는 것을 막기 위해
/// 창은 `visible: false` 로 만들고 여기서 보여준다.
#[tauri::command]
pub fn app_ready(app: AppHandle<Wry>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
