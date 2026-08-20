//! Consumer CRUD.
//!
//! APISIX 에서 consumer 의 식별자는 `username` 이고, 생성·수정 모두
//! `PUT /apisix/admin/consumers` (본문에 username) 한 가지로 처리한다.
//! routes 와 같은 이유로 `plugins` 는 통째로 교체하지 않고 `jwt-auth` 키만 머지한다.

use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Wry};

use super::client;
use super::models::{extract_list, extract_one, set_groups_at, ConsumerView, GroupsLocation};
use crate::config::Env;
use crate::error::{AppError, AppResult, ErrorKind};
use crate::history;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerForm {
    pub username: String,
    #[serde(default)]
    pub desc: String,
    pub key: String,
    pub secret: String,
    #[serde(default)]
    pub groups: Vec<String>,
    /// 기존 항목 수정인지 (신규면 false). 이력 문구에만 쓴다.
    #[serde(default)]
    pub is_new: bool,
    /// 조회 때 auth-groups 가 실제로 있던 자리. 없으면 기본(jwt-auth/auth-groups).
    #[serde(default)]
    pub groups_location: Option<GroupsLocation>,
}

impl ConsumerForm {
    fn validate(&self) -> AppResult<()> {
        if self.username.trim().is_empty() {
            return Err(AppError::config("username 은 필수입니다."));
        }
        // APISIX 의 consumer username 은 [a-zA-Z0-9_-] 만 허용한다.
        if !self
            .username
            .trim()
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(AppError::config(
                "username 에는 영문·숫자·밑줄(_)·하이픈(-) 만 쓸 수 있습니다.",
            ));
        }
        if self.key.trim().is_empty() {
            return Err(AppError::config("jwt-auth.key 는 필수입니다."));
        }
        if self.secret.trim().is_empty() {
            return Err(AppError::config("jwt-auth.secret 은 필수입니다."));
        }
        Ok(())
    }
}

pub async fn list(app: &AppHandle<Wry>, env: Env) -> AppResult<Vec<ConsumerView>> {
    let (resp, _) = client::request(app, env, Method::GET, "consumers", None).await?;
    let views: Vec<ConsumerView> =
        extract_list(&resp).iter().map(ConsumerView::from_value).collect();
    history::record(
        app,
        env,
        "GET",
        "consumers",
        format!("컨슈머 목록 조회 ({}건)", views.len()),
        "/apisix/admin/consumers",
    );
    Ok(views)
}

/// 저장 직전 원본을 읽어 온다. routes.rs 와 같은 이유로 실패 시 저장을 중단한다 —
/// 빈 객체로 머지하면 jwt-auth 외의 플러그인이 지워진다.
async fn fetch_base(app: &AppHandle<Wry>, env: Env, username: &str) -> AppResult<Value> {
    let (resp, _) = client::request(app, env, Method::GET, &format!("consumers/{username}"), None)
        .await
        .map_err(|e| match e.kind {
            ErrorKind::NotFound => AppError::new(
                ErrorKind::NotFound,
                "이미 삭제된 컨슈머입니다. 목록을 새로고침한 뒤 다시 시도하세요.",
            ),
            _ => AppError::new(
                e.kind,
                format!("저장 전 원본을 읽지 못해 중단했습니다: {}", e.message),
            )
            .with_hint("그대로 저장하면 게이트웨이의 다른 플러그인 설정이 지워질 수 있습니다."),
        })?;

    Ok(extract_one(&resp).unwrap_or_else(|| json!({})))
}

pub async fn save(app: &AppHandle<Wry>, env: Env, form: ConsumerForm) -> AppResult<ConsumerView> {
    form.validate()?;
    let username = form.username.trim().to_string();

    let base = if form.is_new { json!({}) } else { fetch_base(app, env, &username).await? };
    let body = apply_consumer_form(base, &form);

    // 생성·수정 모두 PUT /consumers (본문에 username)
    let (resp, _) = client::request(app, env, Method::PUT, "consumers", Some(&body)).await?;

    let saved = extract_one(&resp).unwrap_or(body);
    let view = ConsumerView::from_value(&saved);

    history::record(
        app,
        env,
        "PUT",
        &format!("consumers/{username}"),
        if form.is_new {
            format!("컨슈머 신규 등록 · jwt-auth key {}", form.key.trim())
        } else {
            format!("컨슈머 수정 · auth-groups {}건", form.groups.len())
        },
        &format!("/apisix/admin/consumers/{username}"),
    );

    Ok(view)
}

pub async fn delete(app: &AppHandle<Wry>, env: Env, username: &str) -> AppResult<()> {
    if username.trim().is_empty() {
        return Err(AppError::config("삭제할 컨슈머의 username 이 없습니다."));
    }
    let path = format!("consumers/{username}");
    client::request(app, env, Method::DELETE, &path, None).await?;
    history::record(
        app,
        env,
        "DELETE",
        &path,
        format!("컨슈머 삭제 · {username}"),
        &format!("/apisix/admin/{path}"),
    );
    Ok(())
}

// ── 폼 → 요청 본문 (머지) ────────────────────────────────────

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

fn apply_consumer_form(base: Value, f: &ConsumerForm) -> Value {
    let mut m = obj(base);
    m.remove("create_time");
    m.remove("update_time");
    m.remove("id");

    m.insert("username".into(), Value::String(f.username.trim().to_string()));

    let desc = f.desc.trim();
    if desc.is_empty() {
        m.remove("desc");
    } else {
        m.insert("desc".into(), Value::String(desc.to_string()));
    }

    let mut plugins = obj(m.remove("plugins").unwrap_or(Value::Null));
    // jwt-auth 의 다른 설정(algorithm, exp, base64_secret 등)은 보존한다.
    let mut jwt = obj(plugins.remove("jwt-auth").unwrap_or(Value::Null));
    jwt.insert("key".into(), Value::String(f.key.trim().to_string()));
    jwt.insert("secret".into(), Value::String(f.secret.trim().to_string()));
    plugins.insert("jwt-auth".into(), Value::Object(jwt));

    m.insert("plugins".into(), Value::Object(plugins));

    // auth-groups — 조회 때 값이 있던 바로 그 자리에 되쓴다.
    // 이 앱 밖에서 등록된 consumer 는 표기가 다를 수 있어, 표준 위치로 "정규화"하면
    // 기존 키가 남아 둘로 갈라진다. (models::find_groups 참조)
    let loc = f.groups_location.clone().unwrap_or_default();
    set_groups_at(&mut m, &loc, &f.groups);

    Value::Object(m)
}


/// 테스트에서 머지 로직만 따로 검증하기 위한 얇은 래퍼.
#[cfg(test)]
pub fn apply_consumer_form_for_test(base: Value, f: &ConsumerForm) -> Value {
    apply_consumer_form(base, f)
}
