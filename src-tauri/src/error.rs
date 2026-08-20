//! 프런트로 내려보내는 단일 에러 형태.
//!
//! 화면(토스트 / 인라인 배너)이 `kind` 만 보고 분기할 수 있도록 원인을 분류하고,
//! 사용자가 다음에 무엇을 해야 하는지를 `hint` 에 담는다.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// 401 / 403 — 관리 토큰 문제
    Unauthorized,
    /// TCP 연결 실패 · DNS 실패 · 타임아웃
    Connect,
    /// TLS 인증서 검증 실패
    Tls,
    /// 404
    NotFound,
    /// 400 등 게이트웨이가 요청을 거절
    BadRequest,
    /// 5xx 또는 예상 밖 응답
    Gateway,
    /// baseUrl / 토큰 미설정 같은 앱 설정 문제
    Config,
    /// 그 외
    Internal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), hint: None, status: None }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Config, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }

    /// HTTP 상태 코드 + 게이트웨이 응답 본문으로부터 사용자용 에러를 만든다.
    pub fn from_status(status: u16, body: &str) -> Self {
        // APISIX 는 실패 시 {"error_msg": "..."} 형태로 응답한다.
        let detail = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| {
                v.get("error_msg")
                    .or_else(|| v.get("message"))
                    .and_then(|m| m.as_str().map(str::to_owned))
            })
            .unwrap_or_else(|| {
                let t = body.trim();
                if t.is_empty() { String::new() } else { t.chars().take(300).collect() }
            });

        match status {
            401 | 403 => AppError::new(
                ErrorKind::Unauthorized,
                "관리 토큰이 올바르지 않습니다.",
            )
            .with_hint("설정 화면에서 X-API-KEY 를 다시 확인하세요.")
            .with_status(status),

            404 => AppError::new(ErrorKind::NotFound, "이미 삭제되었거나 존재하지 않는 항목입니다.")
                .with_hint("목록을 새로고침하세요.")
                .with_status(status),

            400 | 409 | 422 => {
                let msg = if detail.is_empty() {
                    format!("게이트웨이가 요청을 거절했습니다. (HTTP {status})")
                } else {
                    detail
                };
                AppError::new(ErrorKind::BadRequest, msg).with_status(status)
            }

            _ => {
                let msg = if detail.is_empty() {
                    format!("게이트웨이 오류입니다. (HTTP {status})")
                } else {
                    format!("게이트웨이 오류 (HTTP {status}): {detail}")
                };
                AppError::new(ErrorKind::Gateway, msg).with_status(status)
            }
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

/// reqwest 에러를 사용자용 문구로 분류한다.
///
/// TLS 실패는 `is_connect()` 로 잡히기도 하고 아니기도 해서, 원인 체인을 문자열로 훑어
/// 인증서 문제인지 먼저 판별한다. 이 앱에서 가장 흔한 실패 두 가지(사설 인증서, 방화벽)를
/// 구분해 주는 것이 사용자에게 실질적인 도움이 된다.
impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        let mut chain = String::new();
        let mut src: Option<&(dyn std::error::Error + 'static)> = Some(&e);
        while let Some(s) = src {
            chain.push_str(&s.to_string());
            chain.push(' ');
            src = s.source();
        }
        let low = chain.to_lowercase();

        let looks_tls = low.contains("certificate")
            || low.contains("cert ")
            || low.contains("tls")
            || low.contains("unknownissuer")
            || low.contains("invalidcertificate")
            || low.contains("self-signed")
            || low.contains("self signed");

        if looks_tls {
            return AppError::new(ErrorKind::Tls, "TLS 인증서 검증에 실패했습니다.").with_hint(
                "사설/자체서명 인증서라면 설정에서 '인증서 검증 건너뛰기'를 켜거나, 사내 CA 를 Windows 인증서 저장소에 설치하세요.",
            );
        }

        if e.is_timeout() {
            return AppError::new(ErrorKind::Connect, "게이트웨이 응답이 시간 내에 오지 않았습니다.")
                .with_hint("baseUrl · 포트 · 방화벽을 확인하세요.");
        }

        if e.is_connect() || e.is_request() {
            return AppError::new(ErrorKind::Connect, "게이트웨이에 연결할 수 없습니다.")
                .with_hint("baseUrl · 포트 · 방화벽을 확인하세요. (이 앱은 시스템 프록시를 우회해 직접 호출합니다)");
        }

        if e.is_decode() {
            return AppError::new(ErrorKind::Gateway, "게이트웨이 응답을 해석하지 못했습니다.")
                .with_hint("Admin API 주소가 맞는지 확인하세요.");
        }

        AppError::new(ErrorKind::Internal, format!("HTTP 요청 실패: {e}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::new(ErrorKind::Internal, format!("JSON 처리 실패: {e}"))
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => {
                AppError::new(ErrorKind::Config, "저장된 관리 토큰이 없습니다.")
            }
            other => AppError::new(
                ErrorKind::Internal,
                format!("Windows 자격 증명 관리자 접근 실패: {other}"),
            ),
        }
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::new(ErrorKind::Internal, format!("앱 오류: {e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::new(ErrorKind::Internal, format!("파일 입출력 실패: {e}"))
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;
