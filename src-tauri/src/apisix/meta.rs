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

pub async fn overview(app: &AppHandle<Wry>, env: Env) -> AppResult<Overview> {
    // routes / consumers 는 실패하면 대시보드 자체가 의미 없으므로 에러를 그대로 올린다.
    let routes = super::routes::list(app, env).await?;
    let consumers = super::consumers::list(app, env).await?;

    // services / upstreams 는 없거나 권한이 달라도 대시보드는 떠야 하므로 실패를 흡수한다.
    let services = raw_list(app, env, "services").await.unwrap_or_default();
    let upstreams = raw_list(app, env, "upstreams").await.unwrap_or_default();

    let meta = client::last_meta(app, env);

    Ok(Overview {
        routes_active: routes.iter().filter(|r| r.status == 1).count(),
        routes_inactive: routes.iter().filter(|r| r.status != 1).count(),
        routes: routes.len(),
        consumers_jwt: consumers.iter().filter(|c| c.has_jwt_auth).count(),
        consumers: consumers.len(),
        services: services.len(),
        upstreams: upstreams.len(),
        version: meta.as_ref().and_then(|m| m.server_version.clone()),
        latency_ms: meta.as_ref().map(|m| m.elapsed_ms),
    })
}
