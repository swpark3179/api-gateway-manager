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
use crate::error::{AppError, AppResult};
use crate::history::{self, EntryView};
use crate::jwt::{self, JwtResult};

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

#[tauri::command]
pub async fn routes_list(app: AppHandle<Wry>, env: Env) -> AppResult<Vec<RouteView>> {
    routes::list(&app, env).await
}

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
