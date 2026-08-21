//! Upstream CRUD.
//!
//! # 왜 머지인가
//!
//! `routes.rs` 와 같은 이유다. 게이트웨이의 upstream 에는 이 앱이 폼으로 다루지 않는
//! 설정(`checks` 헬스체크 · `retries` · `scheme` · `pass_host` · `discovery_type` …)이
//! 붙어 있을 수 있다. 폼 값으로 객체를 새로 만들어 PUT 하면 그게 통째로 사라진다.
//! 그래서 저장 직전에 원본을 GET 해 와 **앱이 관리하는 키(name · desc · nodes · timeout)만**
//! 덮어쓴다.
//!
//! # nodes 표기
//!
//! 읽기는 맵(`{"h:p": w}`)·배열(`[{host,port,weight}]`) 둘 다 받고(`models::all_nodes`),
//! 쓰기는 **배열로 고정**한다. 맵 키에 `host:port` 를 조립해 넣으면 포트가 없는 노드나
//! IPv6 주소에서 표기가 애매해지고, weight 를 값 자리에 숨겨야 한다.

use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Wry};

use super::client;
use super::models::{
    extract_list, extract_one, obj, set_or_remove, strip_server_fields, UpstreamTimeout,
    UpstreamView, DEFAULT_UPSTREAM_TYPE,
};
use crate::config::Env;
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

    let note = if is_new {
        format!("Upstream 신규 등록 · 노드 {}개", form.nodes.len())
    } else {
        format!("Upstream 수정 · 노드 {}개", form.nodes.len())
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

// ── 폼 → 요청 본문 (머지) ────────────────────────────────────

/// 원본 upstream 위에 폼 값을 얹는다. 앱이 모르는 필드는 그대로 보존된다.
///
/// JSON 탭의 미리보기(`src/lib/design.ts` 의 `upstreamJson`)가 이 함수가 만드는 모양을
/// 흉내낸다. 앱 관리 키(name · desc · nodes · timeout)가 바뀌면 그쪽도 함께 고쳐야 한다.
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

    Value::Object(m)
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
