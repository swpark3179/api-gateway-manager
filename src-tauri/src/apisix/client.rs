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

/// 임의 URL 에서 텍스트를 받아온다 — OAS 스펙 Import 전용.
///
/// Admin API 가 아니므로 `X-API-KEY` 를 붙이지 않고, 응답을 JSON 으로 해석하지도 않는다.
/// 클라이언트는 이 파일의 [`build`] 를 그대로 쓴다 — 프록시 정책 결정 지점이 하나여야 한다.
/// 따라서 스펙 조회도 게이트웨이와 똑같이 **항상 시스템 프록시를 우회한다**
/// (`cfg.no_proxy` 는 `config::force_toggles` 가 항상 `true` 로 강제한다).
/// 예전에는 Import 화면의 체크박스로 이것만 뒤집을 수 있었는데, 사내 환경에서는 우회가
/// 켜져 있어야만 스펙 주소에도 닿아서 끌 이유가 없었다.
///
/// 실패 매핑이 [`AppError::from_spec_status`] 인 것이 [`request`] 와의 유일한 차이다 —
/// 토큰을 보내지 않는 호출의 401 / 403 을 관리키 탓으로 돌리지 않기 위한 것이다.
pub async fn fetch_text(cfg: &EnvConfig, url: &str, max_bytes: usize) -> AppResult<String> {
    let url = url.trim();
    // http(s) 만 허용한다. file:// 같은 스킴을 열어 두면 URL 입력란이 임의 파일 읽기가 된다.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::config("http:// 또는 https:// 로 시작하는 주소를 입력하세요."));
    }

    let client = build(cfg)?;
    let res = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/yaml, text/yaml, application/json, text/plain, */*")
        .send()
        .await?;

    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        let text = res.text().await.unwrap_or_default();
        return Err(AppError::from_spec_status(status, &text));
    }

    // Content-Length 를 믿을 수 없는 서버가 있으니 선언값과 실제 누적량을 둘 다 본다.
    if let Some(len) = res.content_length() {
        if len as usize > max_bytes {
            return Err(too_large(max_bytes));
        }
    }

    let mut res = res;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = res.chunk().await? {
        if buf.len() + chunk.len() > max_bytes {
            return Err(too_large(max_bytes));
        }
        buf.extend_from_slice(&chunk);
    }

    String::from_utf8(buf).map_err(|_| {
        AppError::new(ErrorKind::BadRequest, "응답이 UTF-8 텍스트가 아닙니다.")
            .with_hint("OAS 스펙 파일(.yaml · .yml · .json) 주소인지 확인하세요.")
    })
}

fn too_large(max_bytes: usize) -> AppError {
    AppError::new(
        ErrorKind::BadRequest,
        format!("응답이 너무 큽니다 (최대 {} MiB).", max_bytes / (1024 * 1024)),
    )
    .with_hint("스펙 파일을 내려받아 파일로 선택하세요.")
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
