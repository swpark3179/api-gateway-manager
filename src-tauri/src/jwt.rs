//! Consumer 용 JWT(HS256) 발급.
//!
//! 디자인의 `sign()` 을 그대로 옮기되 서명을 Rust 에서 수행한다 — secret 이
//! 웹뷰 메모리를 오가는 횟수를 줄이기 위해서다. 토큰 문자열이 디자인과 완전히
//! 동일해지도록 헤더·페이로드 JSON 을 **키 순서까지 맞춰** 직접 만든다.
//! (serde_json 의 Map 은 기본이 정렬 저장이라 json! 매크로를 쓰면 키 순서가 달라진다)

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{Local, TimeZone};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::Serialize;
use sha2::Sha256;

use crate::error::{AppError, AppResult};

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

fn human(ts: i64) -> String {
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

    let header_json = r#"{"alg":"HS256","typ":"JWT"}"#.to_string();
    let payload_json = format!(r#"{{"key":{},"nbf":{},"exp":{}}}"#, quote(key.trim()), nbf, exp);

    let signing_input = format!("{}.{}", b64(header_json.as_bytes()), b64(payload_json.as_bytes()));

    let mut mac = HmacSha256::new_from_slice(secret.trim().as_bytes())
        .map_err(|e| AppError::internal(format!("HMAC 키 생성 실패: {e}")))?;
    mac.update(signing_input.as_bytes());
    let sig = mac.finalize().into_bytes();

    let token = format!("{signing_input}.{}", b64(&sig));

    // 화면 표시용 pretty payload (키 순서 동일하게 수동 구성)
    let payload_pretty = format!(
        "{{\n  \"key\": {},\n  \"nbf\": {},\n  \"exp\": {}\n}}",
        quote(key.trim()),
        nbf,
        exp
    );

    Ok(JwtResult {
        token,
        nbf,
        exp,
        nbf_human: human(nbf),
        exp_human: human(exp),
        payload: payload_pretty,
        alg: "HS256".to_string(),
    })
}

/// 디자인의 `genSecret()` 과 동일 — 16바이트 난수를 hex 32자로.
pub fn gen_secret() -> String {
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
