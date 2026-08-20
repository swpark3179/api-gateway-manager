//! OAS 3.0 스펙 파싱과 uri 정규화.
//!
//! 이 모듈은 `AppHandle` 을 받지 않는 순수 함수만 담는다. Import 기능의 판단 로직이
//! 전부 여기 모여 있어야 테스트로 고정할 수 있다 (`tests.rs` 참조).
//!
//! # 왜 엄격 파싱과 관대한 폴백을 둘 다 두는가
//!
//! `openapiv3` 로 타입 파싱을 하면 문서가 진짜 OAS 3.0 인지 검증되고 `operationId` ·
//! `summary` · `tags` 를 구조적으로 얻을 수 있다. 그런데 현장에서 도는 스펙은 스키마를
//! 어기는 일이 흔하다 (`type: [string, null]` 같은 3.1 문법 혼용, 벤더 확장, 오타).
//! 그 한 줄 때문에 수백 개 API 비교가 통째로 막히는 것이 더 나쁘므로, 엄격 파싱이
//! 실패하면 `paths` 를 직접 훑는 경로로 내려가고 경고만 화면에 띄운다.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult, ErrorKind};

/// OAS 문서에서 뽑아낸 오퍼레이션 한 건 = (path, method) 하나.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OasOp {
    pub path: String,
    /// 항상 대문자 (GET · POST · …)
    pub method: String,
    pub operation_id: String,
    pub summary: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OasDoc {
    pub title: String,
    pub version: String,
    /// `servers[0].url` 의 경로 부분 (`https://host/v1` → `/v1`). 화면에서 편집 가능한 기본값.
    pub server_prefix: String,
    pub ops: Vec<OasOp>,
    /// 엄격 파싱이 실패해 폴백으로 읽었을 때의 이유. 화면 상단 경고 배너로 띄운다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// OAS 가 정의하는 HTTP 메서드 필드. `paths.{path}` 아래 이 키들만 오퍼레이션이다
/// (`parameters` · `summary` · `servers` · `$ref` 등은 오퍼레이션이 아니다).
const OAS_METHODS: &[&str] =
    &["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/// 스펙 텍스트(YAML 또는 JSON)를 파싱한다.
pub fn parse(text: &str) -> AppResult<OasDoc> {
    if text.trim().is_empty() {
        return Err(AppError::new(ErrorKind::BadRequest, "빈 파일입니다."));
    }

    // YAML 은 JSON 의 상위집합이므로 이 한 줄이 두 포맷을 모두 처리한다.
    let root: Value = serde_norway::from_str(text).map_err(|e| {
        AppError::new(ErrorKind::BadRequest, format!("YAML/JSON 을 해석하지 못했습니다: {e}"))
            .with_hint("OAS 3.0 형식의 .yaml · .yml · .json 파일인지 확인하세요.")
    })?;

    check_version(&root)?;

    let title = root.pointer("/info/title").and_then(Value::as_str).unwrap_or("").to_string();
    let version = root.pointer("/info/version").and_then(Value::as_str).unwrap_or("").to_string();
    let server_prefix = server_prefix(&root);

    // 엄격 파싱 → 실패하면 관대한 폴백. 어느 쪽이든 ops 는 같은 모양으로 나온다.
    let (ops, warning) = match serde_json::from_value::<openapiv3::OpenAPI>(root.clone()) {
        Ok(doc) => (ops_from_typed(&doc), None),
        Err(e) => (
            ops_from_value(&root),
            Some(format!(
                "OAS 스키마 검증에 실패해 경로 정보만 읽었습니다: {e} \
                 (경로·메서드 비교는 그대로 동작합니다)"
            )),
        ),
    };

    if ops.is_empty() {
        return Err(AppError::new(ErrorKind::BadRequest, "문서에서 API 경로를 찾지 못했습니다.")
            .with_hint("paths 항목이 비어 있는지 확인하세요."));
    }

    Ok(OasDoc { title, version, server_prefix, ops, warning })
}

/// `openapi: 3.x` 인지 확인한다. swagger 2.0 은 구조가 달라 지원하지 않는다.
fn check_version(root: &Value) -> AppResult<()> {
    if let Some(v) = root.get("openapi").and_then(Value::as_str) {
        if v.trim_start().starts_with("3.") {
            return Ok(());
        }
        return Err(AppError::new(
            ErrorKind::BadRequest,
            format!("지원하지 않는 OpenAPI 버전입니다: {v}"),
        )
        .with_hint("OAS 3.0 문서를 사용하세요."));
    }

    if root.get("swagger").is_some() {
        return Err(AppError::new(ErrorKind::BadRequest, "swagger 2.0 문서는 지원하지 않습니다.")
            .with_hint("OAS 3.0 으로 변환한 뒤 다시 시도하세요."));
    }

    Err(AppError::new(ErrorKind::BadRequest, "OpenAPI 문서가 아닙니다.")
        .with_hint("최상위에 openapi: 3.0.x 필드가 있어야 합니다."))
}

/// `servers[0].url` 에서 경로 부분만 떼어 낸다.
///
/// 스킴이 있으면 host 뒤부터, 없으면(`/v1` 처럼 상대 URL) 그대로 쓴다.
/// 템플릿 변수(`{basePath}`)가 남아 있으면 게이트웨이 uri 와 맞을 수 없으므로 버린다.
fn server_prefix(root: &Value) -> String {
    let url = root
        .pointer("/servers/0/url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();

    if url.is_empty() {
        return String::new();
    }

    let path = match url.find("://") {
        Some(i) => match url[i + 3..].find('/') {
            Some(j) => &url[i + 3 + j..],
            None => "",
        },
        None => url,
    };

    if path.contains('{') {
        return String::new();
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        String::new()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn ops_from_typed(doc: &openapiv3::OpenAPI) -> Vec<OasOp> {
    let mut out = Vec::new();
    for (path, item) in doc.paths.iter() {
        // $ref 로 된 path item 은 참조를 따라갈 수 없으므로 건너뛴다.
        let openapiv3::ReferenceOr::Item(item) = item else { continue };
        for (method, op) in [
            ("GET", &item.get),
            ("PUT", &item.put),
            ("POST", &item.post),
            ("DELETE", &item.delete),
            ("OPTIONS", &item.options),
            ("HEAD", &item.head),
            ("PATCH", &item.patch),
            ("TRACE", &item.trace),
        ] {
            let Some(op) = op else { continue };
            out.push(OasOp {
                path: path.clone(),
                method: method.to_string(),
                operation_id: op.operation_id.clone().unwrap_or_default(),
                summary: op.summary.clone().or_else(|| op.description.clone()).unwrap_or_default(),
                tags: op.tags.clone(),
            });
        }
    }
    out
}

/// 엄격 파싱 실패 시의 폴백 — `paths` 를 생 JSON 으로 훑는다.
fn ops_from_value(root: &Value) -> Vec<OasOp> {
    let Some(paths) = root.get("paths").and_then(Value::as_object) else { return Vec::new() };

    let mut out = Vec::new();
    for (path, item) in paths {
        let Some(item) = item.as_object() else { continue };
        for m in OAS_METHODS {
            let Some(op) = item.get(*m) else { continue };
            // `get: null` 같은 값이 있을 수 있어 객체인지 확인한다.
            if !op.is_object() {
                continue;
            }
            out.push(OasOp {
                path: path.clone(),
                method: m.to_uppercase(),
                operation_id: op
                    .get("operationId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                summary: op
                    .get("summary")
                    .and_then(Value::as_str)
                    .or_else(|| op.get("description").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string(),
                tags: op
                    .get("tags")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_owned)).collect())
                    .unwrap_or_default(),
            });
        }
    }
    out
}

// ── uri 정규화 ───────────────────────────────────────────────

/// 경로 파라미터 세그먼트를 접어 넣는 자리표시자.
///
/// `{}` 는 uri 로 쓰이지 않는 문자 조합이라 실제 경로 세그먼트와 충돌하지 않는다.
const PARAM: &str = "{}";

/// 정규화된 uri 하나. 게이트웨이 uri 와 OAS path 를 같은 표현으로 접기 위한 것.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormUri {
    /// 파라미터 세그먼트를 `{}` 로 접은 경로
    pub norm: String,
    /// 와일드카드면 `*` 앞부분, 아니면 `norm` 과 동일
    pub prefix: String,
    /// 마지막 세그먼트가 `*` 였는가 (APISIX 접두 매칭)
    pub wildcard: bool,
}

/// OAS 의 `{id}`, APISIX 의 `:id`, 와일드카드 `*` 를 하나의 표현으로 접는다.
///
/// ```text
/// "/pets/{petId}/toys" == "/pets/:petId/toys" == "/pets/*/toys" == "/pets/{}/toys"
/// ```
///
/// 대소문자는 보존한다 — APISIX 의 uri 매칭은 대소문자를 구분한다.
pub fn normalize(uri: &str) -> NormUri {
    let raw = uri.trim();
    let raw = raw.split(['?', '#']).next().unwrap_or(raw);

    let segs: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();
    let last = segs.len().saturating_sub(1);

    // 끝이 '*' 면 접두 매칭. 그 자리는 자리표시자가 아니라 "여기부터 뭐든"이라는 뜻이다.
    let wildcard = segs.last().map(|s| *s == "*").unwrap_or(false);

    let mut norm = String::new();
    let mut prefix = String::new();
    for (i, seg) in segs.iter().enumerate() {
        if wildcard && i == last {
            break;
        }
        let folded = if is_param_seg(seg) { PARAM } else { seg };
        norm.push('/');
        norm.push_str(folded);
        prefix.push('/');
        prefix.push_str(folded);
    }

    if wildcard {
        // "/a/*" → prefix "/a", norm "/a/" (접두 비교는 prefix 로 한다)
        norm.push_str("/*");
        prefix.push('/');
    }

    if norm.is_empty() {
        norm.push('/');
    }
    if prefix.is_empty() {
        prefix.push('/');
    }

    NormUri { norm, prefix, wildcard }
}

/// 경로 파라미터 세그먼트인가 — `{id}` · `:id` · 중간의 `*` 를 모두 파라미터로 본다.
fn is_param_seg(seg: &str) -> bool {
    (seg.starts_with('{') && seg.ends_with('}')) || seg.starts_with(':') || seg == "*"
}

/// OAS path 를 APISIX route 의 uri 후보로 바꾼다 (신규 생성 폼 프리필용).
///
/// 파라미터가 **마지막 세그먼트**면 `*` (접두 매칭), 중간이면 APISIX 파라미터 문법 `:name`
/// 을 쓴다. 중간에 `*` 를 넣으면 기본 라우터(`radixtree_uri`)에서 매칭되지 않기 때문이다.
/// 사용자가 저장 전에 검토·수정하는 값이므로 "가장 그럴듯한 출발점"을 준다.
pub fn to_apisix_uri(prefix: &str, path: &str) -> String {
    let joined = join_path(prefix, path);
    let segs: Vec<&str> = joined.split('/').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() {
        return "/".to_string();
    }
    let last = segs.len() - 1;

    let mut out = String::new();
    for (i, seg) in segs.iter().enumerate() {
        out.push('/');
        if let Some(name) = param_name(seg) {
            if i == last {
                out.push('*');
            } else {
                out.push(':');
                out.push_str(&name);
            }
        } else {
            out.push_str(seg);
        }
    }
    out
}

/// `{petId}` · `:petId` → `petId`. 파라미터 세그먼트가 아니면 None.
fn param_name(seg: &str) -> Option<String> {
    let inner = if seg.starts_with('{') && seg.ends_with('}') && seg.len() > 2 {
        &seg[1..seg.len() - 1]
    } else if let Some(rest) = seg.strip_prefix(':') {
        rest
    } else if seg == "*" {
        // 이름 없는 와일드카드는 이름을 만들 수 없다 — 그대로 와일드카드로 취급한다.
        return Some("param".to_string());
    } else {
        return None;
    };

    let cleaned: String =
        inner.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    Some(if cleaned.is_empty() { "param".to_string() } else { cleaned })
}

/// 접두사와 path 를 `/` 하나로 이어 붙인다.
pub fn join_path(prefix: &str, path: &str) -> String {
    let p = prefix.trim().trim_end_matches('/');
    let s = path.trim();
    if p.is_empty() {
        return if s.starts_with('/') { s.to_string() } else { format!("/{s}") };
    }
    let p = if p.starts_with('/') { p.to_string() } else { format!("/{p}") };
    if s.is_empty() || s == "/" {
        return p;
    }
    if s.starts_with('/') {
        format!("{p}{s}")
    } else {
        format!("{p}/{s}")
    }
}
