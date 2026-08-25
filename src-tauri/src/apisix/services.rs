//! Service CRUD.
//!
//! # spec_url 을 labels 에 두는 이유
//!
//! Import 화면은 파일 첨부 없이도 "선택한 service 의 스펙"을 읽어야 한다. 그 주소는
//! service 의 속성이므로 게이트웨이에 함께 저장돼야 다른 PC·다른 도구에서도 같은 값을 본다.
//! 그런데 APISIX 의 service 스키마는 `additionalProperties: false` 라 최상위에 임의 필드를
//! 넣을 수 없다. `labels` 는 값 제약(`^\S+$` · 256바이트)만 지키면 되고 URL 에는 공백이
//! 없으므로 `labels.spec_url` 에 담는다. (제약 검사는 `models::check_label_constraints`)
//!
//! **route 명 접두어(`labels.name_prefix`)도 같은 이유로 같은 자리에 둔다.** Import 프리필의
//! `name` 규약이 service 단위로 정해져 있어 게이트웨이에 함께 저장돼야 한다.
//!
//! # 플러그인
//!
//! 이 앱이 관리하는 것은 두 개뿐이고, **둘 다 없을 수 있다.** jwt-auth 가 불필요한 service 도
//! shi-log 가 불필요한 service 도 현장에 존재한다.
//!   * `jwt-auth` — 폼의 토글. ON 이면 **없을 때만** `{}` 를 넣어 이미 있는 설정을 보존하고
//!     (`{}` 로 덮으면 게이트웨이에 설정된 jwt-auth 옵션이 사라진다), OFF 면 지운다.
//!   * `shi-log.key` — 폼의 `log-key` 값. 값이 있으면 `key` 만 갈아 끼우고 다른 필드는
//!     건드리지 않는다. **빈 값이면 `shi-log` 를 통째로 지운다** — `key: ""` 로 남기면
//!     플러그인은 붙어 있는데 로그 키가 없는 상태가 된다.
//!
//! 그 둘을 지우고 나서 **남은 플러그인이 하나도 없으면 `plugins` 키 자체를 없앤다.**
//! `labels` 를 다루는 `models::set_label` 과 같은 규칙이다 — 빈 껍데기를 남기지 않는다.
//! 앱이 모르는 플러그인(`limit-count` 등)이 남아 있으면 `plugins` 는 그대로 유지된다
//! (`routes.rs` 와 같은 이유로 전부 보존한다).

use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Wry};

use super::client;
use super::models::{
    check_label_constraints, extract_list, extract_one, obj, set_label, set_or_remove,
    strip_server_fields, ServiceView, UpstreamView, NAME_PREFIX_LABEL, SPEC_URL_LABEL,
};
use crate::config::Env;
use crate::error::{AppError, AppResult, ErrorKind};
use crate::history;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceForm {
    /// 비어 있으면 신규 등록 → `POST /services` 로 APISIX 가 id 를 자동 생성한다.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub upstream_id: String,
    /// `labels.spec_url` 로 저장된다. 선택 항목이지만 값이 있으면 제약을 검사한다.
    #[serde(default)]
    pub spec_url: String,
    /// `labels.name_prefix` 로 저장된다 — Import 프리필의 route 명 접두어.
    /// 선택 항목이지만 값이 있으면 제약을 검사한다.
    #[serde(default)]
    pub name_prefix: String,
    /// `plugins["shi-log"].key`. **빈 값은 "shi-log 를 지워라"** 는 뜻이다 (선택 항목).
    #[serde(default)]
    pub log_key: String,
    /// `plugins["jwt-auth"]` 를 붙일지. OFF 면 저장할 때 그 플러그인을 지운다.
    ///
    /// 기본값이 `true` 인 이유: bool 의 기본값(`false`)으로 두면 이 필드를 빠뜨린 호출이
    /// 게이트웨이의 jwt-auth 를 **조용히 지운다.** 누락은 이 필드가 없던 시절의 동작
    /// (항상 붙인다)으로 떨어지는 쪽이 안전하다.
    #[serde(default = "jwt_auth_default")]
    pub jwt_auth: bool,
}

fn jwt_auth_default() -> bool {
    true
}

impl ServiceForm {
    fn validate(&self) -> AppResult<()> {
        if self.name.trim().is_empty() {
            return Err(AppError::config("name 은 필수입니다."));
        }
        if self.upstream_id.trim().is_empty() {
            return Err(AppError::config("upstream_id 는 필수입니다."));
        }
        // log-key 는 필수가 아니다 — 빈 값은 `plugins.shi-log` 를 지우라는 뜻이다.
        // 검사는 **다듬은 값**으로 한다: 저장도 `trim()` 한 값을 쓰므로 `"   "` 는 빈 값과
        // 같은 뜻이 돼야 하고, `"e p"` 는 여전히 거절돼야 한다.
        // (`spec_url` · `name_prefix` 가 이미 같은 방식이다)
        let log_key = self.log_key.trim();
        if !log_key.is_empty() && log_key.chars().any(char::is_whitespace) {
            return Err(AppError::config("log-key 에 공백을 쓸 수 없습니다."));
        }

        let spec = self.spec_url.trim();
        if !spec.is_empty() {
            check_label_constraints("spec_url", spec)?;
            // 스킴을 여기서 막아야 나중에 client::fetch_text 가 거부하는 값이 저장되지 않는다.
            if !(spec.starts_with("http://") || spec.starts_with("https://")) {
                return Err(AppError::config("spec_url 은 http:// 또는 https:// 로 시작해야 합니다.")
                    .with_hint("스펙 조회는 http/https 만 허용합니다."));
            }
        }

        // 끝문자(`/`·`_`)는 검사하지 않는다 — 접두어를 어떻게 끊을지는 규약이지 제약이 아니고,
        // 값을 몰래 보정하지도 않는다. 화면이 인라인 경고로 짚어 주되 저장은 통과시킨다.
        let name_prefix = self.name_prefix.trim();
        if !name_prefix.is_empty() {
            check_label_constraints("name 접두어", name_prefix)?;
        }
        Ok(())
    }
}

pub async fn list(
    app: &AppHandle<Wry>,
    env: Env,
    upstreams: &[UpstreamView],
) -> AppResult<Vec<ServiceView>> {
    let (resp, _) = client::request(app, env, Method::GET, "services", None).await?;
    let views: Vec<ServiceView> =
        extract_list(&resp).iter().map(|v| ServiceView::from_value(v, upstreams)).collect();
    history::record(
        app,
        env,
        "GET",
        "services",
        format!("Service 목록 조회 ({}건)", views.len()),
        "/apisix/admin/services",
    );
    Ok(views)
}

/// 저장 직전 원본. 실패하면 저장을 중단한다 (`routes::fetch_base` 와 같은 판단).
async fn fetch_base(app: &AppHandle<Wry>, env: Env, id: &str) -> AppResult<Value> {
    let (resp, _) = client::request(app, env, Method::GET, &format!("services/{id}"), None)
        .await
        .map_err(|e| match e.kind {
            ErrorKind::NotFound => AppError::new(
                ErrorKind::NotFound,
                "이미 삭제된 service 입니다. 목록을 동기화한 뒤 다시 시도하세요.",
            ),
            _ => AppError::new(
                e.kind,
                format!("저장 전 원본을 읽지 못해 중단했습니다: {}", e.message),
            )
            .with_hint("그대로 저장하면 게이트웨이의 다른 플러그인·라벨 설정이 지워질 수 있습니다."),
        })?;

    Ok(extract_one(&resp).unwrap_or_else(|| json!({})))
}

pub async fn save(
    app: &AppHandle<Wry>,
    env: Env,
    form: ServiceForm,
    upstreams: &[UpstreamView],
) -> AppResult<ServiceView> {
    form.validate()?;

    let is_new = form.id.as_deref().map(str::trim).unwrap_or("").is_empty();
    let base = if is_new {
        json!({})
    } else {
        fetch_base(app, env, form.id.as_deref().unwrap_or("")).await?
    };

    let body = apply_service_form(base, &form);

    let (method, path) = if is_new {
        (Method::POST, "services".to_string())
    } else {
        (Method::PUT, format!("services/{}", form.id.as_deref().unwrap_or("")))
    };

    let (resp, _) = client::request(app, env, method.clone(), &path, Some(&body)).await?;

    let saved = extract_one(&resp).unwrap_or(body);
    let view = ServiceView::from_value(&saved, upstreams);

    let note = if is_new {
        format!("Service 신규 등록 · upstream {}", form.upstream_id.trim())
    } else {
        format!("Service 수정 · upstream {}", form.upstream_id.trim())
    };
    let target =
        if view.id.is_empty() { "services".to_string() } else { format!("services/{}", view.id) };
    history::record(app, env, method.as_str(), &target, note, &format!("/apisix/admin/{path}"));

    Ok(view)
}

pub async fn delete(app: &AppHandle<Wry>, env: Env, id: &str, name: &str) -> AppResult<()> {
    if id.trim().is_empty() {
        return Err(AppError::config("삭제할 service 의 id 가 없습니다."));
    }
    let path = format!("services/{id}");
    client::request(app, env, Method::DELETE, &path, None).await?;
    history::record(
        app,
        env,
        "DELETE",
        &path,
        format!("Service 삭제 · {}", if name.is_empty() { id } else { name }),
        &format!("/apisix/admin/{path}"),
    );
    Ok(())
}

// ── 폼 → 요청 본문 (머지) ────────────────────────────────────

/// 원본 service 위에 폼 값을 얹는다. 앱이 모르는 필드·플러그인·라벨은 그대로 보존된다.
///
/// JSON 탭의 미리보기(`src/lib/design.ts` 의 `serviceJson`)가 이 함수가 만드는 모양을
/// 흉내낸다. 어느 키가 **생기고 사라지는지**는 이제 양쪽이 같다 (jwt-auth 토글 · 빈 log-key ·
/// 빈 plugins). 남은 차이는 값을 보존하는 대목뿐이다 — 미리보기는 `jwt-auth` 를 `{}` 로,
/// `labels` 를 앱이 아는 키만 보여 주지만 실제로는 기존 값을 보존한다. 그 차이는 화면에
/// 문구로 적어 두었다.
fn apply_service_form(base: Value, f: &ServiceForm) -> Value {
    let mut m = obj(base);
    strip_server_fields(&mut m);

    set_or_remove(&mut m, "name", f.name.trim());
    set_or_remove(&mut m, "desc", f.desc.trim());
    set_or_remove(&mut m, "upstream_id", f.upstream_id.trim());

    // spec_url · name_prefix — 인식하는 라벨만 손대고 나머지(담당자 등)는 남긴다.
    // 빈 값이면 그 키만 지운다 (`set_label`).
    set_label(&mut m, SPEC_URL_LABEL, f.spec_url.trim());
    set_label(&mut m, NAME_PREFIX_LABEL, f.name_prefix.trim());

    // ── plugins 머지 ────────────────────────────────────────
    // 저장은 GET 해 온 원본에 얹는 머지다. 그래서 키를 빼려면 *생략*으로는 안 되고
    // `remove` 로 적극적으로 지워야 한다.
    let mut plugins = obj(m.remove("plugins").unwrap_or(Value::Null));

    // ON 이면 없을 때만 `{}` — 이미 있는 설정(`header`·`hide_credentials`)은 보존한다.
    // OFF 면 지운다. 폼이 "이 service 에는 jwt-auth 가 필요 없다"고 말한 것이다.
    if f.jwt_auth {
        plugins.entry("jwt-auth").or_insert_with(|| json!({}));
    } else {
        plugins.remove("jwt-auth");
    }

    // 빈 log-key 는 `key: ""` 가 아니라 shi-log 를 통째로 지우라는 뜻이다. 값이 있으면
    // `key` 만 갈아 끼우고 `level` 같은 다른 필드는 남긴다.
    let log_key = f.log_key.trim();
    if log_key.is_empty() {
        plugins.remove("shi-log");
    } else {
        let mut log = obj(plugins.remove("shi-log").unwrap_or(Value::Null));
        log.insert("key".into(), Value::String(log_key.to_string()));
        plugins.insert("shi-log".into(), Value::Object(log));
    }

    // 남은 플러그인이 하나도 없으면 키 자체를 없앤다 — `models::set_label` 이 labels 에
    // 하는 것과 같은 규칙이다(빈 껍데기를 남기지 않는다). `limit-count` 처럼 앱이 모르는
    // 플러그인이 남아 있으면 비어 있지 않으므로 `plugins` 는 자연히 유지된다.
    if !plugins.is_empty() {
        m.insert("plugins".into(), Value::Object(plugins));
    }

    Value::Object(m)
}

/// 테스트에서 머지 로직만 따로 검증하기 위한 얇은 래퍼.
#[cfg(test)]
pub fn apply_service_form_for_test(base: Value, f: &ServiceForm) -> Value {
    apply_service_form(base, f)
}

/// 검증만 따로 확인하기 위한 테스트 통로 (`validate` 는 비공개다).
#[cfg(test)]
pub fn validate_for_test(f: &ServiceForm) -> AppResult<()> {
    f.validate()
}
