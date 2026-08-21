//! APISIX Admin API 연동.
//!
//! 모든 HTTP 는 `client` 를 통해서만 나간다. 다른 모듈에서 reqwest 클라이언트를
//! 직접 만들면 시스템 프록시를 타게 되므로 금지한다.

pub mod client;
pub mod consumers;
pub mod meta;
pub mod models;
pub mod routes;
pub mod services;
pub mod upstreams;
