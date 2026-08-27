//! JWT(HS256) 발급 — Consumer 용(`sign`)과 관리 토큰용(`sign_admin`) 두 가지.
//!
//! 디자인의 `sign()` 을 그대로 옮기되 서명을 Rust 에서 수행한다 — secret 이
//! 웹뷰 메모리를 오가는 횟수를 줄이기 위해서다. 토큰 문자열이 디자인과 완전히
//! 동일해지도록 헤더·페이로드 JSON 을 **키 순서까지 맞춰** 직접 만든다.
//! (serde_json 의 Map 은 기본이 정렬 저장이라 json! 매크로를 쓰면 키 순서가 달라진다)
//!
//! 관리 토큰의 서명 secret 은 상수가 아니라 **호출부가 넘긴다** — 관리키(`secret$token`)에
//! 실려 오기 때문이다. 관리키 조립·해석과 권한 판정은 `perm.rs` 가 한다. 여기는 만들기만 한다.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{Local, TimeZone};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::Serialize;
use sha2::Sha256;

use crate::error::{AppError, AppResult};
use crate::perm::{Perm, ADMIN_KEY};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JwtResult {
    pub token: String,
    pub nbf: i64,
    pub exp: i64,
    pub nbf_human: String,
    pub exp_human: String,
    /// 화면의 payload 블록에 그대로 뿌리는 pretty JSON
    pub payload: String,
    pub alg: String,
}

/// 고정 유효 시작 시각: 로컬 시간 2025-08-01 00:00:00
///
/// 발급 시점(now)을 쓰면 같은 consumer 인데 발급할 때마다 토큰이 달라져,
/// 이미 배포된 토큰과 새로 뽑은 토큰이 서로 다른 값이 된다. 기준 시각을 고정하면
/// (key, secret) 이 같은 한 언제 눌러도 **같은 토큰**이 나온다.
fn fixed_nbf() -> i64 {
    Local
        .with_ymd_and_hms(2025, 8, 1, 0, 0, 0)
        .single()
        .map(|d| d.timestamp())
        .unwrap_or(1_754_006_400)
}

/// 디자인이 하드코딩한 만료 시각: 로컬 시간 3000-12-31 17:59:00
fn design_exp() -> i64 {
    Local
        .with_ymd_and_hms(3000, 12, 31, 17, 59, 0)
        .single()
        .map(|d| d.timestamp())
        .unwrap_or(32_503_647_540)
}

pub fn human(ts: i64) -> String {
    Local
        .timestamp_opt(ts, 0)
        .single()
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "—".into())
}

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// JSON 문자열 리터럴로 안전하게 이스케이프한다.
fn quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// payload JSON 을 HS256 으로 서명해 `JwtResult` 로 감싼다.
///
/// `sign` 과 `sign_admin` 이 공유한다 — 서명 절차를 두 벌 두면 한쪽만 고치는 사고가 난다.
/// `payload_json` 과 `payload_pretty` 를 **호출부가 각각 만들어 넘기는** 이유는 위 모듈
/// 주석대로 키 순서를 손으로 맞춰야 하기 때문이다 (serde_json::Map 은 정렬 저장이다).
fn finish(
    secret: &str,
    payload_json: &str,
    payload_pretty: String,
    nbf: i64,
    exp: i64,
) -> AppResult<JwtResult> {
    let header_json = r#"{"alg":"HS256","typ":"JWT"}"#;
    let signing_input = format!("{}.{}", b64(header_json.as_bytes()), b64(payload_json.as_bytes()));

    let mut mac = HmacSha256::new_from_slice(secret.trim().as_bytes())
        .map_err(|e| AppError::internal(format!("HMAC 키 생성 실패: {e}")))?;
    mac.update(signing_input.as_bytes());
    let sig = mac.finalize().into_bytes();

    Ok(JwtResult {
        token: format!("{signing_input}.{}", b64(&sig)),
        nbf,
        exp,
        nbf_human: human(nbf),
        exp_human: human(exp),
        payload: payload_pretty,
        alg: "HS256".to_string(),
    })
}

pub fn sign(
    key: &str,
    secret: &str,
    nbf_override: Option<i64>,
    exp_override: Option<i64>,
) -> AppResult<JwtResult> {
    if key.trim().is_empty() || secret.trim().is_empty() {
        return Err(AppError::config("토큰을 생성하려면 key 와 secret 이 모두 필요합니다."));
    }

    let nbf = nbf_override.unwrap_or_else(fixed_nbf);
    let exp = exp_override.unwrap_or_else(design_exp);

    let payload_json = format!(r#"{{"key":{},"nbf":{},"exp":{}}}"#, quote(key.trim()), nbf, exp);
    let payload_pretty = format!(
        "{{\n  \"key\": {},\n  \"nbf\": {},\n  \"exp\": {}\n}}",
        quote(key.trim()),
        nbf,
        exp
    );

    finish(secret, &payload_json, payload_pretty, nbf, exp)
}

/// 관리 토큰(admin token) 을 발급한다 — `{key, nbf, exp, perm}`.
///
/// `key` 는 `perm::ADMIN_KEY` 고정이고, `secret` 은 발급하는 사람이 넣는다 —
/// 게이트웨이의 관리 consumer 에 등록된 `jwt-auth.secret` 과 같아야 실제로 통한다.
/// 여기서 만든 토큰은 `perm::decode` 가 같은 secret 으로 그대로 되읽는다.
/// Consumer 토큰(`sign`)과 달리 유효기간이 인자다 — 관리 권한을 기간제로 주는 것이
/// 이 토큰의 존재 이유이기 때문이다.
pub fn sign_admin(secret: &str, nbf: i64, exp: i64, perm: &Perm) -> AppResult<JwtResult> {
    let secret = secret.trim();
    if secret.is_empty() {
        return Err(AppError::config("관리 토큰을 발급하려면 secret 이 필요합니다."));
    }
    // `$` 는 관리키(`secret$token`)의 구분자다. 값에 섞이면 관리키가 어디서 갈리는지
    // 모호해지므로 발급 시점에 거부해 알려 준다. (`perm::SEP`)
    if secret.contains('$') {
        return Err(AppError::config("secret 에는 $ 를 넣을 수 없습니다."));
    }
    if exp <= nbf {
        return Err(AppError::config("종료일은 시작일보다 뒤여야 합니다."));
    }

    // service id 를 정렬·중복 제거해 **여기서** 정규화한다. 호출부에 맡기면 같은 권한을
    // 고른 두 사람이 서로 다른 토큰을 받는다 — 모듈 주석의 "키 순서까지 맞춘다" 와 같은
    // 이유로, 토큰 문자열의 모양을 정하는 곳은 한 군데여야 한다.
    let ids: Option<Vec<String>> = match perm {
        Perm::Admin => None,
        Perm::Services(raw) => {
            let mut v: Vec<String> =
                raw.iter().map(|i| i.trim().to_string()).filter(|i| !i.is_empty()).collect();
            v.sort();
            v.dedup();
            if v.is_empty() {
                return Err(AppError::config(
                    "전체 관리자가 아니면 권한 service 를 하나 이상 골라야 합니다.",
                ));
            }
            Some(v)
        }
        // 발급 폼은 '전체 관리자 / service 지정' 둘만 만든다. 나머지는 읽는 쪽 상태라
        // 여기까지 올 일이 없지만, 조용히 admin 으로 흘려보내지 않도록 막아 둔다.
        Perm::Opaque(_) | Perm::None(_) => {
            return Err(AppError::internal("이 권한 상태로는 토큰을 발급할 수 없습니다."))
        }
    };

    let (perm_json, perm_pretty) = match &ids {
        None => ("\"admin\"".to_string(), "\"admin\"".to_string()),
        Some(v) => {
            let quoted: Vec<String> = v.iter().map(|i| quote(i)).collect();
            (format!("[{}]", quoted.join(",")), format!("[\n    {}\n  ]", quoted.join(",\n    ")))
        }
    };

    let payload_json = format!(
        r#"{{"key":{},"nbf":{},"exp":{},"perm":{}}}"#,
        quote(ADMIN_KEY),
        nbf,
        exp,
        perm_json
    );
    let payload_pretty = format!(
        "{{\n  \"key\": {},\n  \"nbf\": {},\n  \"exp\": {},\n  \"perm\": {}\n}}",
        quote(ADMIN_KEY),
        nbf,
        exp,
        perm_pretty
    );

    finish(secret, &payload_json, payload_pretty, nbf, exp)
}

/// 디자인의 `genSecret()` 과 동일 — 16바이트 난수를 hex 32자로.
pub fn gen_secret() -> String {
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
