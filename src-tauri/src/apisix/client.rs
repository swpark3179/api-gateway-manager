//! APISIX Admin API 호출을 위한 **유일한** HTTP 진입점.
//!
//! # 프록시 우회 (이 앱의 핵심 제약)
//!
//! Windows 에 시스템 프록시가 설정되어 있어도 게이트웨이 통신은 반드시 직접 나가야 한다.
//! 이를 "잘 지키기"가 아니라 구조로 강제한다:
//!
//! 1. `reqwest::Client` 는 이 파일의 [`build`] 에서만 만든다. 다른 모듈에서
//!    `reqwest::Client::new()` 를 직접 부르면 시스템 프록시를 타게 되므로 금지한다.
//! 2. `no_proxy` 설정이 켜져 있으면 `ClientBuilder::no_proxy()` 를 호출한다.
//!    이것은 시스템 프록시 자동 탐지와 `HTTP_PROXY`/`HTTPS_PROXY` 환경변수를 **모두** 무시한다.
//! 3. 프런트엔드(WebView2)는 시스템 프록시를 따르므로 게이트웨이를 직접 fetch 하면 안 된다.
//!    `tauri.conf.json` 의 CSP 가 `connect-src 'self' ipc:` 로 웹뷰의 외부 통신을 막아
//!    규칙 위반이 런타임에 즉시 드러나게 해 두었다.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use reqwest::Method;
use serde_json::Value;
use tauri::{AppHandle, Manager, Wry};

use crate::config::{self, Env, EnvConfig};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::history;

/// 요청 1건의 관측값. 대시보드의 "응답 시간"·"APISIX 버전"이 여기서 나온다.
#[derive(Debug, Clone, Default)]
pub struct Meta {
    pub status: u16,
    pub elapsed_ms: u64,
    /// `Server: APISIX/3.9.1` 헤더에서 파싱한 버전
    pub server_version: Option<String>,
}

#[derive(Default)]
pub struct ClientCache {
    clients: Mutex<HashMap<String, reqwest::Client>>,
    /// 환경별 마지막 성공 관측값 (대시보드 연결 상태 카드용)
    last_meta: Mutex<HashMap<String, Meta>>,
}

fn cache_key(env: Env, cfg: &EnvConfig) -> String {
    format!("{}|{}|{}", env.as_str(), cfg.no_proxy, cfg.insecure_tls)
}

/// 설정이 바뀌었을 때 해당 환경의 캐시된 클라이언트를 버린다.
pub fn invalidate(app: &AppHandle<Wry>, env: Env) {
    if let Some(cache) = app.try_state::<ClientCache>() {
        if let Ok(mut m) = cache.clients.lock() {
            m.retain(|k, _| !k.starts_with(&format!("{}|", env.as_str())));
        }
    }
}

pub fn last_meta(app: &AppHandle<Wry>, env: Env) -> Option<Meta> {
    let cache = app.try_state::<ClientCache>()?;
    let m = cache.last_meta.lock().ok()?;
    m.get(env.as_str()).cloned()
}

fn record_meta(app: &AppHandle<Wry>, env: Env, meta: &Meta) {
    if let Some(cache) = app.try_state::<ClientCache>() {
        if let Ok(mut m) = cache.last_meta.lock() {
            m.insert(env.as_str().to_string(), meta.clone());
        }
    }
}

/// 클라이언트 생성 — **프록시 정책이 결정되는 유일한 지점**.
pub(crate) fn build(cfg: &EnvConfig) -> AppResult<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .user_agent(concat!("api-gateway-manager/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(20))
        .pool_idle_timeout(std::time::Duration::from_secs(30));

    if cfg.no_proxy {
        // 시스템 프록시 자동 탐지 + HTTP(S)_PROXY 환경변수를 모두 무시하고 직접 연결한다.
        b = b.no_proxy();
    }

    if cfg.insecure_tls {
        // 설정 화면에서 사용자가 명시적으로 켠 경우에만 적용된다 (기본 OFF).
        b = b.danger_accept_invalid_certs(true);
    }

    b.build()
        .map_err(|e| AppError::internal(format!("HTTP 클라이언트를 만들지 못했습니다: {e}")))
}

fn client_for(app: &AppHandle<Wry>, env: Env, cfg: &EnvConfig) -> AppResult<reqwest::Client> {
    let key = cache_key(env, cfg);
    let cache = app
        .try_state::<ClientCache>()
        .ok_or_else(|| AppError::internal("HTTP 클라이언트 캐시가 초기화되지 않았습니다."))?;

    if let Ok(m) = cache.clients.lock() {
        if let Some(c) = m.get(&key) {
            return Ok(c.clone());
        }
    }

    let c = build(cfg)?;
    if let Ok(mut m) = cache.clients.lock() {
        m.insert(key, c.clone());
    }
    Ok(c)
}

fn parse_server_version(headers: &reqwest::header::HeaderMap) -> Option<String> {
    // 예: "APISIX/3.9.1" → "3.9.1"
    let raw = headers.get(reqwest::header::SERVER)?.to_str().ok()?;
    let v = raw.split('/').nth(1).unwrap_or(raw).trim();
    if v.is_empty() { None } else { Some(v.to_string()) }
}

/// Admin API 호출. `path` 는 `/apisix/admin` 이후의 경로 (예: "routes", "routes/1").
///
/// 성공 시 응답 JSON(본문이 비어 있으면 `Value::Null`)과 관측값을 돌려준다.
pub async fn request(
    app: &AppHandle<Wry>,
    env: Env,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> AppResult<(Value, Meta)> {
    let resolved = config::resolve(app, env)?;
    let client = client_for(app, env, &resolved.cfg)?;

    let url = format!("{}/{}", resolved.admin_base, path.trim_start_matches('/'));
    let mut req = client
        .request(method.clone(), &url)
        .header("X-API-KEY", &resolved.token)
        .header(reqwest::header::ACCEPT, "application/json");

    if let Some(b) = body {
        req = req.json(b);
    }

    let started = Instant::now();
    let res = req.send().await;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    let res = match res {
        Ok(r) => r,
        Err(e) => {
            let err = AppError::from(e);
            history::record_failure(app, env, method.as_str(), &url, &err.message);
            return Err(err);
        }
    };

    let status = res.status().as_u16();
    let meta = Meta { status, elapsed_ms, server_version: parse_server_version(res.headers()) };
    let text = res.text().await.unwrap_or_default();

    if !(200..300).contains(&status) {
        let err = AppError::from_status(status, &text);
        history::record_failure(app, env, method.as_str(), &url, &err.message);
        return Err(err);
    }

    record_meta(app, env, &meta);

    let json = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str::<Value>(&text).map_err(|e| {
            AppError::new(ErrorKind::Gateway, format!("응답 JSON 을 해석하지 못했습니다: {e}"))
                .with_hint("Admin API 주소가 맞는지 확인하세요.")
        })?
    };

    Ok((json, meta))
}

/// 설정 화면 '연결 테스트' 전용.
///
/// 저장 전 입력값으로 즉석 호출해야 하므로 저장된 설정/토큰을 쓰지 않고
/// 인자로 받은 값으로 클라이언트를 새로 만든다.
pub async fn test_connection(cfg: &EnvConfig, token: &str) -> AppResult<Meta> {
    if token.trim().is_empty() {
        return Err(AppError::config("토큰이 없어 호출할 수 없습니다."));
    }
    let admin_base = cfg.admin_base()?;
    let client = build(cfg)?;

    let started = Instant::now();
    let res = client
        .get(format!("{admin_base}/routes"))
        .query(&[("page", "1"), ("page_size", "1")])
        .header("X-API-KEY", token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    let status = res.status().as_u16();
    let server_version = parse_server_version(res.headers());

    if !(200..300).contains(&status) {
        let text = res.text().await.unwrap_or_default();
        return Err(AppError::from_status(status, &text));
    }

    Ok(Meta { status, elapsed_ms, server_version })
}
