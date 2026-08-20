//! 환경(개발/운영)별 접속 설정.
//!
//! 비밀이 아닌 값(baseUrl, 토글 2종)은 tauri-plugin-store 의 `settings.json` 에,
//! 관리 토큰(X-API-KEY)은 **Windows 자격 증명 관리자**에 따로 보관한다.
//! 토큰 원문은 프런트로 절대 내려보내지 않는다 — 마스킹된 표시용 문자열만 준다.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Wry};
use tauri_plugin_store::StoreExt;

use crate::error::{AppError, AppResult};

const STORE_FILE: &str = "settings.json";
const STORE_KEY: &str = "environments";
const KEYRING_SERVICE: &str = "api-gateway-manager";

/// 환경 식별자. 프런트에서는 "dev" / "prod" 문자열로 오간다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Env {
    Dev,
    Prod,
}

impl Env {
    pub fn as_str(self) -> &'static str {
        match self {
            Env::Dev => "dev",
            Env::Prod => "prod",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Env::Dev => "개발",
            Env::Prod => "운영",
        }
    }

    fn keyring_account(self) -> String {
        format!("apisix-admin-token::{}", self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvConfig {
    /// 예: https://gw-dev.internal.sds:9180 — 경로 `/apisix/admin` 은 앱이 붙인다.
    pub base_url: String,
    /// 시스템 프록시를 우회해 직접 호출할지. 기본 ON.
    pub no_proxy: bool,
    /// TLS 인증서 검증을 건너뛸지. 기본 OFF.
    pub insecure_tls: bool,
}

impl EnvConfig {
    fn default_for(env: Env) -> Self {
        // 디자인 목업이 제시한 사내 호스트를 초기값으로 둔다. 사용자가 설정 화면에서 바꾼다.
        let base_url = match env {
            Env::Dev => "https://gw-dev.internal.sds:9180",
            Env::Prod => "https://gw.internal.sds:9180",
        };
        Self { base_url: base_url.to_string(), no_proxy: true, insecure_tls: false }
    }

    /// baseUrl 을 정규화해 `{base}/apisix/admin` 형태의 접두사를 만든다.
    pub fn admin_base(&self) -> AppResult<String> {
        let mut b = self.base_url.trim().trim_end_matches('/').to_string();
        if b.is_empty() {
            return Err(AppError::config("baseUrl 이 설정되지 않았습니다."));
        }
        if !b.starts_with("http://") && !b.starts_with("https://") {
            b = format!("https://{b}");
        }
        // 사용자가 실수로 /apisix/admin 까지 넣은 경우를 흡수한다.
        let b = b.trim_end_matches("/apisix/admin").trim_end_matches('/').to_string();
        Ok(format!("{b}/apisix/admin"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub dev: EnvConfig,
    pub prod: EnvConfig,
}

impl Default for Settings {
    fn default() -> Self {
        Self { dev: EnvConfig::default_for(Env::Dev), prod: EnvConfig::default_for(Env::Prod) }
    }
}

impl Settings {
    pub fn get(&self, env: Env) -> &EnvConfig {
        match env {
            Env::Dev => &self.dev,
            Env::Prod => &self.prod,
        }
    }

    fn set(&mut self, env: Env, cfg: EnvConfig) {
        match env {
            Env::Dev => self.dev = cfg,
            Env::Prod => self.prod = cfg,
        }
    }
}

// ── store I/O ────────────────────────────────────────────────

pub fn load(app: &AppHandle<Wry>) -> Settings {
    let Ok(store) = app.store(STORE_FILE) else {
        return Settings::default();
    };
    store
        .get(STORE_KEY)
        .and_then(|v| serde_json::from_value::<Settings>(v).ok())
        .unwrap_or_default()
}

pub fn save_env(app: &AppHandle<Wry>, env: Env, cfg: EnvConfig) -> AppResult<()> {
    let mut settings = load(app);
    settings.set(env, cfg);

    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::internal(format!("설정 저장소를 열지 못했습니다: {e}")))?;
    store.set(STORE_KEY, serde_json::to_value(&settings)?);
    store
        .save()
        .map_err(|e| AppError::internal(format!("설정을 저장하지 못했습니다: {e}")))?;

    // 설정이 바뀌면 no_proxy / insecure_tls 가 다를 수 있으므로 HTTP 클라이언트 캐시를 버린다.
    crate::apisix::client::invalidate(app, env);
    Ok(())
}

// ── 자격 증명 (Windows Credential Manager) ───────────────────

fn entry(env: Env) -> AppResult<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &env.keyring_account()).map_err(AppError::from)
}

pub fn get_token(env: Env) -> Option<String> {
    let e = entry(env).ok()?;
    match e.get_password() {
        Ok(t) if !t.trim().is_empty() => Some(t),
        _ => None,
    }
}

pub fn set_token(env: Env, token: &str) -> AppResult<()> {
    let e = entry(env)?;
    if token.trim().is_empty() {
        // 빈 값 저장은 "삭제" 로 취급한다 — 그래야 해당 환경이 잠금 상태로 돌아간다.
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(AppError::from(err)),
        }
    } else {
        e.set_password(token).map_err(AppError::from)
    }
}

/// 표시용 마스킹. 디자인의 `cfg.token.slice(0,6) + '••••••••••••'` 규칙을 따른다.
pub fn mask(token: &str) -> String {
    let head: String = token.chars().take(6).collect();
    format!("{head}••••••••••••")
}

// ── 프런트로 내려보내는 뷰 모델 ──────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvConfigView {
    pub base_url: String,
    pub no_proxy: bool,
    pub insecure_tls: bool,
    /// 토큰이 등록되어 있는지. 잠금 화면 판정에 쓴다.
    pub has_token: bool,
    /// 마스킹된 토큰 표시 문자열 (미설정이면 빈 문자열)
    pub token_masked: String,
    /// `{baseUrl}/apisix/admin` — 사이드 패널 ENDPOINT 표기에 그대로 쓴다.
    pub admin_base: String,
}

pub fn view(cfg: &EnvConfig, env: Env) -> EnvConfigView {
    let token = get_token(env);
    EnvConfigView {
        base_url: cfg.base_url.clone(),
        no_proxy: cfg.no_proxy,
        insecure_tls: cfg.insecure_tls,
        has_token: token.is_some(),
        token_masked: token.as_deref().map(mask).unwrap_or_default(),
        admin_base: cfg.admin_base().unwrap_or_else(|_| cfg.base_url.clone()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub dev: EnvConfigView,
    pub prod: EnvConfigView,
}

pub fn settings_view(app: &AppHandle<Wry>) -> SettingsView {
    let s = load(app);
    SettingsView { dev: view(&s.dev, Env::Dev), prod: view(&s.prod, Env::Prod) }
}

/// 게이트웨이를 호출하기 위한 확정된 접속 정보. 토큰이 없으면 Config 에러.
pub struct Resolved {
    pub admin_base: String,
    pub token: String,
    pub cfg: EnvConfig,
}

pub fn resolve(app: &AppHandle<Wry>, env: Env) -> AppResult<Resolved> {
    let settings = load(app);
    let cfg = settings.get(env).clone();
    let admin_base = cfg.admin_base()?;
    let token = get_token(env).ok_or_else(|| {
        AppError::config(format!("{} 서버의 관리 토큰이 등록되지 않았습니다.", env.label()))
            .with_hint("설정 화면에서 X-API-KEY 를 입력하세요.")
    })?;
    Ok(Resolved { admin_base, token, cfg })
}
