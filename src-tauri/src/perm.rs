//! 관리 토큰(JWT)이 실어 나르는 관리 권한.
//!
//! # 관리키 = `secret$token`
//!
//! 사용자가 붙여넣고 자격 증명 관리자에 저장되는 문자열을 **관리키**라 부른다.
//! `$` 앞이 서명 검증에 쓰는 secret 이고, 뒤가 **관리 토큰**(HS256 JWT)이다.
//! 서명 secret 을 바이너리에 상수로 두지 않기 위한 형식이다 — 저장소나 실행 파일만으로는
//! 아무 토큰도 만들 수 없다. `split` · `join` 이 이 형식을 도맡는다.
//!
//! 토큰의 `key` 클레임은 `ADMIN_KEY` 로 고정이고, payload 에 유효기간(`nbf`·`exp`)과
//! 권한(`perm`)이 들어 있다. 앱은 그것을 해석해 메뉴·목록·콤보박스를 제한한다.
//!
//! ```json
//! { "key": "…", "nbf": 1767225600, "exp": 1798761599, "perm": "admin" }
//! { "key": "…", "nbf": 1767225600, "exp": 1798761599, "perm": ["svc-a", "svc-b"] }
//! ```
//!
//! # 이 권한 모델의 범위
//!
//! 여기서 하는 일은 **화면을 줄이는 것**뿐이다. 진짜 인가 경계는 APISIX 서버다 —
//! 관리키의 **토큰 부분만** `X-API-KEY` 로 나가고(secret 은 앱 밖으로 나가지 않는다),
//! 무엇을 허용할지는 게이트웨이가 정한다.
//!
//! secret 과 토큰이 관리키에 **함께** 실려 오므로, 여기서 하는 서명 검증은 위조를 막지
//! 못한다 — 자기 secret 으로 서명한 관리키는 언제나 자기 검증을 통과한다. 그것이 걸리는
//! 곳은 게이트웨이다: `jwt-auth` 플러그인에 등록된 secret 과 다르면 거부된다. 즉 이 검증은
//! "붙여넣은 관리키가 스스로 앞뒤가 맞는가" 를 보는 것이고, 보안 경계로 삼아서는 안 된다.
//! (README '보안' 절)

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;

use crate::apisix::models::ServiceView;
use crate::config::{self, Env};

type HmacSha256 = Hmac<Sha256>;

/// 관리 토큰 JWT 의 `key` 클레임. 게이트웨이의 consumer key 와 같아야 한다.
pub const ADMIN_KEY: &str = "apisix-manage";

/// 관리키의 secret 과 토큰을 가르는 문자.
///
/// base64url 알파벳(`A-Za-z0-9-_`)과 `.` 에 없는 문자를 골랐다 — 토큰 쪽에는 절대
/// 나타나지 않으므로 `rsplit_once` 로 나누면 secret 에 `$` 가 섞여 있어도 정확히 갈린다.
const SEP: char = '$';

/// 토큰이 주는 관리 권한.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Perm {
    /// 전체 관리자 — 모든 메뉴와 모든 service.
    Admin,
    /// 나열된 service id 에 대해서만 관리 권한. 빈 목록이면 아무것도 볼 수 없다.
    Services(Vec<String>),
    /// 권한 없음. 잠금 화면으로 간다.
    None(Reason),
}

/// `Perm::None` 이 된 이유. 잠금 화면 문구가 이걸로 갈린다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// 아직 관리키를 등록하지 않았다.
    NoToken,
    /// 관리키에 secret 이 없다 — `secret$token` 형식이 아니다.
    NoSecret,
    /// JWT 모양이 아니거나 payload 를 읽을 수 없다.
    NotJwt,
    /// 서명이 관리키에 실려 온 secret 과 맞지 않는다.
    BadSignature,
    /// `key` 클레임이 `ADMIN_KEY` 가 아니다.
    BadKey,
    /// `nbf` 가 아직 오지 않았다.
    NotYet,
    /// `exp` 가 지났다.
    Expired,
}

impl Reason {
    /// 잠금 화면이 그대로 쓰는 설명. 프런트에 문구를 두 벌 두지 않으려고 여기서 만든다.
    pub fn message(self) -> &'static str {
        match self {
            Reason::NoToken => "관리키가 등록되지 않았습니다.",
            Reason::NoSecret => "관리키가 secret$token 형식이 아닙니다.",
            Reason::NotJwt => "관리키의 토큰이 JWT 형식이 아닙니다.",
            Reason::BadSignature => "관리 토큰의 서명이 관리키의 secret 과 맞지 않습니다.",
            Reason::BadKey => "관리 토큰의 key 가 올바르지 않습니다.",
            Reason::NotYet => "관리 토큰의 사용 시작일이 아직 되지 않았습니다.",
            Reason::Expired => "관리 토큰의 사용 기간이 만료되었습니다.",
        }
    }
}

/// 서명·key 검증을 통과한 토큰의 클레임.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claims {
    pub nbf: i64,
    pub exp: i64,
    /// 기간 검사를 하기 **전**의 권한. `Admin` 또는 `Services` 만 나온다.
    pub perm: Perm,
}

/// 관리키를 쪼갠 결과 — secret 과 관리 토큰.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminKey {
    /// 서명 검증에 쓰는 secret. 게이트웨이 consumer 의 `jwt-auth.secret` 과 같아야 한다.
    pub secret: String,
    /// 관리 토큰(JWT). `X-API-KEY` 로 나가는 것은 이것뿐이다.
    pub token: String,
}

/// `secret$token` 을 쪼갠다.
///
/// **마지막** `$` 로 나눈다 (`SEP` 주석 참조). 양쪽의 공백은 여기서 한 번만 털어낸다 —
/// `jwt::finish` 가 HMAC 키를 `secret.trim()` 으로 만들므로, 서명하는 쪽과 검증하는 쪽이
/// 같은 문자열을 보려면 정규화 지점이 하나여야 한다.
pub fn split(raw: &str) -> Result<AdminKey, Reason> {
    let (secret, token) = raw.trim().rsplit_once(SEP).ok_or(Reason::NoSecret)?;
    let (secret, token) = (secret.trim(), token.trim());
    if secret.is_empty() {
        return Err(Reason::NoSecret);
    }
    if token.is_empty() {
        return Err(Reason::NotJwt);
    }
    Ok(AdminKey { secret: secret.to_string(), token: token.to_string() })
}

/// secret 과 토큰을 관리키 한 줄로 합친다. `split` 의 역이다.
pub fn join(secret: &str, token: &str) -> String {
    format!("{}{SEP}{}", secret.trim(), token.trim())
}

fn b64d(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

/// `perm` 클레임을 읽는다. 문자열 `"admin"` 이거나 문자열 배열이어야 한다.
fn read_perm(v: &serde_json::Value) -> Option<Perm> {
    match v {
        serde_json::Value::String(s) if s.trim() == "admin" => Some(Perm::Admin),
        serde_json::Value::Array(items) => {
            let mut ids = Vec::with_capacity(items.len());
            for it in items {
                // 배열에 문자열이 아닌 것이 섞여 있으면 조용히 버리지 않는다 —
                // 권한을 실제보다 좁게/넓게 해석하는 쪽 모두 위험하다.
                let s = it.as_str()?.trim();
                if !s.is_empty() {
                    ids.push(s.to_string());
                }
            }
            ids.sort();
            ids.dedup();
            Some(Perm::Services(ids))
        }
        _ => None,
    }
}

/// 관리 토큰을 해석한다. 서명과 `key` 클레임까지 검증하되 **유효기간은 보지 않는다** —
/// 만료된 토큰도 설정 화면에서 시작일·종료일을 보여 줘야 하므로, 기간 판정은 `at` 이 따로 한다.
///
/// `secret` 은 관리키에서 온다(`split`). 상수가 아니라 인자인 이유는 모듈 주석 참조.
pub fn decode(token: &str, secret: &str) -> Result<Claims, Reason> {
    let t = token.trim();
    let parts: Vec<&str> = t.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty()) {
        return Err(Reason::NotJwt);
    }

    let header: serde_json::Value =
        serde_json::from_slice(&b64d(parts[0]).ok_or(Reason::NotJwt)?).map_err(|_| Reason::NotJwt)?;
    if header.get("alg").and_then(|a| a.as_str()) != Some("HS256") {
        // alg=none 토큰을 서명 검증 전에 걷어낸다. (검증에서도 어차피 떨어지지만
        // 사용자에게 돌려줄 이유가 'NotJwt' 인 편이 정확하다)
        return Err(Reason::NotJwt);
    }

    let raw = b64d(parts[1]).ok_or(Reason::NotJwt)?;
    let payload: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| Reason::NotJwt)?;

    // 서명 검증 — `verify_slice` 는 상수 시간 비교다.
    let sig = b64d(parts[2]).ok_or(Reason::NotJwt)?;
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let mut mac = HmacSha256::new_from_slice(secret.trim().as_bytes())
        .map_err(|_| Reason::BadSignature)?;
    mac.update(signing_input.as_bytes());
    mac.verify_slice(&sig).map_err(|_| Reason::BadSignature)?;

    if payload.get("key").and_then(|k| k.as_str()).map(str::trim) != Some(ADMIN_KEY) {
        return Err(Reason::BadKey);
    }

    let nbf = payload.get("nbf").and_then(|v| v.as_i64()).ok_or(Reason::NotJwt)?;
    let exp = payload.get("exp").and_then(|v| v.as_i64()).ok_or(Reason::NotJwt)?;
    let perm = payload.get("perm").and_then(read_perm).ok_or(Reason::NotJwt)?;

    Ok(Claims { nbf, exp, perm })
}

/// 클레임을 `now` 시점의 권한으로 판정한다. (테스트가 시각을 고정할 수 있도록 분리해 둔다)
pub fn at(claims: &Claims, now: i64) -> Perm {
    if now < claims.nbf {
        return Perm::None(Reason::NotYet);
    }
    if now >= claims.exp {
        return Perm::None(Reason::Expired);
    }
    claims.perm.clone()
}

/// 해당 환경에 저장된 토큰을 읽어 지금 시각 기준 권한을 판정한다.
///
/// 앱 안에서 "이 사람이 무엇을 할 수 있는가" 를 묻는 곳은 전부 여기를 통한다.
pub fn resolve(env: Env) -> Perm {
    let Some(raw) = config::get_token(env) else {
        return Perm::None(Reason::NoToken);
    };
    let key = match split(&raw) {
        Ok(k) => k,
        Err(reason) => return Perm::None(reason),
    };
    match decode(&key.token, &key.secret) {
        Ok(claims) => at(&claims, chrono::Local::now().timestamp()),
        Err(reason) => Perm::None(reason),
    }
}

impl Perm {
    pub fn is_admin(&self) -> bool {
        matches!(self, Perm::Admin)
    }

    /// 이 service 를 관리할 수 있는가.
    pub fn allows(&self, service_id: &str) -> bool {
        match self {
            Perm::Admin => true,
            Perm::Services(ids) => ids.iter().any(|i| i == service_id.trim()),
            Perm::None(_) => false,
        }
    }

    /// SQL 허용목록 문자열 — `db` 의 `SERVICE_CLAUSE` 가 `instr` 로 훑는다.
    ///
    /// `""` 는 "제한 없음"(admin)이다. 그 외에는 `"\nid1\nid2\n"` 모양이라
    /// `instr(blob, "\n" || service_id || "\n")` 이 정확히 한 항목만 맞춘다.
    /// 권한 service 가 0개면 `"\n"` 이 되어 무엇과도 맞지 않는다 — 의도한 동작이다.
    /// (`Perm::None` 도 같다. 잠금 화면이 먼저 뜨지만 조회 경로가 열려도 0건이어야 한다)
    pub fn allow_blob(&self) -> String {
        match self {
            Perm::Admin => String::new(),
            // 빈 목록에 아래 `format!` 을 그대로 쓰면 `"\n\n"` 이 나오는데, 그것은 service 가
            // 없는 라우트(`service_id = ''`)를 찾는 바늘과 **정확히 같다** — 권한이 하나도
            // 없는 토큰에게 그 라우트들이 보이게 된다. 그래서 빈 목록은 따로 처리한다.
            Perm::Services(ids) if ids.is_empty() => "\n".to_string(),
            Perm::Services(ids) => format!("\n{}\n", ids.join("\n")),
            Perm::None(_) => "\n".to_string(),
        }
    }

    /// 권한 있는 service 만 남긴다. `services` 배열을 프런트로 내려보내기 직전에 쓴다.
    pub fn filter_services(&self, items: Vec<ServiceView>) -> Vec<ServiceView> {
        match self {
            Perm::Admin => items,
            _ => items.into_iter().filter(|s| self.allows(&s.id)).collect(),
        }
    }
}

// ── 프런트로 내려보내는 뷰 모델 ──────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermKind {
    Admin,
    Scoped,
    None,
}

/// 권한 서비스 한 건 — id 와, 캐시에서 찾은 표시용 이름.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermService {
    pub id: String,
    /// 캐시에 없으면 id 를 그대로 쓴다 (다른 환경 카드를 보고 있을 때).
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermView {
    pub kind: PermKind,
    /// `kind == none` 일 때의 사유. 그 외에는 `null`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    /// 사유 설명 문구. `kind != none` 이면 빈 문자열.
    pub message: String,
    /// 토큰을 해석할 수 있었는가 — 기간이 지났어도 시작일·종료일은 보여 준다.
    pub has_claims: bool,
    pub nbf: i64,
    pub exp: i64,
    pub nbf_human: String,
    pub exp_human: String,
    /// 권한 service 목록. admin 이면 빈 배열.
    pub services: Vec<PermService>,
}

impl PermView {
    fn empty(reason: Reason) -> Self {
        Self {
            kind: PermKind::None,
            reason: Some(reason),
            message: reason.message().to_string(),
            has_claims: false,
            nbf: 0,
            exp: 0,
            nbf_human: String::new(),
            exp_human: String::new(),
            services: Vec::new(),
        }
    }
}

/// 설정 화면이 쓰는 뷰. 기간이 지난 토큰도 시작일·종료일·권한 서비스를 보여 준다 —
/// 사용자가 "왜 막혔는지" 를 그 화면에서 알 수 있어야 하기 때문이다.
///
/// `names` 는 service id → name 을 찾아 주는 함수다. 호출부가 캐시를 들고 있고
/// 이 모듈은 db 를 몰라도 되게 하려고 클로저로 받는다.
pub fn view(env: Env, names: impl Fn(&str) -> Option<String>) -> PermView {
    let Some(raw) = config::get_token(env) else {
        return PermView::empty(Reason::NoToken);
    };
    let key = match split(&raw) {
        Ok(k) => k,
        Err(reason) => return PermView::empty(reason),
    };
    let claims = match decode(&key.token, &key.secret) {
        Ok(c) => c,
        Err(reason) => return PermView::empty(reason),
    };

    let now = chrono::Local::now().timestamp();
    let effective = at(&claims, now);
    let (kind, reason) = match &effective {
        Perm::Admin => (PermKind::Admin, None),
        Perm::Services(_) => (PermKind::Scoped, None),
        Perm::None(r) => (PermKind::None, Some(*r)),
    };

    // 서비스 목록은 **기간 판정 전** 클레임에서 읽는다. 만료됐다고 빈 목록을 보여 주면
    // 사용자가 자기 토큰이 무엇을 담고 있었는지 확인할 방법이 없다.
    let services = match &claims.perm {
        Perm::Services(ids) => ids
            .iter()
            .map(|id| PermService {
                id: id.clone(),
                name: names(id).unwrap_or_else(|| id.clone()),
            })
            .collect(),
        _ => Vec::new(),
    };

    PermView {
        kind,
        reason,
        message: reason.map(|r| r.message().to_string()).unwrap_or_default(),
        has_claims: true,
        nbf: claims.nbf,
        exp: claims.exp,
        nbf_human: crate::jwt::human(claims.nbf),
        exp_human: crate::jwt::human(claims.exp),
        services,
    }
}
