//! 환경(개발/운영)별 접속 설정.
//!
//! baseUrl 은 tauri-plugin-store 의 `settings.json` 에, 관리키는 **Windows 자격 증명
//! 관리자**에 따로 보관한다. 평소 프런트로는 마스킹된 표시용 문자열만 내려가고,
//! 설정 화면에서 사용자가 `표시` 를 눌렀을 때만 `settings_reveal_token` 커맨드가 원문을
//! 준다 (README '보안' 절).
//!
//! 게이트웨이로 나가는 `X-API-KEY` 는 **사용자가 입력한 관리키 그대로**다 (`resolve`) —
//! `secret$token` 이든 평범한 admin key 한 줄이든 자르지 않는다. `$` 앞의 secret 은 그와
//! 별개로 권한을 읽는 데 쓰인다 (`perm.rs`). 다만 **마스킹 문자열에는 secret 이 섞이지
//! 않는다** (`mask`) — 화면에 뿌리는 값과 게이트웨이로 보내는 값은 서로 다른 문제다.
//!
//! `no_proxy` · `insecure_tls` 는 더 이상 사용자가 고르지 않는다 — 사내 환경에서 둘 다
//! 켜져 있어야만 게이트웨이에 닿으므로 항상 `true` 로 강제한다. `load()` 가 읽는 즉시
//! 정규화하므로 예전에 `false` 로 저장된 `settings.json` 도 재저장 없이 따라온다.
//! 필드 자체를 지우지는 않았다 — `tests.rs` 의 `proxy::no_proxy_bypasses_env_proxy` 가
//! `no_proxy = false` 로 뒤집어 보며 우회가 실제로 동작함을 실측하는 유일한 방어선이다.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::StoreExt;

use crate::error::{AppError, AppResult};
use crate::perm::{self, Perm, PermView};

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
    /// 예: http://60.101.107.90:9080 — 경로 `/apisix/admin` 은 앱이 붙인다.
    pub base_url: String,
    /// 시스템 프록시를 우회해 직접 호출할지. 항상 ON (`load()` 가 강제한다).
    pub no_proxy: bool,
    /// TLS 인증서 검증을 건너뛸지. 항상 ON (`load()` 가 강제한다).
    pub insecure_tls: bool,
}

impl EnvConfig {
    fn default_for(env: Env) -> Self {
        // 사내 게이트웨이 주소를 초기값으로 둔다. 사용자가 설정 화면에서 바꾼다.
        // 설정 화면의 placeholder 도 같은 값이라, 비워 두면 무엇을 넣어야 하는지가 그대로 보인다.
        let base_url = match env {
            Env::Dev => "http://60.101.107.90:9080",
            Env::Prod => "http://60.101.207.91:7096",
        };
        Self { base_url: base_url.to_string(), no_proxy: true, insecure_tls: true }
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

    /// 프록시 우회 · 인증서 검증 건너뛰기를 항상 켠다 (모듈 주석 참조).
    /// 저장할 때가 아니라 **읽을 때** 거는 이유: 예전 설정 파일을 재저장 없이 따라오게 하려고.
    pub(crate) fn force_toggles(&mut self) {
        for cfg in [&mut self.dev, &mut self.prod] {
            cfg.no_proxy = true;
            cfg.insecure_tls = true;
        }
    }
}

// ── store I/O ────────────────────────────────────────────────

pub fn load(app: &AppHandle<Wry>) -> Settings {
    let Ok(store) = app.store(STORE_FILE) else {
        return Settings::default();
    };
    let mut s = store
        .get(STORE_KEY)
        .and_then(|v| serde_json::from_value::<Settings>(v).ok())
        .unwrap_or_default();
    s.force_toggles();
    s
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

/// 저장된 관리키에서 `X-API-KEY` 에 실을 값을 뽑는다 — **자르지 않는다**.
///
/// 한 줄짜리 함수지만 이름을 붙여 둔다. 예전에는 여기서 `secret$token` 을 쪼개 뒤쪽만
/// 보냈고, 그 규칙이 `resolve` 와 `settings_test` 두 곳에 각각 적혀 있었다 — 한쪽만 고치면
/// "테스트는 되는데 저장하면 안 되는" 상태가 생긴다. 관리키가 어떤 모양이어야 하는지는
/// 게이트웨이가 정한다 (`perm.rs` 모듈 주석).
///
/// 앞뒤 공백만 터는 이유: 붙여넣기에 개행이 섞이는 일이 흔하고, 그 한 글자 때문에
/// 게이트웨이가 401 을 주면 원인을 찾기 어렵다.
pub fn api_key(raw: &str) -> &str {
    raw.trim()
}

/// 표시용 마스킹. 디자인의 `cfg.token.slice(0,6) + '••••••••••••'` 규칙을 따르되,
/// 자르는 대상은 관리키가 아니라 그 안의 **토큰**이다 — `secret$token` 형태라면 앞부분이
/// secret 이므로, 앞 6자를 그대로 보여 주면 secret 을 흘리게 된다.
///
/// 그 형태가 아니면 무엇도 드러내지 않고 점만 돌려준다 — 관리키 전체가 게이트웨이로 나가는
/// 자격 증명이라 앞자리도 보여 줄 이유가 없다. 어느 쪽이든 등록 여부는 `has_token` 이
/// 말해 주므로 표시 문자열이 값을 알려 줄 필요는 없다.
pub fn mask(raw: &str) -> String {
    let Ok(key) = perm::split(raw) else {
        return "••••••••••••••••••".to_string();
    };
    let head: String = key.token.chars().take(6).collect();
    format!("{head}••••••••••••")
}

// ── 프런트로 내려보내는 뷰 모델 ──────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvConfigView {
    pub base_url: String,
    pub no_proxy: bool,
    pub insecure_tls: bool,
    /// 관리키가 등록되어 있는지. 잠금 화면 판정에 쓴다.
    pub has_token: bool,
    /// 마스킹된 표시 문자열 (미설정이면 빈 문자열). secret 은 섞이지 않는다 (`mask`).
    pub token_masked: String,
    /// `{baseUrl}/apisix/admin` — 사이드 패널 ENDPOINT 표기에 그대로 쓴다.
    pub admin_base: String,
    /// 이 환경의 관리키가 주는 관리 권한. 메뉴 노출 · 잠금 판정 · 설정 화면 상세가 모두 이걸 본다.
    pub perm: PermView,
}

/// `names` 는 service id → name 을 찾아 주는 함수다 (`perm::view` 주석 참조).
pub fn view(cfg: &EnvConfig, env: Env, names: impl Fn(&str) -> Option<String>) -> EnvConfigView {
    let token = get_token(env);
    EnvConfigView {
        base_url: cfg.base_url.clone(),
        no_proxy: cfg.no_proxy,
        insecure_tls: cfg.insecure_tls,
        has_token: token.is_some(),
        token_masked: token.as_deref().map(mask).unwrap_or_default(),
        admin_base: cfg.admin_base().unwrap_or_else(|_| cfg.base_url.clone()),
        perm: perm::view(env, names),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub dev: EnvConfigView,
    pub prod: EnvConfigView,
}

/// 두 환경의 설정 뷰.
///
/// 권한 service 의 **이름**은 각 환경의 로컬 캐시에서 찾는다 — dev 화면에 있는 동안에도
/// prod 카드가 이름을 보여 줘야 하기 때문이다. 캐시가 비어 있으면(그 환경을 한 번도
/// 동기화하지 않았으면) id 를 그대로 쓴다.
pub fn settings_view(app: &AppHandle<Wry>) -> SettingsView {
    let s = load(app);
    SettingsView {
        dev: view(&s.dev, Env::Dev, service_namer(app, Env::Dev)),
        prod: view(&s.prod, Env::Prod, service_namer(app, Env::Prod)),
    }
}

/// 해당 환경의 service id → name 대응표를 캐시에서 한 번 읽어 클로저로 감싼다.
/// 캐시를 열지 못해도 설정 화면은 떠야 하므로 실패는 빈 표로 흡수한다.
fn service_namer(app: &AppHandle<Wry>, env: Env) -> impl Fn(&str) -> Option<String> {
    let map: std::collections::HashMap<String, String> = app
        .try_state::<crate::db::Cache>()
        .and_then(|c| c.with(|conn| crate::db::services_cached(conn, env.as_str())).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|s| !s.name.trim().is_empty())
        .map(|s| (s.id, s.name))
        .collect();
    move |id: &str| map.get(id).cloned()
}

/// 게이트웨이를 호출하기 위한 확정된 접속 정보. 관리키가 없으면 Config 에러.
pub struct Resolved {
    pub admin_base: String,
    /// `X-API-KEY` 에 실을 값 — 사용자가 입력한 **관리키 전체**다 (앞뒤 공백만 턴다).
    pub token: String,
    pub cfg: EnvConfig,
}

pub fn resolve(app: &AppHandle<Wry>, env: Env) -> AppResult<Resolved> {
    let settings = load(app);
    let cfg = settings.get(env).clone();
    let admin_base = cfg.admin_base()?;
    let raw = get_token(env).ok_or_else(|| {
        AppError::config(format!("{} 서버의 관리키가 등록되지 않았습니다.", env.label()))
            .with_hint("설정 화면에서 관리키를 입력하세요.")
    })?;
    // 기간이 지난 관리 토큰으로 게이트웨이를 두드려 401 을 받는 대신 여기서 이유를 말해 준다.
    // **형식 오류는 여기 걸리지 않는다** — 해석하지 못한 관리키는 `Perm::Opaque` 라 그대로
    // 나간다. 관리키가 어떤 모양이어야 하는지는 게이트웨이가 정한다 (`perm.rs` 모듈 주석).
    if let Perm::None(reason) = perm::resolve(env) {
        return Err(AppError::config(format!("{} {}", env.label(), reason.message()))
            .with_hint("설정 화면에서 관리키를 다시 등록하세요."));
    }
    Ok(Resolved { admin_base, token: api_key(&raw).to_string(), cfg })
}
