//! Consumer CRUD.
//!
//! APISIX 에서 consumer 의 식별자는 `username` 이고, 생성·수정 모두
//! `PUT /apisix/admin/consumers` (본문에 username) 한 가지로 처리한다.
//! routes 와 같은 이유로 `plugins` 는 통째로 교체하지 않고 `jwt-auth` 키만 머지한다.
//!
//! # 개인 식별기능 (`shi-personal-auth`)
//!
//! route · service 와 달리 consumer 쪽 블록은 `secret` 을 담아야 한다. 저장할 수 있는 상태는
//! 둘뿐이다 — **(플러그인 + secret 있음)** 또는 **(플러그인 없음)**. secret 없는 빈 블록은
//! `validate` 가 막는다. secret 은 화면에서 자동 생성하거나 직접 입력한다.

use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Wry};

use super::client;
use super::models::{
    check_label_value, extract_list, extract_one, obj, set_contacts_at, set_groups_at,
    strip_server_fields, Contact, ConsumerView, GroupsLocation, PERSONAL_AUTH_PLUGIN,
    PERSONAL_AUTH_SECRET_KEY,
};
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
    /// labels 의 담당자 목록.
    ///
    /// `null` = 기존 labels 를 건드리지 않는다, `[]` = 담당자 라벨을 전부 지운다.
    /// `commands::EnvPayload.token` 과 같은 관례다. **`Vec<Contact>` 로 두면 안 된다** —
    /// `api.ts` 의 `consumerSave` 는 필드를 하나씩 나열하는 객체 리터럴이라, 한 줄을 빠뜨리면
    /// `#[serde(default)]` 가 빈 배열을 만들어 게이트웨이의 담당자 라벨을 전부 지운다.
    #[serde(default)]
    pub contacts: Option<Vec<Contact>>,
    /// `plugins.shi-personal-auth` 를 붙일지 (개인 식별기능 토글).
    ///
    /// `None`(필드 누락)은 게이트웨이의 블록을 **건드리지 않는다** — `contacts` 와 같은 관례다.
    /// `Some(true)` 면 `personal_secret` 이 반드시 있어야 한다.
    #[serde(default)]
    pub personal_auth: Option<bool>,
    /// `plugins.shi-personal-auth.secret`. `personal_auth` 가 `Some(true)` 일 때만 쓴다.
    #[serde(default)]
    pub personal_secret: String,
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
        // 플러그인만 있고 secret 이 없는 상태는 저장하지 않는다 — 켜려면 secret 까지 있어야 한다.
        if self.personal_auth == Some(true) {
            let ps = self.personal_secret.trim();
            if ps.is_empty() {
                return Err(AppError::config(
                    "개인 식별기능을 적용하려면 secret 이 필요합니다.",
                )
                .with_hint("secret 을 직접 입력하거나 '생성' 으로 만드세요. 적용하지 않으려면 토글을 끄세요."));
            }
            if ps.chars().any(char::is_whitespace) {
                return Err(AppError::config("개인 식별기능 secret 에 공백을 쓸 수 없습니다."));
            }
        }
        // 담당자는 labels 로 저장되므로 APISIX 의 label 값 제약을 받는다.
        for (i, c) in self.contacts.iter().flatten().enumerate() {
            let no = i + 1;
            if !c.name.trim().is_empty() {
                check_label_value(&format!("{no}행 성명"), c.name.trim())?;
            }
            if !c.dept.trim().is_empty() {
                check_label_value(&format!("{no}행 부서"), c.dept.trim())?;
            }
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
            format!(
                "컨슈머 수정 · 권한그룹 {}건 · 담당자 {}건",
                form.groups.len(),
                form.contacts.as_ref().map(Vec::len).unwrap_or(0)
            )
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

fn apply_consumer_form(base: Value, f: &ConsumerForm) -> Value {
    let mut m = obj(base);
    strip_server_fields(&mut m);

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

    // 개인 식별기능 — 켜면 `secret` 만 갈아 끼우고 블록의 다른 필드는 보존한다.
    // `None` 이면 건드리지 않는다 (ConsumerForm.personal_auth 주석 참조).
    match f.personal_auth {
        Some(true) => {
            let mut pa = obj(plugins.remove(PERSONAL_AUTH_PLUGIN).unwrap_or(Value::Null));
            pa.insert(
                PERSONAL_AUTH_SECRET_KEY.into(),
                Value::String(f.personal_secret.trim().to_string()),
            );
            plugins.insert(PERSONAL_AUTH_PLUGIN.into(), Value::Object(pa));
        }
        Some(false) => {
            plugins.remove(PERSONAL_AUTH_PLUGIN);
        }
        None => {}
    }

    m.insert("plugins".into(), Value::Object(plugins));

    // auth-groups — 조회 때 값이 있던 바로 그 자리에 되쓴다.
    // 이 앱 밖에서 등록된 consumer 는 표기가 다를 수 있어, 표준 위치로 "정규화"하면
    // 기존 키가 남아 둘로 갈라진다. (models::find_groups 참조)
    let loc = f.groups_location.clone().unwrap_or_default();
    set_groups_at(&mut m, &loc, &f.groups);

    // 담당자 — 미지정(null)이면 게이트웨이의 labels 를 그대로 둔다. 폼에서 온 요청은 항상
    // 배열을 보내므로 "전부 지우기"도 그대로 성립한다. (ConsumerForm.contacts 주석 참조)
    if let Some(cs) = &f.contacts {
        set_contacts_at(&mut m, cs);
    }

    Value::Object(m)
}


/// 테스트에서 머지 로직만 따로 검증하기 위한 얇은 래퍼.
#[cfg(test)]
pub fn apply_consumer_form_for_test(base: Value, f: &ConsumerForm) -> Value {
    apply_consumer_form(base, f)
}

/// 검증만 따로 확인하기 위한 테스트 통로 (`validate` 는 비공개다).
#[cfg(test)]
pub fn validate_for_test(f: &ConsumerForm) -> AppResult<()> {
    f.validate()
}
