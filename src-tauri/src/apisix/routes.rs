//! Route CRUD.
//!
//! # 플러그인 보존
//!
//! 디자인의 `routeJson()` 은 `plugins` 를 통째로 교체한다. 그대로 구현하면 게이트웨이에
//! 이미 붙어 있던 `limit-count` 같은 플러그인이 저장 시 사라진다. 그래서 저장 직전에
//! 원본을 GET 해 와 **앱이 관리하는 키(`proxy-rewrite.uri` · `proxy-rewrite.regex_uri` ·
//! `shi-auth.allowed_groups`)만 덮어쓰는** 머지 방식으로 처리한다. `proxy-rewrite` 안의
//! `scheme` · `headers` 처럼 앱이 모르는 키도 같은 이유로 보존된다.
//!
//! # 전체 허용 (`auth_mode = "public"`)
//!
//! 권한 없이 누구나 호출할 수 있는 라우트가 필요하다. 그것은 `allowed_groups` 를 빈 배열로
//! 두는 것으로는 안 된다 — 게이트웨이에서 그 상태는 **정반대**(어느 그룹도 못 들어옴)다.
//! 권한 검사를 실제로 떼려면 `plugins.shi-auth` 를 통째로 지워야 하고, 그래서 폼은 두 모드를
//! 가진다: `groups`(그룹 목록을 되쓴다) · `public`(플러그인을 지운다).

use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Wry};

use super::client;
use super::models::{
    extract_list, extract_one, obj, set_groups_at, set_or_remove, strip_server_fields,
    GroupsLocation, RouteView, ROUTE_AUTH_PLUGIN,
};
use crate::config::Env;
use crate::error::{AppError, AppResult, ErrorKind};
use crate::history;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteForm {
    /// 비어 있으면 신규 등록 → `POST /routes` 로 APISIX 가 id 를 자동 생성한다.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub uri: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub methods: Vec<String>,
    #[serde(default)]
    pub service_id: String,
    /// `proxy-rewrite.uri` — `rewrite_mode` 가 `"uri"` 일 때만 쓴다.
    #[serde(default)]
    pub rewrite: String,
    /// `"uri"` | `"regex"`. 어느 키를 남길지 정한다 (`apply_route_form` 주석 참조).
    /// 빈 값은 `"uri"` 로 읽는다 — 이 필드가 없던 시절의 본문도 그대로 받는다.
    #[serde(default)]
    pub rewrite_mode: String,
    /// `proxy-rewrite.regex_uri` — 배열 그대로. 폼은 첫 쌍만 편집하고 나머지는 여기 실려 온다.
    #[serde(default)]
    pub rewrite_regex: Vec<String>,
    #[serde(default)]
    pub groups: Vec<String>,
    /// `"groups"` | `"public"`. `groups` 는 위 목록을 그룹 필드에 되쓰고, `public`(전체 허용)은
    /// 권한 플러그인을 **지운다** (`apply_route_form` 주석 참조).
    ///
    /// 빈 값은 `"groups"` 로 읽는다 — 이 필드가 없던 시절의 본문도 그대로 받고, 누락이
    /// 권한을 조용히 풀어 버리는 쪽으로 떨어지지 않는다 (`rewrite_mode` 와 같은 관례).
    #[serde(default)]
    pub auth_mode: String,
    /// 디자인상 등록 시 1(활성) 고정. 기존 항목은 원래 status 를 유지한다.
    #[serde(default)]
    pub status: Option<i64>,
    /// 조회 때 allowed_groups 가 실제로 있던 자리. 없으면 기본(shi-auth/allowed_groups).
    #[serde(default)]
    pub groups_location: Option<GroupsLocation>,
}

impl RouteForm {
    fn validate(&self) -> AppResult<()> {
        if self.name.trim().is_empty() {
            return Err(AppError::config("name 은 필수입니다."));
        }
        if self.uri.trim().is_empty() {
            return Err(AppError::config("uri 는 필수입니다."));
        }
        if self.service_id.trim().is_empty() {
            return Err(AppError::config("service_id 는 필수입니다."));
        }
        if self.is_regex_rewrite() {
            let v = self.regex_values();
            // 전부 비었으면 "rewrite 없음" 이다 — uri 모드에서 빈 칸을 둔 것과 같이 다룬다.
            // 반쯤 채운 것만 막는다. 그대로 보내면 게이트웨이가 스키마 오류로 거부하는데,
            // 무엇이 비었는지는 여기가 안다.
            if !v.is_empty() {
                if v.iter().any(String::is_empty) {
                    return Err(AppError::config(
                        "regex_uri 는 패턴과 치환값을 모두 입력해야 합니다.",
                    ));
                }
                // APISIX 는 쌍 단위로 시도한다 (minItems = 2). 홀수면 짝 없는 항목이 남는다.
                if v.len() % 2 != 0 {
                    return Err(AppError::config(
                        "regex_uri 는 (패턴, 치환값) 쌍이어야 합니다.",
                    ));
                }
            }
        }
        Ok(())
    }

    /// `proxy-rewrite` 를 `regex_uri` 로 쓰는가.
    fn is_regex_rewrite(&self) -> bool {
        self.rewrite_mode.trim() == "regex"
    }

    /// 권한 없이 접근할 수 있는 라우트인가 (전체 허용).
    fn is_public_auth(&self) -> bool {
        self.auth_mode.trim() == "public"
    }

    /// 다듬은 `regex_uri` 항목들. **전부 비었으면 빈 벡터**다 (= rewrite 없음).
    ///
    /// 중간의 빈 항목은 걸러 내지 않는다 — 걸러 내면 쌍이 밀려 엉뚱한 패턴·치환이 짝이 된다.
    /// 그 상태는 `validate` 가 막는다.
    fn regex_values(&self) -> Vec<String> {
        let v: Vec<String> = self.rewrite_regex.iter().map(|s| s.trim().to_string()).collect();
        if v.iter().all(String::is_empty) {
            return Vec::new();
        }
        v
    }
}

pub async fn list(app: &AppHandle<Wry>, env: Env) -> AppResult<Vec<RouteView>> {
    let (resp, _) = client::request(app, env, Method::GET, "routes", None).await?;
    let items = extract_list(&resp);
    let views: Vec<RouteView> = items.iter().map(RouteView::from_value).collect();
    history::record(
        app,
        env,
        "GET",
        "routes",
        format!("라우트 목록 조회 ({}건)", views.len()),
        "/apisix/admin/routes",
    );
    Ok(views)
}

/// 저장 직전 원본을 읽어 온다.
///
/// 여기서 실패하면 **저장을 중단해야 한다**. 빈 객체로 대체하고 진행하면 머지의 의미가 사라져
/// 게이트웨이에 붙어 있던 다른 플러그인을 통째로 날려버리기 때문이다. 플러그인을 보존하려고
/// 만든 경로가 오히려 데이터 손실을 내는 상황이라, 조용한 실패를 허용하지 않는다.
async fn fetch_base(app: &AppHandle<Wry>, env: Env, id: &str) -> AppResult<Value> {
    let (resp, _) = client::request(app, env, Method::GET, &format!("routes/{id}"), None)
        .await
        .map_err(|e| match e.kind {
            ErrorKind::NotFound => AppError::new(
                ErrorKind::NotFound,
                "이미 삭제된 라우트입니다. 목록을 새로고침한 뒤 다시 시도하세요.",
            ),
            _ => AppError::new(
                e.kind,
                format!("저장 전 원본을 읽지 못해 중단했습니다: {}", e.message),
            )
            .with_hint("그대로 저장하면 게이트웨이의 다른 플러그인 설정이 지워질 수 있습니다."),
        })?;

    Ok(extract_one(&resp).unwrap_or_else(|| json!({})))
}

pub async fn save(app: &AppHandle<Wry>, env: Env, form: RouteForm) -> AppResult<RouteView> {
    form.validate()?;

    let is_new = form.id.as_deref().map(str::trim).unwrap_or("").is_empty();
    let base = if is_new {
        json!({})
    } else {
        fetch_base(app, env, form.id.as_deref().unwrap_or("")).await?
    };

    let body = apply_route_form(base, &form, is_new);

    let (method, path) = if is_new {
        // id 를 지정하지 않으면 APISIX 가 자동 생성한다.
        (Method::POST, "routes".to_string())
    } else {
        (Method::PUT, format!("routes/{}", form.id.as_deref().unwrap_or("")))
    };

    let (resp, _) = client::request(app, env, method.clone(), &path, Some(&body)).await?;

    let saved = extract_one(&resp).unwrap_or(body);
    let view = RouteView::from_value(&saved);

    // 전체 허용은 "권한그룹 0건" 과 전혀 다른 일이다 — 이력에서 구별되어야 한다.
    let auth = if form.is_public_auth() {
        "전체 허용".to_string()
    } else {
        format!("allowed_groups {}건", form.groups.len())
    };
    let note = if is_new {
        format!("라우트 신규 등록 · methods {} · {auth}", join_or_dash(&form.methods))
    } else {
        format!("라우트 수정 · {auth}")
    };
    let target = if view.id.is_empty() {
        "routes".to_string()
    } else {
        format!("routes/{}", view.id)
    };
    history::record(app, env, method.as_str(), &target, note, &format!("/apisix/admin/{path}"));

    Ok(view)
}

pub async fn delete(app: &AppHandle<Wry>, env: Env, id: &str, name: &str) -> AppResult<()> {
    if id.trim().is_empty() {
        return Err(AppError::config("삭제할 라우트의 id 가 없습니다."));
    }
    let path = format!("routes/{id}");
    client::request(app, env, Method::DELETE, &path, None).await?;
    history::record(
        app,
        env,
        "DELETE",
        &path,
        format!("라우트 삭제 · {}", if name.is_empty() { id } else { name }),
        &format!("/apisix/admin/{path}"),
    );
    Ok(())
}

// ── 폼 → 요청 본문 (머지) ────────────────────────────────────

fn join_or_dash(v: &[String]) -> String {
    if v.is_empty() { "—".into() } else { v.join(",") }
}

/// 원본 route 객체 위에 폼 값을 얹는다. 앱이 모르는 필드/플러그인은 그대로 보존된다.
fn apply_route_form(base: Value, f: &RouteForm, is_new: bool) -> Value {
    let mut m = obj(base);

    strip_server_fields(&mut m);

    set_or_remove(&mut m, "name", f.name.trim());
    set_or_remove(&mut m, "desc", f.desc.trim());
    set_or_remove(&mut m, "service_id", f.service_id.trim());

    // uri / uris — 화면에서는 한 줄 문자열로 다루고, 쉼표가 있으면 배열로 되돌린다.
    let uri = f.uri.trim();
    if uri.contains(',') {
        let uris: Vec<Value> = uri
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| Value::String(s.to_string()))
            .collect();
        m.remove("uri");
        m.insert("uris".into(), Value::Array(uris));
    } else {
        m.remove("uris");
        m.insert("uri".into(), Value::String(uri.to_string()));
    }

    if f.methods.is_empty() {
        // methods 를 빼면 APISIX 는 모든 메서드를 허용한다.
        m.remove("methods");
    } else {
        m.insert(
            "methods".into(),
            Value::Array(f.methods.iter().map(|x| Value::String(x.clone())).collect()),
        );
    }

    // status — 디자인상 신규는 1(활성) 고정, 기존은 원래 값을 유지한다.
    let status = if is_new { 1 } else { f.status.or_else(|| m.get("status").and_then(Value::as_i64)).unwrap_or(1) };
    m.insert("status".into(), json!(status));

    // ── plugins 머지 ────────────────────────────────────────
    let mut plugins = obj(m.remove("plugins").unwrap_or(Value::Null));

    // proxy-rewrite — 다른 설정(headers · scheme 등)은 건드리지 않는다.
    //
    // `uri` 와 `regex_uri` 중 **항상 한쪽만 남긴다.** APISIX 의 proxy-rewrite 는
    // `if conf.uri ~= nil then … elseif conf.regex_uri ~= nil then` 순서라 `uri` 가 있으면
    // `regex_uri` 를 아예 보지 않는다 (스키마 주석: "lower priority than uri property").
    // 둘을 함께 남기면 화면에는 regex 가 보이는데 게이트웨이는 uri 로 도는 상태가 된다.
    let mut pr = obj(plugins.remove("proxy-rewrite").unwrap_or(Value::Null));
    if f.is_regex_rewrite() {
        pr.remove("uri");
        let values = f.regex_values();
        // validate 가 반쯤 채운 것과 홀수를 막지만, 저장 경로가 늘어도 깨지지 않게 여기서도 본다.
        if values.len() >= 2 && values.len() % 2 == 0 && !values.iter().any(String::is_empty) {
            pr.insert(
                "regex_uri".into(),
                Value::Array(values.into_iter().map(Value::String).collect()),
            );
        } else {
            pr.remove("regex_uri");
        }
    } else {
        pr.remove("regex_uri");
        let rewrite = f.rewrite.trim();
        if rewrite.is_empty() {
            pr.remove("uri");
        } else {
            pr.insert("uri".into(), Value::String(rewrite.to_string()));
        }
    }
    if !pr.is_empty() {
        plugins.insert("proxy-rewrite".into(), Value::Object(pr));
    }

    // ── 권한그룹 / 전체 허용 ────────────────────────────────
    //
    // 그룹 모드는 **조회 때 값이 있던 바로 그 자리에** 되쓴다. 다른 도구가 `auth_groups`
    // 처럼 다른 표기로 넣어 뒀다면 그 표기를 유지해야 키가 둘로 갈라지지 않는다
    // (models::find_groups 참조).
    let loc = f.groups_location.clone().unwrap_or_else(GroupsLocation::route_default);

    if f.is_public_auth() {
        // 전체 허용은 권한 검사를 **떼는** 것이다. 빈 `allowed_groups` 를 남기면
        // 게이트웨이에서는 정반대(어느 그룹도 못 들어옴)가 되므로 플러그인을 통째로 지운다.
        //
        // 지우는 대상이 둘인 이유: 이 앱의 라우트 권한 플러그인은 `shi-auth` 지만, 그룹 값이
        // 다른 자리(다른 플러그인 · 최상위 필드)에서 읽혔을 수도 있다. 한쪽만 지우면 남은
        // 자리가 그대로 검사를 계속해 화면이 거짓말을 한다.
        plugins.remove(ROUTE_AUTH_PLUGIN);
        if loc.plugin.is_empty() {
            m.remove(&loc.key);
        } else {
            plugins.remove(&loc.plugin);
        }
    }

    // 남은 플러그인이 하나도 없으면 키 자체를 없앤다 — Service 와 같은 규칙이다
    // (`services::apply_service_form`). 빈 껍데기(`plugins: {}`)를 남기지 않는다.
    if !plugins.is_empty() {
        m.insert("plugins".into(), Value::Object(plugins));
    }

    if !f.is_public_auth() {
        set_groups_at(&mut m, &loc, &f.groups);
    }

    Value::Object(m)
}


/// 테스트에서 입력 검증만 따로 보기 위한 통로 (`validate` 는 비공개다).
#[cfg(test)]
pub fn validate_for_test(f: &RouteForm) -> AppResult<()> {
    f.validate()
}

/// 테스트에서 머지 로직만 따로 검증하기 위한 얇은 래퍼.
#[cfg(test)]
pub fn apply_route_form_for_test(base: Value, f: &RouteForm, is_new: bool) -> Value {
    apply_route_form(base, f, is_new)
}
