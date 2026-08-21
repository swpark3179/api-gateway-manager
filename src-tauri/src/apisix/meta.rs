//! Service · Upstream 조회(읽기 전용)와 대시보드 집계.
//!
//! Route 폼의 `service_id` 셀렉트와 대시보드 KPI 를 채우기 위해서만 쓴다.
//! 이 앱은 Service/Upstream 을 생성·수정하지 않는다.

use reqwest::Method;
use serde::Serialize;
use tauri::{AppHandle, Wry};

use super::client;
use super::models::{extract_list, ServiceOption};
use crate::config::Env;
use crate::db::OverviewCounts;
use crate::error::AppResult;

async fn raw_list(app: &AppHandle<Wry>, env: Env, resource: &str) -> AppResult<Vec<serde_json::Value>> {
    let (resp, _) = client::request(app, env, Method::GET, resource, None).await?;
    Ok(extract_list(&resp))
}

pub async fn services(app: &AppHandle<Wry>, env: Env) -> AppResult<Vec<ServiceOption>> {
    let ups = raw_list(app, env, "upstreams").await.unwrap_or_default();
    let svcs = raw_list(app, env, "services").await?;
    Ok(svcs.iter().map(|s| ServiceOption::from_value(s, &ups)).collect())
}

/// 대시보드 상단 KPI + 연결 상태 카드에 필요한 실측값 일체.
///
/// 디자인의 `etcd 3 nodes · healthy` 는 Admin API 로 알 수 없으므로 제외하고,
/// Service / Upstream 실측 건수로 대체한다. 버전은 응답의 `Server` 헤더에서,
/// 응답 시간은 실제 왕복 시간에서 얻는다.
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub routes: usize,
    pub routes_active: usize,
    pub routes_inactive: usize,
    pub consumers: usize,
    pub consumers_jwt: usize,
    pub services: usize,
    pub upstreams: usize,
    /// `Server: APISIX/3.9.1` 에서 파싱
    pub version: Option<String>,
    /// 마지막 Admin API 왕복 시간(ms)
    pub latency_ms: Option<u64>,
}

/// `counts` 는 **캐시에서** 센 route·consumer 건수다 (`db::overview_counts`).
///
/// 예전에는 여기서 두 목록을 다시 GET 했는데, 기동 시 부트스트랩이 이미 같은 목록을 받아
/// 캐시에 넣으므로 앱을 켤 때마다 전체 조회가 네 번 나가고 50건짜리 호출 이력이 목록 조회로
/// 도배됐다. 라이브로 재야 의미가 있는 값(version · latency)과 캐시에 없는 값
/// (services · upstreams)만 호출로 남긴다. 부트스트랩이 항상 먼저 돌므로 두 호출이 다 막힌
/// 게이트웨이에서도 `last_meta` 는 비어 있지 않다.
pub async fn overview(
    app: &AppHandle<Wry>,
    env: Env,
    counts: OverviewCounts,
) -> AppResult<Overview> {
    // services / upstreams 는 없거나 권한이 달라도 대시보드는 떠야 하므로 실패를 흡수한다.
    let services = raw_list(app, env, "services").await.unwrap_or_default();
    let upstreams = raw_list(app, env, "upstreams").await.unwrap_or_default();

    let meta = client::last_meta(app, env);

    Ok(Overview {
        routes: counts.routes as usize,
        routes_active: counts.routes_active as usize,
        routes_inactive: counts.routes_inactive as usize,
        consumers: counts.consumers as usize,
        consumers_jwt: counts.consumers_jwt as usize,
        services: services.len(),
        upstreams: upstreams.len(),
        version: meta.as_ref().and_then(|m| m.server_version.clone()),
        latency_ms: meta.as_ref().map(|m| m.elapsed_ms),
    })
}
