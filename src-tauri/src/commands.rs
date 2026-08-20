//! 프런트가 부르는 모든 IPC 커맨드.
//!
//! 게이트웨이로 나가는 HTTP 는 전부 여기를 거친다 — 웹뷰는 게이트웨이를 직접 호출하지 않는다
//! (그래야 시스템 프록시를 확실히 우회할 수 있다. apisix/client.rs 주석 참조).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

use crate::apisix::consumers::{self, ConsumerForm};
use crate::apisix::meta::{self, Overview};
use crate::apisix::models::{ConsumerView, RouteView, ServiceOption};
use crate::apisix::routes::{self, RouteForm};
use crate::apisix::client;
use crate::config::{self, Env, EnvConfig, SettingsView};
use crate::db::{self, Cache, CompareRow, RoutesPage};
use crate::error::{AppError, AppResult};
use crate::history::{self, EntryView};
use crate::jwt::{self, JwtResult};
use crate::oas::{self, OasDoc};

// ── 설정 ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvPayload {
    pub base_url: String,
    pub no_proxy: bool,
    pub insecure_tls: bool,
    /// `null` = 기존 토큰 유지, `""` = 삭제, 그 외 = 교체
    #[serde(default)]
    pub token: Option<String>,
}

impl EnvPayload {
    fn to_cfg(&self) -> EnvConfig {
        EnvConfig {
            base_url: self.base_url.trim().to_string(),
            no_proxy: self.no_proxy,
            insecure_tls: self.insecure_tls,
        }
    }
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
        config::set_token(env, t)?;
    }
    config::save_env(&app, env, payload.to_cfg())?;
    Ok(config::settings_view(&app))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    /// 디자인 형식: `200 OK · APISIX 3.9.1 · 42ms`
    pub text: String,
}

/// 연결 테스트는 **저장 전 입력값**으로 즉석 호출한다.
/// token 이 null 이면 이미 저장된 토큰을 쓴다.
#[tauri::command]
pub async fn settings_test(app: AppHandle<Wry>, env: Env, payload: EnvPayload) -> TestResult {
    let token = match &payload.token {
        Some(t) if !t.trim().is_empty() => t.clone(),
        _ => match config::get_token(env) {
            Some(t) => t,
            None => {
                return TestResult { ok: false, text: "토큰이 없어 호출할 수 없습니다.".into() }
            }
        },
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
    routes::save(&app, env, form).await
}

#[tauri::command]
pub async fn route_delete(
    app: AppHandle<Wry>,
    env: Env,
    id: String,
    name: Option<String>,
) -> AppResult<()> {
    routes::delete(&app, env, &id, name.as_deref().unwrap_or("")).await
}

// ── Route 캐시 (내장 SQLite) ─────────────────────────────────
//
// 목록 검색·필터는 게이트웨이를 다시 부르지 않고 캐시에서 처리한다. 캐시를 채우는 경로는
// `routes_sync` 하나뿐이다 — 목록 화면 진입과 상단 리프레시 버튼이 이걸 호출한다.

fn cache(app: &AppHandle<Wry>) -> AppResult<tauri::State<'_, Cache>> {
    app.try_state::<Cache>()
        .ok_or_else(|| AppError::internal("로컬 캐시가 초기화되지 않았습니다."))
}

/// 게이트웨이에서 전체 목록을 다시 받아 캐시를 통째로 갱신하고 첫 조회 결과를 돌려준다.
#[tauri::command]
pub async fn routes_sync(app: AppHandle<Wry>, env: Env, chip: String, q: String) -> AppResult<RoutesPage> {
    let routes = routes::list(&app, env).await?;
    let cache = cache(&app)?;
    cache.with(|conn| {
        db::sync_routes(conn, env.as_str(), &routes)?;
        db::query_routes(conn, env.as_str(), &chip, &q)
    })
}

/// 캐시만 조회한다 (게이트웨이 호출 없음).
#[tauri::command]
pub fn routes_query(app: AppHandle<Wry>, env: Env, chip: String, q: String) -> AppResult<RoutesPage> {
    cache(&app)?.with(|conn| db::query_routes(conn, env.as_str(), &chip, &q))
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
    /// `url` 일 때만 의미 있다. 미지정이면 해당 환경의 설정을 따른다.
    #[serde(default)]
    pub no_proxy: Option<bool>,
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
            let settings = config::load(&app);
            let mut cfg = settings.get(env).clone();
            if let Some(np) = source.no_proxy {
                cfg.no_proxy = np;
            }
            client::fetch_text(&cfg, &source.value, MAX_SPEC_BYTES).await?
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
    cache(&app)?.with(|conn| db::compare(conn, env.as_str(), service_id.trim(), &prefix))
}

// ── Consumer ─────────────────────────────────────────────────

#[tauri::command]
pub async fn consumers_list(app: AppHandle<Wry>, env: Env) -> AppResult<Vec<ConsumerView>> {
    consumers::list(&app, env).await
}

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

// ── Service (읽기 전용) ──────────────────────────────────────

#[tauri::command]
pub async fn services_list(app: AppHandle<Wry>, env: Env) -> AppResult<Vec<ServiceOption>> {
    meta::services(&app, env).await
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
    let overview = meta::overview(&app, env).await?;
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
