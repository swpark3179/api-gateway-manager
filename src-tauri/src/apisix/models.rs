//! APISIX Admin API 응답 → 화면용 DTO 변환.
//!
//! 목록/단건 응답은 v3 포맷(`{total, list:[{key,value}]}`)을 기준으로 하되,
//! `admin_api_version: v2` 로 운영되는 게이트웨이(`{node:{nodes:[...]}}`)도 함께 흡수한다.

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 목록 응답에서 각 항목의 `value` 객체만 뽑아낸다. (v3 · v2 모두 처리)
pub fn extract_list(resp: &Value) -> Vec<Value> {
    // v3: { "total": n, "list": [ { "key":…, "value": {…} } ] }
    if let Some(list) = resp.get("list").and_then(Value::as_array) {
        return list.iter().filter_map(unwrap_item).collect();
    }
    // v2: { "node": { "nodes": [ { "key":…, "value": {…} } ] } }
    if let Some(nodes) = resp.pointer("/node/nodes").and_then(Value::as_array) {
        return nodes.iter().filter_map(unwrap_item).collect();
    }
    // v2 에서 항목이 하나뿐이면 nodes 가 객체로 오기도 한다.
    if let Some(node) = resp.get("node") {
        if let Some(v) = unwrap_item(node) {
            return vec![v];
        }
    }
    Vec::new()
}

/// 단건 응답에서 `value` 객체를 뽑아낸다.
pub fn extract_one(resp: &Value) -> Option<Value> {
    unwrap_item(resp).or_else(|| resp.get("node").and_then(unwrap_item))
}

fn unwrap_item(item: &Value) -> Option<Value> {
    if let Some(v) = item.get("value") {
        let mut v = v.clone();
        // 일부 버전은 value 안에 id 를 넣지 않고 key(`/apisix/routes/42`)에만 담는다.
        // id 가 없으면 목록에서 항목을 고르거나 PUT/DELETE 경로를 만들 수 없으므로 보충한다.
        if v.get("id").is_none() {
            if let Some(id) = item.get("key").and_then(Value::as_str).and_then(id_from_key) {
                if let Some(m) = v.as_object_mut() {
                    m.insert("id".into(), Value::String(id));
                }
            }
        }
        return Some(v);
    }
    // 일부 배포본은 value 래핑 없이 바로 객체를 준다.
    if item.get("id").is_some() || item.get("username").is_some() {
        return Some(item.clone());
    }
    None
}

/// `/apisix/routes/42` → `42`
fn id_from_key(key: &str) -> Option<String> {
    let last = key.trim_end_matches('/').rsplit('/').next()?;
    if last.is_empty() { None } else { Some(last.to_string()) }
}

// ── 공통 헬퍼 ────────────────────────────────────────────────

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn str_array(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

/// APISIX 의 id 는 문자열 또는 정수로 온다.
fn id_of(v: &Value) -> String {
    match v.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn unix(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(Value::as_i64)
}

/// 디자인의 수정일시 표기 형식 — `2026-08-19 14:22`
pub fn fmt_ts(ts: Option<i64>) -> String {
    match ts {
        Some(t) => Local
            .timestamp_opt(t, 0)
            .single()
            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_else(|| "—".into()),
        None => "—".into(),
    }
}

/// `uri` 또는 `uris` 를 화면용 단일 문자열로 만든다.
/// 여러 개면 ", " 로 잇고, 저장할 때 다시 배열로 되돌린다. (routes.rs 의 apply_route_form 참조)
fn uri_of(v: &Value) -> String {
    if let Some(u) = v.get("uri").and_then(Value::as_str) {
        return u.to_string();
    }
    let uris = str_array(v.get("uris"));
    uris.join(", ")
}

// ── auth-groups 탐색 (Route · Consumer 공용) ─────────────────

/// auth-groups 를 찾을 때 시도하는 키 이름들.
///
/// 이 앱이 쓰는 표기는 `auth-groups` 지만, 다른 도구나 손으로 등록한 consumer 는
/// 표기가 다를 수 있다. 게이트웨이에는 값이 있는데 화면이 공란으로 보이는 사고를
/// 막기 위해 흔한 변형을 모두 훑는다.
const GROUP_KEYS: &[&str] = &[
    "auth-groups",
    "auth_groups",
    "authGroups",
    "allowed_groups",
    "allowed-groups",
    "groups",
];

/// auth-groups 가 실제로 저장돼 있던 위치.
///
/// **읽은 자리에 그대로 되쓰기 위해** 기록한다. 비표준 위치에서 읽어 놓고 저장은
/// 표준 위치에 하면 키가 둘로 갈라져 게이트웨이 인증이 깨진다.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GroupsLocation {
    /// plugins 아래 플러그인 이름. 빈 문자열이면 최상위 필드.
    pub plugin: String,
    pub key: String,
    /// 원본이 배열이 아니라 "a,b" 형태의 문자열이었는지.
    /// 게이트웨이 스키마가 기대하는 타입이 갈리므로 읽은 형태 그대로 되쓴다.
    #[serde(default)]
    pub as_csv: bool,
}

impl Default for GroupsLocation {
    fn default() -> Self {
        Self { plugin: "jwt-auth".into(), key: "auth-groups".into(), as_csv: false }
    }
}

/// 문자열 배열 · 콤마(공백/세미콜론) 구분 문자열 · 숫자 배열을 모두 문자열 목록으로 받아들인다.
/// 배열도 문자열도 아니면 None — "이 자리에는 그룹이 없다"는 뜻이다.
fn to_string_list(v: &Value) -> Option<Vec<String>> {
    match v {
        Value::Array(a) => Some(
            a.iter()
                .filter_map(|x| match x {
                    Value::String(s) => Some(s.trim().to_string()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                })
                .filter(|s| !s.is_empty())
                .collect(),
        ),
        Value::String(s) => Some(
            s.split([',', ';', ' '])
                .map(str::trim)
                .filter(|x| !x.is_empty())
                .map(str::to_owned)
                .collect(),
        ),
        _ => None,
    }
}

/// consumer 객체에서 auth-groups 를 찾아 (값, 위치) 로 돌려준다.
///
/// 탐색 순서: `preferred` 플러그인 → 나머지 플러그인 → 최상위. 각 단계에서 `GROUP_KEYS` 를 훑는다.
/// **값이 있는 자리를 우선**하고, 어디에도 값이 없으면 키가 존재하는 첫 자리를,
/// 그것도 없으면 기본 위치를 쓴다.
fn find_groups(v: &Value, preferred: &str, default_key: &str) -> (Vec<String>, GroupsLocation) {
    let mut empty_hit: Option<GroupsLocation> = None;

    let mut probe = |container: &Value, plugin: &str| -> Option<(Vec<String>, GroupsLocation)> {
        let obj = container.as_object()?;
        for k in GROUP_KEYS {
            let Some(raw) = obj.get(*k) else { continue };
            let Some(list) = to_string_list(raw) else { continue };
            let loc = GroupsLocation {
                plugin: plugin.to_string(),
                key: (*k).to_string(),
                as_csv: raw.is_string(),
            };
            if !list.is_empty() {
                return Some((list, loc));
            }
            if empty_hit.is_none() {
                empty_hit = Some(loc);
            }
        }
        None
    };

    if let Some(plugins) = v.get("plugins") {
        // 1) 이 리소스가 원래 쓰는 플러그인 우선
        if let Some(pref) = plugins.get(preferred) {
            if let Some(found) = probe(pref, preferred) {
                return found;
            }
        }
        // 2) 나머지 플러그인
        if let Some(map) = plugins.as_object() {
            for (name, pv) in map {
                if name == preferred {
                    continue;
                }
                if let Some(found) = probe(pv, name) {
                    return found;
                }
            }
        }
    }

    // 3) 최상위 필드
    if let Some(found) = probe(v, "") {
        return found;
    }

    let fallback = GroupsLocation {
        plugin: preferred.to_string(),
        key: default_key.to_string(),
        as_csv: false,
    };
    (Vec::new(), empty_hit.unwrap_or(fallback))
}


/// 그룹 목록을 `loc` 가 가리키는 자리에 써 넣는다. 다른 필드·플러그인은 건드리지 않는다.
///
/// 읽은 자리와 형태(배열/CSV)를 그대로 유지하는 것이 핵심이다. 표준 위치로 "정규화"하면
/// 기존 키가 남아 둘로 갈라지고, 타입을 바꾸면 게이트웨이 스키마 검증에 걸린다.
pub fn set_groups_at(m: &mut Map<String, Value>, loc: &GroupsLocation, groups: &[String]) {
    let value = if loc.as_csv {
        Value::String(groups.join(","))
    } else {
        Value::Array(groups.iter().map(|g| Value::String(g.clone())).collect())
    };

    if loc.plugin.is_empty() {
        m.insert(loc.key.clone(), value);
        return;
    }

    let mut plugins = match m.remove("plugins") {
        Some(Value::Object(o)) => o,
        _ => Map::new(),
    };
    let mut plugin = match plugins.remove(&loc.plugin) {
        Some(Value::Object(o)) => o,
        _ => Map::new(),
    };
    plugin.insert(loc.key.clone(), value);
    plugins.insert(loc.plugin.clone(), Value::Object(plugin));
    m.insert("plugins".into(), Value::Object(plugins));
}

// ── Route ────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteView {
    pub id: String,
    pub name: String,
    pub uri: String,
    pub desc: String,
    pub methods: Vec<String>,
    pub status: i64,
    pub service_id: String,
    /// plugins."proxy-rewrite".uri
    pub rewrite: String,
    /// 게이트웨이에서 찾아낸 allowed_groups
    pub groups: Vec<String>,
    /// 그 값이 저장돼 있던 위치 — 저장 시 같은 자리에 되쓴다
    pub groups_location: GroupsLocation,
    pub update_time: Option<i64>,
    pub updated: String,
    /// 게이트웨이 원본 객체 — JSON 탭의 '게이트웨이 원본' 보기에 그대로 쓴다
    pub raw: Value,
}

impl RouteView {
    pub fn from_value(v: &Value) -> Self {
        let plugins = v.get("plugins");
        let rewrite = plugins
            .and_then(|p| p.pointer("/proxy-rewrite/uri"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        // consumer 와 같은 이유로 관대하게 찾는다 — 다른 도구가 등록한 라우트도 그룹이 보여야 한다.
        let (groups, groups_location) = find_groups(v, "shi-auth", "allowed_groups");

        let service_id = match v.get("service_id") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        };

        let ts = unix(v, "update_time").or_else(|| unix(v, "create_time"));

        Self {
            id: id_of(v),
            name: s(v, "name"),
            uri: uri_of(v),
            desc: s(v, "desc"),
            methods: str_array(v.get("methods")),
            status: v.get("status").and_then(Value::as_i64).unwrap_or(1),
            service_id,
            rewrite,
            groups,
            groups_location,
            update_time: ts,
            updated: fmt_ts(ts),
            raw: v.clone(),
        }
    }
}

// ── Consumer ─────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerView {
    /// APISIX 에서 consumer 의 식별자는 username 이다.
    pub username: String,
    pub desc: String,
    /// plugins."jwt-auth".key
    pub key: String,
    /// plugins."jwt-auth".secret
    ///
    /// APISIX 3.x 는 jwt-auth.secret 을 암호화 필드로 취급한다. Admin API 가
    /// 복호화해 돌려주는 것이 정상이지만, 게이트웨이 설정에 따라 비어 올 수 있다.
    /// 그 경우 JWT 서명이 불가능하므로 `has_secret` 로 화면에서 분기한다.
    pub secret: String,
    pub has_secret: bool,
    /// 게이트웨이에서 찾아낸 auth-groups
    pub groups: Vec<String>,
    /// 그 값이 저장돼 있던 위치 — 저장 시 같은 자리에 되쓴다
    pub groups_location: GroupsLocation,
    /// jwt-auth 플러그인이 붙어 있는지 (KPI 계산용)
    pub has_jwt_auth: bool,
    pub update_time: Option<i64>,
    pub updated: String,
    /// 게이트웨이 원본 객체 — JSON 탭의 '게이트웨이 원본' 보기에 그대로 쓴다
    pub raw: Value,
}

impl ConsumerView {
    pub fn from_value(v: &Value) -> Self {
        let jwt = v.get("plugins").and_then(|p| p.get("jwt-auth"));
        let secret = jwt
            .and_then(|j| j.get("secret"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let ts = unix(v, "update_time").or_else(|| unix(v, "create_time"));
        let (groups, groups_location) = find_groups(v, "jwt-auth", "auth-groups");

        Self {
            username: s(v, "username"),
            desc: s(v, "desc"),
            key: jwt.and_then(|j| j.get("key")).and_then(Value::as_str).unwrap_or("").to_string(),
            has_secret: !secret.is_empty(),
            secret,
            groups,
            groups_location,
            has_jwt_auth: jwt.is_some(),
            update_time: ts,
            updated: fmt_ts(ts),
            raw: v.clone(),
        }
    }
}

// ── Service / Upstream (읽기 전용) ───────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceOption {
    pub id: String,
    /// 디자인의 select 라벨 형식: `svc-order-core · order-api (10.20.3.11:8080)`
    pub label: String,
    pub name: String,
}

impl ServiceOption {
    /// `upstreams` 는 service 가 upstream_id 로만 참조할 때 노드를 찾기 위해 넘긴다.
    pub fn from_value(v: &Value, upstreams: &[Value]) -> Self {
        let id = id_of(v);
        let name = s(v, "name");

        let inline_nodes = v.get("upstream").and_then(first_node);
        let node = inline_nodes.or_else(|| {
            let uid = match v.get("upstream_id") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                _ => return None,
            };
            upstreams.iter().find(|u| id_of(u) == uid).and_then(first_node)
        });

        // 디자인 라벨을 최대한 재현하되, 빠진 조각은 자연스럽게 생략한다.
        let mut label = if id.is_empty() { name.clone() } else { id.clone() };
        if !name.is_empty() && name != id {
            label = format!("{label} · {name}");
        }
        if let Some(n) = node {
            label = format!("{label} ({n})");
        }

        Self { id, label, name }
    }
}

/// upstream 객체에서 대표 노드 하나를 `host:port` 문자열로 뽑는다.
/// APISIX 의 nodes 는 `{"10.0.0.1:8080": 1}` 맵 형태와 `[{host,port,weight}]` 배열 형태가 모두 가능하다.
fn first_node(upstream: &Value) -> Option<String> {
    let nodes = upstream.get("nodes")?;
    if let Some(map) = nodes.as_object() {
        return map.keys().next().cloned();
    }
    if let Some(arr) = nodes.as_array() {
        let n = arr.first()?;
        let host = n.get("host").and_then(Value::as_str)?;
        return match n.get("port").and_then(Value::as_i64) {
            Some(p) => Some(format!("{host}:{p}")),
            None => Some(host.to_string()),
        };
    }
    None
}
