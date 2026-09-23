//! Upstream CRUD · 헬스체크 상태 조회 · 노드 직접 점검.
//!
//! # 왜 머지인가
//!
//! `routes.rs` 와 같은 이유다. 게이트웨이의 upstream 에는 이 앱이 폼으로 다루지 않는
//! 설정(`retries` · `scheme` · `pass_host` · `discovery_type` …)이 붙어 있을 수 있다.
//! 폼 값으로 객체를 새로 만들어 PUT 하면 그게 통째로 사라진다. 그래서 저장 직전에 원본을
//! GET 해 와 **앱이 관리하는 키(name · desc · nodes · timeout · checks 의 일부)만** 덮어쓴다.
//!
//! # checks (헬스체크)
//!
//! 폼이 다루는 것은 능동 검사(`checks.active`)의 주요 키와 수동 검사(`checks.passive`)의
//! 장애 판정 키뿐이다 ([`apply_checks`] 주석의 표). `concurrency` · `req_headers` ·
//! `https_verify_certificate` · `passive.healthy` 같은 나머지는 **같은 머지 규칙으로 보존**한다.
//! 폼의 빈 칸은 "그 키를 지워 APISIX 기본값에 맡긴다" 는 뜻이다 (`set_or_remove` 와 같은 규칙).
//!
//! # 현재 상태는 두 곳에서 본다
//!
//! | | [`health`] (Control API) | [`probe`] (이 PC 에서 직접) |
//! |---|---|---|
//! | 무엇을 보나 | 게이트웨이의 헬스체커가 판정한 상태 | 이 PC 에서 노드로 한 번 보낸 요청의 응답 |
//! | 대상 | 저장된 upstream | 폼의 노드 (저장 전에도 된다) |
//! | 전제 | Control API 에 닿아야 한다 | 이 PC 에서 노드에 닿아야 한다 |
//!
//! 게이트웨이가 실제로 쓰는 판정은 앞쪽뿐이다. 뒤쪽은 `http_path` 가 맞는지 등록 전에
//! 확인하는 용도라, 결과를 "게이트웨이 상태" 로 부르지 않는다 (네트워크 경로가 다르다).
//!
//! # nodes 표기
//!
//! 읽기는 맵(`{"h:p": w}`)·배열(`[{host,port,weight}]`) 둘 다 받고(`models::all_nodes`),
//! 쓰기는 **배열로 고정**한다. 맵 키에 `host:port` 를 조립해 넣으면 포트가 없는 노드나
//! IPv6 주소에서 표기가 애매해지고, weight 를 값 자리에 숨겨야 한다.

use std::time::{Duration, Instant};

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Wry};

use super::client;
use super::models::{
    extract_list, extract_one, obj, parse_health_checker, parse_health_list, set_or_remove,
    strip_server_fields, HealthChecker, UpstreamTimeout, UpstreamView, DEFAULT_UPSTREAM_TYPE,
};
use crate::config::{Env, EnvConfig};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::history;

/// 폼의 노드 한 줄. `weight` 는 화면에 없지만 조회 때 읽은 값을 그대로 실어 보낸다.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInput {
    pub host: String,
    pub port: i64,
    #[serde(default)]
    pub weight: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamForm {
    /// 비어 있으면 신규 등록 → `POST /upstreams` 로 APISIX 가 id 를 자동 생성한다.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub nodes: Vec<NodeInput>,
    #[serde(default)]
    pub timeout: UpstreamTimeout,
    /// 헬스체크. **`None` 이면 `checks` 를 건드리지 않는다** — 필드를 빠뜨린 호출이 게이트웨이의
    /// 헬스체크를 지우는 쪽으로 떨어지면 안 된다 (Consumer 의 `contacts` 와 같은 관례).
    /// 지우려면 `enabled: false` 를 보낸다.
    #[serde(default)]
    pub checks: Option<ChecksInput>,
}

// ── checks 폼 ────────────────────────────────────────────────
//
// 숫자는 전부 Option 이다. `None` = 폼의 빈 칸 = 그 키를 지워 APISIX 기본값에 맡긴다.
// 상태 코드 목록도 같아서, 빈 배열이면 키를 지운다 (APISIX 는 `minItems: 1` 이라 `[]` 를 거절한다).

/// APISIX 능동 검사 방식. 스키마의 enum 과 같다.
pub const CHECK_TYPES: [&str; 3] = ["http", "https", "tcp"];

fn default_check_type() -> String {
    "http".to_string()
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthyInput {
    #[serde(default)]
    pub interval: Option<i64>,
    #[serde(default)]
    pub successes: Option<i64>,
    #[serde(default)]
    pub http_statuses: Vec<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnhealthyInput {
    /// 능동 검사만 쓴다 (수동 검사에는 없는 키다)
    #[serde(default)]
    pub interval: Option<i64>,
    #[serde(default)]
    pub http_failures: Option<i64>,
    #[serde(default)]
    pub tcp_failures: Option<i64>,
    #[serde(default)]
    pub timeouts: Option<i64>,
    #[serde(default)]
    pub http_statuses: Vec<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassiveInput {
    /// false 면 `checks.passive` 를 지운다
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub unhealthy: UnhealthyInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksInput {
    /// false 면 `checks` 를 **통째로** 지운다 (수동 검사도 함께 — APISIX 는 능동 검사 없는
    /// 수동 검사를 받지 않는다)
    pub enabled: bool,
    #[serde(default = "default_check_type")]
    pub r#type: String,
    #[serde(default)]
    pub http_path: String,
    /// 검사 요청의 `Host` 헤더. 비우면 노드 주소가 그대로 쓰인다
    #[serde(default)]
    pub host: String,
    /// 검사 포트. 비우면 각 노드의 포트
    #[serde(default)]
    pub port: Option<i64>,
    /// 초
    #[serde(default)]
    pub timeout: Option<f64>,
    #[serde(default)]
    pub healthy: HealthyInput,
    #[serde(default)]
    pub unhealthy: UnhealthyInput,
    #[serde(default)]
    pub passive: PassiveInput,
}

impl ChecksInput {
    /// tcp 검사에는 HTTP 요청이 없다 — `http_path` · `host` · 상태 코드 · `http_failures` 가
    /// 뜻이 없으므로 저장 본문에서 뺀다 ([`apply_checks`]).
    pub fn is_http(&self) -> bool {
        self.r#type != "tcp"
    }

    fn validate(&self) -> AppResult<()> {
        if !self.enabled {
            return Ok(());
        }
        if !CHECK_TYPES.contains(&self.r#type.as_str()) {
            return Err(AppError::config(format!(
                "checks 의 type 은 http · https · tcp 중 하나여야 합니다 ({}).",
                self.r#type
            )));
        }
        if self.is_http() {
            let path = self.http_path.trim();
            if !path.is_empty() && (!path.starts_with('/') || path.chars().any(char::is_whitespace))
            {
                return Err(AppError::config(
                    "checks 의 http_path 는 / 로 시작하고 공백이 없어야 합니다.",
                ));
            }
            if self.host.trim().chars().any(char::is_whitespace) {
                return Err(AppError::config("checks 의 host 에 공백을 쓸 수 없습니다."));
            }
            statuses("checks 정상 판정 http_statuses", &self.healthy.http_statuses)?;
            statuses("checks 장애 판정 http_statuses", &self.unhealthy.http_statuses)?;
            count("checks 장애 판정 http_failures", self.unhealthy.http_failures)?;
        }
        if let Some(p) = self.port {
            if !(1..=65535).contains(&p) {
                return Err(AppError::config("checks 의 port 가 범위를 벗어났습니다 (1~65535)."));
            }
        }
        if let Some(t) = self.timeout {
            if !(t.is_finite() && t > 0.0) {
                return Err(AppError::config("checks 의 timeout 은 0 보다 커야 합니다."));
            }
        }
        for (label, v) in [
            ("checks 정상 판정 interval", self.healthy.interval),
            ("checks 장애 판정 interval", self.unhealthy.interval),
        ] {
            if matches!(v, Some(n) if n < 1) {
                return Err(AppError::config(format!("{label} 은 1초 이상이어야 합니다.")));
            }
        }
        count("checks 정상 판정 successes", self.healthy.successes)?;
        count("checks 장애 판정 tcp_failures", self.unhealthy.tcp_failures)?;
        count("checks 장애 판정 timeouts", self.unhealthy.timeouts)?;

        if self.passive.enabled {
            let u = &self.passive.unhealthy;
            statuses("수동 검사 http_statuses", &u.http_statuses)?;
            count("수동 검사 http_failures", u.http_failures)?;
            count("수동 검사 tcp_failures", u.tcp_failures)?;
            count("수동 검사 timeouts", u.timeouts)?;
        }
        Ok(())
    }
}

/// 성공 · 실패 횟수 — APISIX 스키마가 1~254 로 묶는다 (lua-resty-healthcheck 의 카운터 폭).
fn count(label: &str, v: Option<i64>) -> AppResult<()> {
    match v {
        Some(n) if !(1..=254).contains(&n) => {
            Err(AppError::config(format!("{label} 은 1~254 사이여야 합니다.")))
        }
        _ => Ok(()),
    }
}

/// 상태 코드 목록 — 200~599, 중복 불가 (APISIX 스키마의 `uniqueItems`).
fn statuses(label: &str, list: &[i64]) -> AppResult<()> {
    for (i, c) in list.iter().enumerate() {
        if !(200..=599).contains(c) {
            return Err(AppError::config(format!("{label} 에 200~599 밖의 값이 있습니다 ({c}).")));
        }
        if list[..i].contains(c) {
            return Err(AppError::config(format!("{label} 에 {c} 가 두 번 들어 있습니다.")));
        }
    }
    Ok(())
}

impl UpstreamForm {
    fn validate(&self) -> AppResult<()> {
        if self.name.trim().is_empty() {
            return Err(AppError::config("name 은 필수입니다."));
        }
        if self.nodes.is_empty() {
            return Err(AppError::config("노드를 하나 이상 등록해야 합니다."));
        }
        for (i, n) in self.nodes.iter().enumerate() {
            let no = i + 1;
            if n.host.trim().is_empty() {
                return Err(AppError::config(format!("{no}번 노드의 host 를 입력하세요.")));
            }
            if n.host.chars().any(char::is_whitespace) {
                return Err(AppError::config(format!("{no}번 노드의 host 에 공백을 쓸 수 없습니다.")));
            }
            if !(1..=65535).contains(&n.port) {
                return Err(AppError::config(format!(
                    "{no}번 노드의 port 가 범위를 벗어났습니다 (1~65535)."
                )));
            }
        }
        for (label, v) in [
            ("connect", self.timeout.connect),
            ("send", self.timeout.send),
            ("read", self.timeout.read),
        ] {
            if !(v.is_finite() && v > 0.0) {
                return Err(AppError::config(format!("timeout.{label} 은 0 보다 커야 합니다.")));
            }
        }
        if let Some(c) = &self.checks {
            c.validate()?;
        }
        Ok(())
    }
}

pub async fn list(app: &AppHandle<Wry>, env: Env) -> AppResult<Vec<UpstreamView>> {
    let (resp, _) = client::request(app, env, Method::GET, "upstreams", None).await?;
    let views: Vec<UpstreamView> =
        extract_list(&resp).iter().map(UpstreamView::from_value).collect();
    history::record(
        app,
        env,
        "GET",
        "upstreams",
        format!("Upstream 목록 조회 ({}건)", views.len()),
        "/apisix/admin/upstreams",
    );
    Ok(views)
}

/// 저장 직전 원본. 여기서 실패하면 **저장을 중단한다** — 빈 객체로 진행하면 머지의 의미가
/// 사라져 헬스체크 같은 설정을 통째로 날려버린다. (`routes::fetch_base` 와 같은 판단)
async fn fetch_base(app: &AppHandle<Wry>, env: Env, id: &str) -> AppResult<Value> {
    let (resp, _) = client::request(app, env, Method::GET, &format!("upstreams/{id}"), None)
        .await
        .map_err(|e| match e.kind {
            ErrorKind::NotFound => AppError::new(
                ErrorKind::NotFound,
                "이미 삭제된 upstream 입니다. 목록을 동기화한 뒤 다시 시도하세요.",
            ),
            _ => AppError::new(
                e.kind,
                format!("저장 전 원본을 읽지 못해 중단했습니다: {}", e.message),
            )
            .with_hint("그대로 저장하면 게이트웨이의 헬스체크·재시도 설정이 지워질 수 있습니다."),
        })?;

    Ok(extract_one(&resp).unwrap_or_else(|| json!({})))
}

pub async fn save(app: &AppHandle<Wry>, env: Env, form: UpstreamForm) -> AppResult<UpstreamView> {
    form.validate()?;

    let is_new = form.id.as_deref().map(str::trim).unwrap_or("").is_empty();
    let base = if is_new {
        json!({})
    } else {
        fetch_base(app, env, form.id.as_deref().unwrap_or("")).await?
    };

    let body = apply_upstream_form(base, &form);

    let (method, path) = if is_new {
        (Method::POST, "upstreams".to_string())
    } else {
        (Method::PUT, format!("upstreams/{}", form.id.as_deref().unwrap_or("")))
    };

    let (resp, _) = client::request(app, env, method.clone(), &path, Some(&body)).await?;

    let saved = extract_one(&resp).unwrap_or(body);
    let view = UpstreamView::from_value(&saved);

    let checks_note = match &form.checks {
        Some(c) if c.enabled => format!(" · 헬스체크 {}", c.r#type),
        Some(_) => " · 헬스체크 없음".to_string(),
        None => String::new(),
    };
    let note = if is_new {
        format!("Upstream 신규 등록 · 노드 {}개{checks_note}", form.nodes.len())
    } else {
        format!("Upstream 수정 · 노드 {}개{checks_note}", form.nodes.len())
    };
    let target =
        if view.id.is_empty() { "upstreams".to_string() } else { format!("upstreams/{}", view.id) };
    history::record(app, env, method.as_str(), &target, note, &format!("/apisix/admin/{path}"));

    Ok(view)
}

pub async fn delete(app: &AppHandle<Wry>, env: Env, id: &str, name: &str) -> AppResult<()> {
    if id.trim().is_empty() {
        return Err(AppError::config("삭제할 upstream 의 id 가 없습니다."));
    }
    let path = format!("upstreams/{id}");
    client::request(app, env, Method::DELETE, &path, None).await?;
    history::record(
        app,
        env,
        "DELETE",
        &path,
        format!("Upstream 삭제 · {}", if name.is_empty() { id } else { name }),
        &format!("/apisix/admin/{path}"),
    );
    Ok(())
}

// ── 헬스체크 상태 (Control API) ─────────────────────────────

/// `upstream_health` 의 응답.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    /// 호출한 주소 — 어디에 물었는지를 화면이 그대로 보여 준다
    pub url: String,
    /// `None` = 게이트웨이에 이 upstream 의 헬스체커가 없다 (`message` 에 사유)
    pub checker: Option<HealthChecker>,
    /// Control API 가 준 사유 (`no checker for upstreams[1]` 등). 체커가 있으면 빈 문자열
    pub message: String,
}

/// `upstreams_health` 의 응답 — 목록 화면이 한 번에 받는다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthList {
    pub url: String,
    /// upstream 리소스의 체커만. route · service 의 인라인 upstream 은 뺀다
    pub checkers: Vec<HealthChecker>,
}

/// 저장된 upstream 하나의 헬스체커 상태 — `GET /v1/healthcheck/upstreams/{id}`.
///
/// **404 는 에러가 아니다.** APISIX 는 이 upstream 으로 요청이 처음 흘러들 때 헬스체커를
/// 만든다 — checks 를 막 저장했거나 트래픽이 없던 upstream 은 체커가 아직 없다. 그 사실을
/// 빨간 에러로 세우면 멀쩡한 설정을 의심하게 되므로 `checker: None` + 사유로 돌려준다.
/// 다만 데이터 플레인 포트가 답한 404(`Route Not Found`)는 주소를 잘못 짚은 것이라 에러다.
pub async fn health(cfg: &EnvConfig, id: &str) -> AppResult<HealthReport> {
    let id = id.trim();
    if id.is_empty() {
        return Err(AppError::config("저장된 upstream 만 상태를 조회할 수 있습니다."));
    }
    let r = client::control_get(cfg, &format!("v1/healthcheck/upstreams/{id}")).await?;
    let json: Value = serde_json::from_str(&r.body).unwrap_or(Value::Null);

    match r.status {
        200..=299 => {
            let checker = parse_health_checker(&json).ok_or_else(|| not_control(&r.url))?;
            Ok(HealthReport { url: r.url, checker: Some(checker), message: String::new() })
        }
        404 => {
            let msg = json.get("error_msg").and_then(Value::as_str).unwrap_or("").to_string();
            if msg.is_empty() || msg.contains("Route Not Found") {
                return Err(not_control(&r.url));
            }
            Ok(HealthReport { url: r.url, checker: None, message: msg })
        }
        status => Err(control_status(status, &r.body)),
    }
}

/// 전체 헬스체커 — `GET /v1/healthcheck`. 목록 화면의 '상태 조회' 버튼.
pub async fn health_all(cfg: &EnvConfig) -> AppResult<HealthList> {
    let r = client::control_get(cfg, "v1/healthcheck").await?;
    if !(200..300).contains(&r.status) {
        if r.status == 404 {
            return Err(not_control(&r.url));
        }
        return Err(control_status(r.status, &r.body));
    }
    let json: Value = serde_json::from_str(&r.body).map_err(|_| not_control(&r.url))?;
    let checkers =
        parse_health_list(&json).into_iter().filter(|c| c.src_type == "upstreams").collect();
    Ok(HealthList { url: r.url, checkers })
}

/// 응답은 왔는데 Control API 의 모양이 아니다 — 대개 데이터 플레인이나 Admin API 포트를 짚었다.
fn not_control(url: &str) -> AppError {
    AppError::new(ErrorKind::Config, format!("Control API 가 아닌 곳이 응답했습니다 ({url})."))
        .with_hint(
            "설정 화면의 Control API 주소를 확인하세요. 게이트웨이 포트(9080 등)가 아니라 \
             apisix.control 의 포트(기본 9090)여야 합니다.",
        )
}

/// 그 밖의 실패. `AppError::from_status` 를 쓰지 않는 이유는 `from_spec_status` 와 같다 —
/// 관리키를 보내지 않은 호출의 401 · 403 을 관리키 탓으로 돌리면 안 된다.
fn control_status(status: u16, body: &str) -> AppError {
    let detail: String = body.trim().chars().take(200).collect();
    AppError::new(
        ErrorKind::Gateway,
        if detail.is_empty() {
            format!("Control API 오류입니다. (HTTP {status})")
        } else {
            format!("Control API 오류 (HTTP {status}): {detail}")
        },
    )
    .with_status(status)
}

// ── 노드 직접 점검 (이 PC → 노드) ────────────────────────────

/// `upstream_probe` 의 입력. 저장 전 폼의 노드 · checks 를 그대로 받는다.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInput {
    pub nodes: Vec<NodeInput>,
    pub checks: ChecksInput,
}

/// 노드 하나의 점검 결과.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    /// `10.20.3.11:8080`
    pub node: String,
    /// `GET http://10.20.3.11:8080/health` · `TCP 10.20.3.11:8080`
    pub target: String,
    /// 게이트웨이가 이 응답을 어떻게 셀지 — `healthy`(성공) · `unhealthy`(실패) · `neutral`(세지 않음)
    pub verdict: String,
    pub status: Option<u16>,
    pub elapsed_ms: u64,
    pub message: String,
}

/// APISIX 기본값 (schema_def.lua 의 health_checker). 폼이 비워 둔 칸은 게이트웨이도 이 값을 쓴다.
pub const DEFAULT_CHECK_TIMEOUT: f64 = 1.0;
pub const DEFAULT_HEALTHY_STATUSES: [i64; 2] = [200, 302];
pub const DEFAULT_UNHEALTHY_STATUSES: [i64; 8] = [429, 404, 500, 501, 502, 503, 504, 505];
/// 직접 점검 한 번이 기다리는 최대 시간 (초).
const PROBE_MAX_SECS: f64 = 30.0;

/// 폼의 checks 로 각 노드를 **한 번씩** 두드려 본다 — 능동 검사 한 회분을 흉내낸다.
///
/// 게이트웨이는 같은 결과가 `successes` · `*_failures` 번 이어져야 상태를 바꾼다. 이 결과는
/// 그 카운트의 한 칸이 어느 쪽으로 올라가는지만 알려 준다 (`verdict`).
///
/// 프록시 정책은 Admin API 와 같다 — [`client::build_probe`] 가 같은 빌더에서 나온다.
/// 노드는 동시에 두드린다. 한 노드가 timeout 까지 붙잡고 있어도 나머지가 기다리지 않게.
pub async fn probe(cfg: &EnvConfig, input: ProbeInput) -> AppResult<Vec<ProbeResult>> {
    if input.nodes.is_empty() {
        return Err(AppError::config("점검할 노드가 없습니다."));
    }
    for (i, n) in input.nodes.iter().enumerate() {
        if n.host.trim().is_empty() || !(1..=65535).contains(&n.port) {
            return Err(AppError::config(format!(
                "{}번 노드의 host · port 를 먼저 입력하세요.",
                i + 1
            )));
        }
    }
    let checks = ChecksInput { enabled: true, ..input.checks };
    checks.validate()?;

    let client = client::build_probe(cfg)?;
    let checks = std::sync::Arc::new(checks);
    let handles: Vec<_> = input
        .nodes
        .into_iter()
        .map(|n| {
            let client = client.clone();
            let checks = checks.clone();
            tokio::spawn(async move { probe_one(&client, &n, &checks).await })
        })
        .collect();

    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        out.push(
            h.await.map_err(|e| AppError::internal(format!("노드 점검이 중단됐습니다: {e}")))?,
        );
    }
    Ok(out)
}

async fn probe_one(client: &reqwest::Client, n: &NodeInput, c: &ChecksInput) -> ProbeResult {
    let host = n.host.trim();
    let port = c.port.unwrap_or(n.port);
    let node = format!("{}:{}", bracket(host), n.port);
    let secs = c.timeout.unwrap_or(DEFAULT_CHECK_TIMEOUT);
    // validate 가 양수를 보장한다. 상한은 점검 버튼이 붙잡혀 있지 않게 하려는 것이고
    // (`from_secs_f64` 는 너무 큰 값에서 패닉한다), 게이트웨이 설정과는 무관하다.
    let limit = Duration::from_secs_f64(secs.min(PROBE_MAX_SECS));
    let started = Instant::now();

    if !c.is_http() {
        let target = format!("TCP {}:{port}", bracket(host));
        let res =
            tokio::time::timeout(limit, tokio::net::TcpStream::connect((host, port as u16))).await;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let (verdict, message) = match res {
            Ok(Ok(_)) => ("healthy", "연결됨 — 성공으로 셉니다".to_string()),
            Ok(Err(e)) => ("unhealthy", format!("연결 실패 — tcp_failures 로 셉니다 ({e})")),
            Err(_) => ("unhealthy", format!("{secs}초 안에 연결되지 않음 — timeouts 로 셉니다")),
        };
        return ProbeResult {
            node,
            target,
            verdict: verdict.into(),
            status: None,
            elapsed_ms,
            message,
        };
    }

    let scheme = if c.r#type == "https" { "https" } else { "http" };
    let path = match c.http_path.trim() {
        "" => "/",
        p => p,
    };
    let url = format!("{scheme}://{}:{port}{path}", bracket(host));
    let target = format!("GET {url}");

    let mut req = client.get(&url).timeout(limit);
    let host_header = c.host.trim();
    if !host_header.is_empty() {
        // 게이트웨이도 checks.active.host 를 Host 헤더로 보낸다.
        req = req.header(reqwest::header::HOST, host_header);
    }

    let res = req.send().await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match res {
        Ok(r) => {
            let code = r.status().as_u16();
            let (verdict, message) = classify(code, c);
            ProbeResult {
                node,
                target,
                verdict: verdict.into(),
                status: Some(code),
                elapsed_ms,
                message,
            }
        }
        Err(e) => {
            let (verdict, message) = if e.is_timeout() {
                ("unhealthy", format!("{secs}초 안에 응답이 없음 — timeouts 로 셉니다"))
            } else if e.is_connect() {
                ("unhealthy", "연결 실패 — tcp_failures 로 셉니다".to_string())
            } else {
                ("unhealthy", format!("요청 실패 — {}", AppError::from(e).message))
            };
            ProbeResult { node, target, verdict: verdict.into(), status: None, elapsed_ms, message }
        }
    }
}

/// 응답 코드 → 게이트웨이가 세는 방향. lua-resty-healthcheck 는 정상 목록을 먼저 보고,
/// 두 목록 어디에도 없는 코드는 **세지 않는다**.
fn classify(code: u16, c: &ChecksInput) -> (&'static str, String) {
    let code_i = i64::from(code);
    let healthy: &[i64] = if c.healthy.http_statuses.is_empty() {
        &DEFAULT_HEALTHY_STATUSES
    } else {
        &c.healthy.http_statuses
    };
    let unhealthy: &[i64] = if c.unhealthy.http_statuses.is_empty() {
        &DEFAULT_UNHEALTHY_STATUSES
    } else {
        &c.unhealthy.http_statuses
    };
    if healthy.contains(&code_i) {
        ("healthy", format!("{code} — 정상 판정 코드라 성공으로 셉니다"))
    } else if unhealthy.contains(&code_i) {
        ("unhealthy", format!("{code} — 장애 판정 코드라 http_failures 로 셉니다"))
    } else {
        ("neutral", format!("{code} — 두 목록 어디에도 없어 게이트웨이는 세지 않습니다"))
    }
}

/// IPv6 주소는 URL · 표시에서 대괄호로 감싼다 (`::1` → `[::1]`).
fn bracket(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

// ── 폼 → 요청 본문 (머지) ────────────────────────────────────

/// 원본 upstream 위에 폼 값을 얹는다. 앱이 모르는 필드는 그대로 보존된다.
///
/// JSON 탭의 미리보기(`src/lib/design.ts` 의 `upstreamJson`)가 이 함수가 만드는 모양을
/// 흉내낸다. 앱 관리 키(name · desc · nodes · timeout · checks)가 바뀌면 그쪽도 함께 고쳐야
/// 한다 (checks 는 `src/lib/checks.ts` 의 `checksJson`).
/// `type` 이 미리보기에 없는 것은 의도적이다 — 아래에서 **없을 때만** 채우는 값이라 앱이
/// 관리하는 키가 아니다.
fn apply_upstream_form(base: Value, f: &UpstreamForm) -> Value {
    let mut m = obj(base);
    strip_server_fields(&mut m);

    set_or_remove(&mut m, "name", f.name.trim());
    set_or_remove(&mut m, "desc", f.desc.trim());

    // type 은 폼에 없다. 없을 때만 기본값을 넣고, 이미 있으면 손대지 않는다 —
    // chash 로 운영 중인 upstream 을 저장 한 번으로 roundrobin 으로 바꿔 버리면 안 된다.
    if !m.contains_key("type") {
        m.insert("type".into(), Value::String(DEFAULT_UPSTREAM_TYPE.to_string()));
    }

    m.insert(
        "nodes".into(),
        Value::Array(
            f.nodes
                .iter()
                .map(|n| {
                    json!({
                        "host": n.host.trim(),
                        "port": n.port,
                        "weight": n.weight.unwrap_or(1),
                    })
                })
                .collect(),
        ),
    );

    // timeout 의 다른 키는 APISIX 스키마에 없으므로 통째로 교체해도 잃는 것이 없다.
    let mut t = Map::new();
    t.insert("connect".into(), json!(f.timeout.connect));
    t.insert("send".into(), json!(f.timeout.send));
    t.insert("read".into(), json!(f.timeout.read));
    m.insert("timeout".into(), Value::Object(t));

    apply_checks(&mut m, f.checks.as_ref());

    Value::Object(m)
}

/// `checks` 머지. 폼이 다루는 키만 쓰고 나머지는 원본 그대로 둔다.
///
/// | 폼 | 저장 결과 |
/// |---|---|
/// | `checks` 필드 없음 (`None`) | 손대지 않는다 |
/// | 헬스체크 OFF | `checks` 를 **통째로** 지운다 |
/// | 빈 칸 (숫자 · 문자열 · 상태 코드 목록) | 그 키를 지운다 → APISIX 기본값 |
/// | type `tcp` | `http_path` · `host` · `http_statuses` · `unhealthy.http_failures` 를 지운다 (뜻이 없다) |
/// | 수동 검사 OFF | `checks.passive` 를 지운다 |
/// | 폼이 모르는 키 (`concurrency` · `req_headers` · `passive.healthy` …) | 보존 |
///
/// 속이 빈 `healthy` · `unhealthy` 는 남기지 않는다 (빈 `plugins` 를 지우는 것과 같은 규칙).
fn apply_checks(m: &mut Map<String, Value>, c: Option<&ChecksInput>) {
    let Some(c) = c else { return };
    if !c.enabled {
        m.remove("checks");
        return;
    }
    let http = c.is_http();

    let mut checks = obj(m.remove("checks").unwrap_or(Value::Null));
    let mut active = obj(checks.remove("active").unwrap_or(Value::Null));

    active.insert("type".into(), Value::String(c.r#type.clone()));
    set_or_remove(&mut active, "http_path", if http { c.http_path.trim() } else { "" });
    set_or_remove(&mut active, "host", if http { c.host.trim() } else { "" });
    put(&mut active, "port", c.port.map(Value::from));
    put(&mut active, "timeout", c.timeout.map(Value::from));

    let mut healthy = obj(active.remove("healthy").unwrap_or(Value::Null));
    put(&mut healthy, "interval", c.healthy.interval.map(Value::from));
    put(&mut healthy, "successes", c.healthy.successes.map(Value::from));
    put_list(&mut healthy, "http_statuses", if http { &c.healthy.http_statuses } else { &[] });
    put_obj(&mut active, "healthy", healthy);

    let mut unhealthy = obj(active.remove("unhealthy").unwrap_or(Value::Null));
    put(&mut unhealthy, "interval", c.unhealthy.interval.map(Value::from));
    let http_failures = if http { c.unhealthy.http_failures } else { None };
    put(&mut unhealthy, "http_failures", http_failures.map(Value::from));
    put(&mut unhealthy, "tcp_failures", c.unhealthy.tcp_failures.map(Value::from));
    put(&mut unhealthy, "timeouts", c.unhealthy.timeouts.map(Value::from));
    put_list(&mut unhealthy, "http_statuses", if http { &c.unhealthy.http_statuses } else { &[] });
    put_obj(&mut active, "unhealthy", unhealthy);

    checks.insert("active".into(), Value::Object(active));

    if c.passive.enabled {
        // 수동 검사는 실제로 프록시한 응답을 본다 — 능동 검사가 tcp 여도 HTTP 키가 뜻이 있다.
        let u = &c.passive.unhealthy;
        let mut passive = obj(checks.remove("passive").unwrap_or(Value::Null));
        let mut pu = obj(passive.remove("unhealthy").unwrap_or(Value::Null));
        put(&mut pu, "http_failures", u.http_failures.map(Value::from));
        put(&mut pu, "tcp_failures", u.tcp_failures.map(Value::from));
        put(&mut pu, "timeouts", u.timeouts.map(Value::from));
        put_list(&mut pu, "http_statuses", &u.http_statuses);
        put_obj(&mut passive, "unhealthy", pu);
        // `passive: {}` 는 APISIX 가 받는다 — 모든 키에 기본값이 있다.
        checks.insert("passive".into(), Value::Object(passive));
    } else {
        checks.remove("passive");
    }

    m.insert("checks".into(), Value::Object(checks));
}

fn put(m: &mut Map<String, Value>, key: &str, v: Option<Value>) {
    match v {
        Some(v) => {
            m.insert(key.into(), v);
        }
        None => {
            m.remove(key);
        }
    }
}

fn put_list(m: &mut Map<String, Value>, key: &str, list: &[i64]) {
    put(m, key, (!list.is_empty()).then(|| json!(list)));
}

fn put_obj(m: &mut Map<String, Value>, key: &str, inner: Map<String, Value>) {
    put(m, key, (!inner.is_empty()).then_some(Value::Object(inner)));
}

/// 테스트에서 머지 로직만 따로 검증하기 위한 얇은 래퍼.
#[cfg(test)]
pub fn apply_upstream_form_for_test(base: Value, f: &UpstreamForm) -> Value {
    apply_upstream_form(base, f)
}

/// 검증만 따로 확인하기 위한 테스트 통로 (`validate` 는 비공개다).
#[cfg(test)]
pub fn validate_for_test(f: &UpstreamForm) -> AppResult<()> {
    f.validate()
}

/// 응답 코드 판정만 따로 확인하기 위한 테스트 통로.
#[cfg(test)]
pub fn classify_for_test(code: u16, c: &ChecksInput) -> &'static str {
    classify(code, c).0
}
