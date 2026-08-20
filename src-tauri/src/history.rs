//! 대시보드 "최근 관리 API 호출" 목록의 실데이터 원천.
//!
//! APISIX Admin API 는 감사 로그를 제공하지 않으므로, **이 앱이 수행한 호출**을
//! 환경별 링버퍼(최근 50건)에 기록해 보여준다. 앱을 껐다 켜도 유지되도록
//! 앱 데이터 폴더의 `history.json` 에 write-through 한다.

use std::sync::Mutex;

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Wry};

use crate::config::Env;

const CAP: usize = 50;
const FILE: &str = "history.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    /// unix seconds
    pub ts: i64,
    pub env: String,
    /// GET / PUT / POST / DELETE / PATCH
    pub verb: String,
    /// 리소스 표기 — 예: "routes/order-list-v1"
    pub target: String,
    /// 사람이 읽는 설명 — 예: "allowed_groups 2건 저장"
    pub note: String,
    /// 표시용 전체 경로 — 예: "PUT /apisix/admin/routes/1"
    pub path: String,
    pub ok: bool,
}

#[derive(Default)]
pub struct History {
    entries: Mutex<Vec<Entry>>,
}

fn file_path(app: &AppHandle<Wry>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join(FILE))
}

pub fn init(app: &AppHandle<Wry>) {
    let Some(p) = file_path(app) else { return };
    let Ok(txt) = std::fs::read_to_string(&p) else { return };
    let Ok(loaded) = serde_json::from_str::<Vec<Entry>>(&txt) else { return };
    if let Some(state) = app.try_state::<History>() {
        if let Ok(mut v) = state.entries.lock() {
            *v = loaded;
        }
    }
}

fn persist(app: &AppHandle<Wry>, entries: &[Entry]) {
    let Some(p) = file_path(app) else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(txt) = serde_json::to_string(entries) {
        let _ = std::fs::write(&p, txt);
    }
}

fn push(app: &AppHandle<Wry>, e: Entry) {
    let Some(state) = app.try_state::<History>() else { return };

    let snapshot = {
        let Ok(mut v) = state.entries.lock() else { return };

        // 목록 조회(GET)는 화면을 열 때마다 발생한다. 그대로 쌓으면 활동 목록이 같은 GET 으로
        // 가득 차 정작 중요한 저장·삭제가 밀려난다. 같은 대상의 직전 GET 은 갱신만 한다.
        let dedup_idx = if e.verb == "GET" && e.ok {
            v.iter().position(|x| x.env == e.env && x.verb == "GET" && x.target == e.target && x.ok)
        } else {
            None
        };

        match dedup_idx {
            Some(i) => {
                v[i].ts = e.ts;
                v[i].note = e.note;
                v[i].path = e.path;
            }
            None => v.insert(0, e),
        }

        // 환경별로 각각 CAP 을 유지한다 (한쪽 환경을 많이 써도 다른 쪽이 밀려나지 않게).
        let mut kept: Vec<Entry> = Vec::with_capacity(CAP * 2);
        for env in ["dev", "prod"] {
            kept.extend(v.iter().filter(|x| x.env == env).take(CAP).cloned());
        }
        kept.sort_by(|a, b| b.ts.cmp(&a.ts));
        *v = kept.clone();
        kept
    };

    persist(app, &snapshot);
}

pub fn record(
    app: &AppHandle<Wry>,
    env: Env,
    verb: &str,
    target: &str,
    note: impl Into<String>,
    admin_path: &str,
) {
    push(
        app,
        Entry {
            ts: Local::now().timestamp(),
            env: env.as_str().to_string(),
            verb: verb.to_string(),
            target: target.to_string(),
            note: note.into(),
            path: format!("{verb} {admin_path}"),
            ok: true,
        },
    );
}

/// client.rs 가 통신/HTTP 실패를 남길 때 쓴다. url 은 절대 URL 이므로 경로만 추린다.
pub fn record_failure(app: &AppHandle<Wry>, env: Env, verb: &str, url: &str, message: &str) {
    let path = url
        .find("/apisix/admin")
        .map(|i| url[i..].to_string())
        .unwrap_or_else(|| url.to_string());
    let target = path
        .trim_start_matches("/apisix/admin/")
        .split('?')
        .next()
        .unwrap_or("")
        .to_string();

    push(
        app,
        Entry {
            ts: Local::now().timestamp(),
            env: env.as_str().to_string(),
            verb: verb.to_string(),
            target,
            note: message.to_string(),
            path: format!("{verb} {path}"),
            ok: false,
        },
    );
}

// ── 뷰 모델 ──────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    /// 배지에 찍히는 짧은 동사 (DELETE → DEL)
    pub verb: String,
    /// 디자인의 배지 클래스: primary / success / neutral / error
    pub cls: String,
    pub target: String,
    pub note: String,
    pub path: String,
    pub when: String,
    pub ok: bool,
}

fn short_verb(verb: &str) -> String {
    match verb {
        "DELETE" => "DEL".to_string(),
        v => v.to_string(),
    }
}

/// 디자인의 verb 별 배지 색 규칙을 그대로 따른다.
fn verb_cls(verb: &str, ok: bool) -> &'static str {
    if !ok {
        return "error";
    }
    match verb {
        "PUT" | "PATCH" => "primary",
        "POST" => "success",
        "DELETE" => "error",
        _ => "neutral",
    }
}

fn relative(ts: i64) -> String {
    let now = Local::now().timestamp();
    let d = (now - ts).max(0);
    match d {
        0..=59 => "방금".to_string(),
        60..=3599 => format!("{}분 전", d / 60),
        3600..=86399 => format!("{}시간 전", d / 3600),
        86400..=172799 => "어제".to_string(),
        _ => {
            let days = d / 86400;
            if days <= 7 {
                format!("{days}일 전")
            } else {
                Local
                    .timestamp_opt(ts, 0)
                    .single()
                    .map(|t| t.format("%m-%d %H:%M").to_string())
                    .unwrap_or_else(|| format!("{days}일 전"))
            }
        }
    }
}

pub fn list(app: &AppHandle<Wry>, env: Env, limit: usize) -> Vec<EntryView> {
    let Some(state) = app.try_state::<History>() else { return Vec::new() };
    let Ok(v) = state.entries.lock() else { return Vec::new() };
    v.iter()
        .filter(|e| e.env == env.as_str())
        .take(limit)
        .map(|e| EntryView {
            verb: short_verb(&e.verb),
            cls: verb_cls(&e.verb, e.ok).to_string(),
            target: e.target.clone(),
            note: e.note.clone(),
            path: e.path.clone(),
            when: relative(e.ts),
            ok: e.ok,
        })
        .collect()
}
