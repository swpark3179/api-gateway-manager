//! APISIX Admin API 응답 → 화면용 DTO 변환.
//!
//! 목록/단건 응답은 v3 포맷(`{total, list:[{key,value}]}`)을 기준으로 하되,
//! `admin_api_version: v2` 로 운영되는 게이트웨이(`{node:{nodes:[...]}}`)도 함께 흡수한다.

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

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

/// Route 의 권한 검사 플러그인.
///
/// 그룹 필드의 기본 위치이면서, 폼의 **전체 허용** 모드에서 지우는 대상이다 — 게이트웨이가
/// 요청을 막는 것은 `allowed_groups` 의 내용이 아니라 이 플러그인이 붙어 있다는 사실이다.
pub const ROUTE_AUTH_PLUGIN: &str = "shi-auth";
/// 그 플러그인 안의 기본 키.
pub const ROUTE_GROUPS_KEY: &str = "allowed_groups";

impl GroupsLocation {
    /// Route 의 기본 위치. `Default` 는 Consumer 쪽(`jwt-auth.auth-groups`)이라 따로 둔다.
    pub fn route_default() -> Self {
        Self { plugin: ROUTE_AUTH_PLUGIN.into(), key: ROUTE_GROUPS_KEY.into(), as_csv: false }
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

/// `loc` 가 가리키는 자리가 게이트웨이 원본에 **실제로 있는가**.
///
/// `find_groups` 는 아무것도 못 찾아도 기본 위치를 돌려주므로, 값과 위치만으로는
/// "그룹이 빈 배열이다"(= 아무 컨슈머도 못 들어온다)와 "권한 플러그인이 아예 없다"
/// (= 누구나 들어온다)를 구별할 수 없다. Route 폼의 전체 허용 모드가 그 구별에 기댄다.
///
/// 키가 없어도 **플러그인이 붙어 있으면 있다고 본다.** 게이트웨이가 요청을 막는 것은
/// 플러그인의 존재이고, `allowed_groups` 가 없는 `shi-auth` 도 여전히 검사를 한다 —
/// 그것을 "전체 허용"으로 읽으면 저장 한 번으로 권한이 조용히 풀린다.
pub fn groups_slot_present(v: &Value, loc: &GroupsLocation) -> bool {
    if loc.plugin.is_empty() {
        return v.get(&loc.key).is_some();
    }
    v.get("plugins").and_then(|p| p.get(&loc.plugin)).is_some()
}

// ── 담당자 (labels · name{n} / dept{n}) ──────────────────────

/// 게이트웨이의 `labels` 에 `name1`/`dept1`, `name2`/`dept2`, … 형태로 들어 있는
/// 관련 담당자 정보. `n` 은 상한이 없고, `dept{n}` 없이 `name{n}` 만 있는 경우도 있다.
///
/// # APISIX labels 제약 (apisix/schema_def.lua 의 label_value_def)
///
/// 값 패턴이 `^\S+$` 라 **공백이 하나라도 들어가면 게이트웨이가 400 을 낸다.**
/// 한글 자체는 문제없다 — `\S` 가 바이트 단위라 한글 바이트는 전부 non-space 다.
/// `minLength = 1` 이므로 빈 값은 `""` 로 쓰지 말고 키를 통째로 생략해야 하고,
/// `maxLength = 256` 은 **바이트** 기준이다 (Lua 의 `#str`).
/// 개수 상한(`maxProperties`)은 없다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub dept: String,
}

impl Contact {
    fn is_empty(&self) -> bool {
        self.name.trim().is_empty() && self.dept.trim().is_empty()
    }
}

/// `name12` → `Some(12)`. 우리가 관리하는 키인지 판정한다.
///
/// `rest == n.to_string()` 비교가 앞자리 0 을 걸러 낸다. `name01` 을 우리 키로 보면
/// 재번호 과정에서 `name1` 과 충돌해 한쪽이 조용히 사라지므로, **증명할 수 있는 키만**
/// 우리 것으로 취급하고 나머지(`name01` · `name0` · `nameX` · 맨 `name`)는
/// 다른 라벨처럼 그대로 보존한다.
fn label_index(key: &str, prefix: &str) -> Option<usize> {
    let rest = key.strip_prefix(prefix)?;
    let n: usize = rest.parse().ok()?;
    (n >= 1 && rest == n.to_string()).then_some(n)
}

/// consumer 객체의 `labels` 에서 담당자 목록을 뽑는다.
///
/// `BTreeMap<usize, _>` 에 모아 **숫자 순**으로 정렬한다. serde_json 이 `preserve_order`
/// 없이 빌드돼 `Map` 이 BTreeMap 이라, 키 문자열을 그대로 순회하면 `name1, name10, name2`
/// 순이 되어 10번째 담당자가 2번째 앞에 온다.
pub fn contacts_of(v: &Value) -> Vec<Contact> {
    let Some(labels) = v.get("labels").and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut acc: std::collections::BTreeMap<usize, Contact> = std::collections::BTreeMap::new();
    for (k, val) in labels {
        let Some(s) = val.as_str() else { continue };
        let s = s.trim();
        if s.is_empty() {
            continue;
        }
        if let Some(n) = label_index(k, "name") {
            acc.entry(n).or_default().name = s.to_string();
        } else if let Some(n) = label_index(k, "dept") {
            acc.entry(n).or_default().dept = s.to_string();
        }
    }

    acc.into_values().filter(|c| !c.is_empty()).collect()
}

/// 담당자 목록을 `labels` 에 되쓴다.
///
/// 인식된 `name{n}`/`dept{n}` 키만 지우고 1..N 으로 **조밀하게 재번호**한다.
/// (중간 행을 지우면 뒤가 당겨진다 — 구멍을 남기면 이 규약을 읽는 다른 시스템이 곤란해진다.)
/// 그 외의 라벨은 손대지 않는다. `set_groups_at` 이 다른 플러그인을 보존하는 것과 같은 규칙이다.
///
/// # 프런트에 표시 전용 사본이 있다
///
/// JSON 탭이 담당자를 같이 보여 주기 위해 `src/lib/design.ts` 의 `contactLabels` ·
/// `contactsFromLabels` 가 이 함수와 `contacts_of` 를 흉내낸다. **저장에 쓰이는 것은 여기고**
/// 그쪽은 미리보기지만, 규칙을 고치면 화면이 저장 결과와 다른 말을 하게 되므로 함께 고쳐야
/// 한다. 특히 "빈 행을 걸러낸 뒤 번호를 붙인다" 와 앞자리 0 판정이 어긋나기 쉽다.
pub fn set_contacts_at(m: &mut Map<String, Value>, contacts: &[Contact]) {
    let mut labels = match m.remove("labels") {
        Some(Value::Object(o)) => o,
        _ => Map::new(),
    };

    labels.retain(|k, _| label_index(k, "name").is_none() && label_index(k, "dept").is_none());

    let mut n = 0usize;
    for c in contacts.iter().filter(|c| !c.is_empty()) {
        n += 1;
        // minLength = 1 이라 빈 값은 `""` 가 아니라 키 자체를 생략해야 한다.
        let name = c.name.trim();
        if !name.is_empty() {
            labels.insert(format!("name{n}"), Value::String(name.to_string()));
        }
        let dept = c.dept.trim();
        if !dept.is_empty() {
            labels.insert(format!("dept{n}"), Value::String(dept.to_string()));
        }
    }

    // 빈 객체를 남기지 않는다 (apply_route_form 이 빈 plugins 를 넣지 않는 것과 같은 이유).
    if labels.is_empty() {
        m.remove("labels");
    } else {
        m.insert("labels".into(), Value::Object(labels));
    }
}

/// APISIX labels 값 제약을 저장 전에 검사한다.
///
/// 게이트웨이가 주는 400 은 어느 값이 왜 틀렸는지 알려 주지 않는다. `username` · `key` ·
/// `secret` 을 미리 검사하는 것과 같은 이유로 여기서 막고 고칠 방법을 알려 준다.
pub fn check_label_value(field: &str, v: &str) -> AppResult<()> {
    if v.chars().any(char::is_whitespace) {
        return Err(AppError::config(format!(
            "담당자 {field} 에는 공백을 넣을 수 없습니다. 게이트웨이 labels 제약(^\\S+$) 때문입니다 — \
             '플랫폼 개발팀' 대신 '플랫폼개발팀' 처럼 붙여 쓰세요."
        )));
    }
    // APISIX 의 Lua JSON-schema 는 길이를 바이트로 센다 (한글 약 85자).
    if v.len() > MAX_LABEL_BYTES {
        return Err(AppError::config(format!(
            "담당자 {field} 는 {MAX_LABEL_BYTES}바이트를 넘을 수 없습니다. (현재 {}바이트)",
            v.len()
        )));
    }
    Ok(())
}

// ── Route ────────────────────────────────────────────────────

/// `Deserialize` 는 SQLite 캐시(`db.rs`)가 `view` 열에 넣어 둔 JSON 을 되읽기 위한 것이다.
/// 목록/검색이 캐시를 거치므로 이 왕복이 무손실이어야 한다.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// plugins."proxy-rewrite".regex_uri — 게이트웨이에 있던 **배열 그대로**.
    ///
    /// 쌍이 셋 이상인 route 도 손실 없이 왕복해야 한다. 폼은 첫 쌍만 편집하고 나머지는
    /// 이 값을 통해 보존된다 (`routes::apply_route_form`).
    #[serde(default)]
    pub rewrite_regex: Vec<String>,
    /// 게이트웨이에서 찾아낸 allowed_groups
    pub groups: Vec<String>,
    /// 그 값이 저장돼 있던 위치 — 저장 시 같은 자리에 되쓴다
    pub groups_location: GroupsLocation,
    /// 권한 검사가 **붙어 있는가** (`groups_slot_present`).
    ///
    /// `groups` 가 비어 있는 것만으로는 "아무도 접근 못 하는 라우트"와 "권한 없이 누구나
    /// 접근하는 라우트"를 구별할 수 없다. 폼의 전체 허용 모드가 이 값에서 파생된다.
    ///
    /// 누락 시 기본값을 `true` 로 두는 이유: 이 필드를 모르는 본문(옛 캐시 행 등)을
    /// `false` 로 읽으면 화면이 멀쩡한 라우트를 "전체 허용"이라 말하고, 저장 한 번으로
    /// 실제 권한이 풀린다. 안전한 쪽으로 떨어져야 한다.
    #[serde(default = "yes")]
    pub has_auth: bool,
    pub update_time: Option<i64>,
    pub updated: String,
    /// 게이트웨이 원본 객체 — JSON 탭의 '게이트웨이 원본' 보기에 그대로 쓴다
    pub raw: Value,
}

/// `serde(default)` 용 — bool 의 기본값(`false`)이 위험한 자리에 쓴다.
fn yes() -> bool {
    true
}

impl RouteView {
    pub fn from_value(v: &Value) -> Self {
        let plugins = v.get("plugins");
        let rewrite = plugins
            .and_then(|p| p.pointer("/proxy-rewrite/uri"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let rewrite_regex = str_array(plugins.and_then(|p| p.pointer("/proxy-rewrite/regex_uri")));
        // consumer 와 같은 이유로 관대하게 찾는다 — 다른 도구가 등록한 라우트도 그룹이 보여야 한다.
        let (groups, groups_location) = find_groups(v, ROUTE_AUTH_PLUGIN, ROUTE_GROUPS_KEY);
        // 그룹이 비어 있어도 자리가 있으면 권한 검사는 살아 있다 (`groups_slot_present`).
        let has_auth = groups_slot_present(v, &groups_location);

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
            rewrite_regex,
            groups,
            groups_location,
            has_auth,
            update_time: ts,
            updated: fmt_ts(ts),
            raw: v.clone(),
        }
    }
}

// ── Consumer ─────────────────────────────────────────────────

/// `Deserialize` 는 `RouteView` 와 같은 이유다 — SQLite 캐시(`db.rs`)가 `view` 열에 넣어 둔
/// JSON 을 되읽는다. `from_str` 은 `from_value` 를 다시 돌리지 않고 직렬화된 필드를 그대로
/// 읽으므로 `has_secret` · `has_jwt_auth` 가 `raw` 와 어긋날 여지가 없다.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// labels 의 `name{n}`/`dept{n}` 쌍에서 읽은 관련 담당자 목록
    pub contacts: Vec<Contact>,
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
            contacts: contacts_of(v),
            update_time: ts,
            updated: fmt_ts(ts),
            raw: v.clone(),
        }
    }
}

// ── Service / Upstream ───────────────────────────────────────

/// upstream 노드 하나. APISIX 는 `{"host:port": weight}` 맵과
/// `[{host, port, weight}]` 배열 표기를 모두 받아들이므로 **읽기는 둘 다** 흡수하고
/// **쓰기는 배열 표기**로 고정한다 (맵 키에 host:port 를 조립해 넣으면 포트 없는
/// 노드나 IPv6 주소에서 표기가 애매해진다).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamNode {
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<i64>,
    /// 폼에 노출하지 않지만 읽은 값을 그대로 되쓴다. 노출하지 않는 값을 조용히 1 로
    /// 덮으면 게이트웨이에 설정된 가중치가 사라진다.
    #[serde(default)]
    pub weight: Option<i64>,
}

impl UpstreamNode {
    /// `10.20.3.11:8080` — 라벨/목록 표시용.
    pub fn label(&self) -> String {
        match self.port {
            Some(p) => format!("{}:{}", self.host, p),
            None => self.host.clone(),
        }
    }
}

/// upstream 의 timeout(초). 폼 기본값은 connect 10 · send 10 · read 60 이다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamTimeout {
    pub connect: f64,
    pub send: f64,
    pub read: f64,
}

impl Default for UpstreamTimeout {
    fn default() -> Self {
        Self { connect: 10.0, send: 10.0, read: 60.0 }
    }
}

pub const DEFAULT_UPSTREAM_TYPE: &str = "roundrobin";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamView {
    pub id: String,
    pub name: String,
    pub desc: String,
    /// 로드밸런싱 방식. 없으면 APISIX 기본값(`roundrobin`)으로 채운다.
    pub r#type: String,
    pub nodes: Vec<UpstreamNode>,
    pub timeout: UpstreamTimeout,
    /// `10.20.3.11:8080 외 2` — 목록/셀렉트 라벨용
    pub node_label: String,
    pub update_time: Option<i64>,
    pub updated: String,
    /// 게이트웨이 원본 객체
    pub raw: Value,
}

impl UpstreamView {
    pub fn from_value(v: &Value) -> Self {
        let nodes = all_nodes(v);
        let ts = unix(v, "update_time");
        let ty = {
            let t = s(v, "type");
            if t.is_empty() { DEFAULT_UPSTREAM_TYPE.to_string() } else { t }
        };

        Self {
            id: id_of(v),
            name: s(v, "name"),
            desc: s(v, "desc"),
            r#type: ty,
            node_label: nodes_label(&nodes),
            nodes,
            timeout: timeout_of(v),
            update_time: ts,
            updated: fmt_ts(ts),
            raw: v.clone(),
        }
    }
}

/// service 가 참조하는 스펙 문서의 주소를 담는 label 키.
///
/// APISIX 의 service 스키마는 `additionalProperties: false` 라 최상위에 임의 필드를
/// 넣을 수 없다. `labels` 는 값 제약(`^\S+$` · 256바이트)만 지키면 되고 URL 은 공백이
/// 없으므로 여기에 담는다. (제약 설명은 위 `Contact` 주석 참조)
pub const SPEC_URL_LABEL: &str = "spec_url";
/// service 가 정한 route 명 접두어를 담는 label 키.
///
/// Import 가 미등록 API 를 신규 등록 폼으로 넘길 때 `name` 앞에 붙는 값이다. 최상위에 임의
/// 필드를 넣을 수 없는 것은 `spec_url` 과 같은 사정이고, 접두어는 `EP_` · `EP/` 처럼 공백이
/// 없으므로 labels 제약을 자연히 통과한다. (조립 규칙은 `oas::suggested_name_for`)
pub const NAME_PREFIX_LABEL: &str = "name_prefix";
/// `labels` 값의 바이트 길이 상한 (apisix/schema_def.lua 의 label_value_def).
pub const MAX_LABEL_BYTES: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceView {
    pub id: String,
    pub name: String,
    pub desc: String,
    pub upstream_id: String,
    /// `labels.spec_url` — Import 화면이 파일 첨부 없이 비교할 때 읽는 주소
    pub spec_url: String,
    /// `labels.name_prefix` — Import 프리필의 route 명 접두어. 비어 있으면 경로 접두사에서
    /// 파생하는 기존 규칙으로 떨어진다 (`oas::suggested_name_for`)
    pub name_prefix: String,
    /// `plugins["shi-log"].key`
    pub log_key: String,
    /// `plugins["jwt-auth"]` 가 붙어 있는가
    pub has_jwt_auth: bool,
    /// 참조 upstream 의 대표 노드 (`10.20.3.11:8080`). 못 찾으면 빈 문자열
    pub upstream_label: String,
    /// `svc-order · order-api (10.20.3.11:8080)` — service_id 셀렉트 라벨.
    /// 포맷이 두 곳에 생기지 않도록 Rust 에서 한 번만 조립한다.
    pub option_label: String,
    pub update_time: Option<i64>,
    pub updated: String,
    pub raw: Value,
}

impl ServiceView {
    /// `upstreams` 는 service 가 `upstream_id` 로만 참조할 때 노드를 찾기 위해 넘긴다.
    pub fn from_value(v: &Value, upstreams: &[UpstreamView]) -> Self {
        let id = id_of(v);
        let name = s(v, "name");
        let upstream_id = match v.get("upstream_id") {
            Some(Value::String(x)) => x.clone(),
            Some(Value::Number(n)) => n.to_string(),
            _ => String::new(),
        };

        // 인라인 upstream 이 있으면 그쪽이 실제로 쓰이는 값이다.
        let upstream_label = v
            .get("upstream")
            .map(|u| nodes_label(&all_nodes(u)))
            .filter(|l| !l.is_empty())
            .or_else(|| {
                upstreams
                    .iter()
                    .find(|u| u.id == upstream_id)
                    .map(|u| u.node_label.clone())
                    .filter(|l| !l.is_empty())
            })
            .unwrap_or_default();

        // 빠진 조각은 자연스럽게 생략한다.
        let mut option_label = if id.is_empty() { name.clone() } else { id.clone() };
        if !name.is_empty() && name != id {
            option_label = format!("{option_label} · {name}");
        }
        if !upstream_label.is_empty() {
            option_label = format!("{option_label} ({upstream_label})");
        }

        let plugins = v.get("plugins");
        let ts = unix(v, "update_time");

        Self {
            id,
            name,
            desc: s(v, "desc"),
            upstream_id,
            spec_url: v
                .pointer("/labels/spec_url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
            name_prefix: v
                .pointer("/labels/name_prefix")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
            log_key: plugins
                .and_then(|p| p.pointer("/shi-log/key"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            has_jwt_auth: plugins.and_then(|p| p.get("jwt-auth")).is_some(),
            upstream_label,
            option_label,
            update_time: ts,
            updated: fmt_ts(ts),
            raw: v.clone(),
        }
    }
}

/// upstream 객체의 `nodes` 를 표기와 무관하게 목록으로 읽는다.
///
/// 맵 표기(`{"10.0.0.1:8080": 1}`)와 배열 표기(`[{host,port,weight}]`)가 모두 온다.
/// 맵 표기는 키가 `host:port` 인데 IPv6 는 `[::1]:8080` 이라 **마지막 콜론**에서만
/// 갈라야 하고, 포트가 없는 키(`example.com`)도 그대로 통과시켜야 한다.
pub fn all_nodes(upstream: &Value) -> Vec<UpstreamNode> {
    let Some(nodes) = upstream.get("nodes") else { return Vec::new() };

    if let Some(map) = nodes.as_object() {
        return map
            .iter()
            .map(|(key, w)| {
                let (host, port) = split_host_port(key);
                UpstreamNode { host, port, weight: w.as_i64() }
            })
            .collect();
    }

    if let Some(arr) = nodes.as_array() {
        return arr
            .iter()
            .filter_map(|n| {
                let host = n.get("host").and_then(Value::as_str)?;
                Some(UpstreamNode {
                    host: host.to_string(),
                    port: n.get("port").and_then(Value::as_i64),
                    weight: n.get("weight").and_then(Value::as_i64),
                })
            })
            .collect();
    }

    Vec::new()
}

fn split_host_port(key: &str) -> (String, Option<i64>) {
    match key.rsplit_once(':') {
        // `[::1]:8080` 은 갈라도 되지만 `::1` 은 포트가 아니다 — 뒤쪽이 숫자일 때만 나눈다.
        Some((h, p)) => match p.parse::<i64>() {
            Ok(n) if !h.is_empty() => (h.to_string(), Some(n)),
            _ => (key.to_string(), None),
        },
        None => (key.to_string(), None),
    }
}

fn nodes_label(nodes: &[UpstreamNode]) -> String {
    match nodes.split_first() {
        None => String::new(),
        Some((first, [])) => first.label(),
        Some((first, rest)) => format!("{} 외 {}", first.label(), rest.len()),
    }
}

fn timeout_of(v: &Value) -> UpstreamTimeout {
    let d = UpstreamTimeout::default();
    let Some(t) = v.get("timeout") else { return d };
    let num = |k: &str, fallback: f64| t.get(k).and_then(Value::as_f64).unwrap_or(fallback);
    UpstreamTimeout {
        connect: num("connect", d.connect),
        send: num("send", d.send),
        read: num("read", d.read),
    }
}

// ── 폼 → 요청 본문 공용 헬퍼 ─────────────────────────────────

/// 값이 비면 키를 지운다. APISIX 는 `""` 를 거부하는 필드가 있어 빈 문자열을 쓰면 안 된다.
pub fn set_or_remove(m: &mut Map<String, Value>, key: &str, val: &str) {
    if val.is_empty() {
        m.remove(key);
    } else {
        m.insert(key.into(), Value::String(val.to_string()));
    }
}

/// 서버가 관리하는 필드는 요청 본문에서 제외한다.
pub fn strip_server_fields(m: &mut Map<String, Value>) {
    m.remove("create_time");
    m.remove("update_time");
    m.remove("id");
}

/// `Value` 를 오브젝트 맵으로. 오브젝트가 아니면 빈 맵이다.
pub fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// `labels` 의 한 키만 설정/삭제하고 나머지 라벨은 보존한다.
///
/// 값이 비면 **키를 통째로 지운다** — `minLength = 1` 이라 `""` 는 게이트웨이가 거부한다.
/// labels 가 빈 객체가 되면 키 자체를 없앤다. (`set_contacts_at` 과 같은 규칙)
pub fn set_label(m: &mut Map<String, Value>, key: &str, val: &str) {
    let mut labels = obj(m.remove("labels").unwrap_or(Value::Null));
    if val.is_empty() {
        labels.remove(key);
    } else {
        labels.insert(key.into(), Value::String(val.to_string()));
    }
    if !labels.is_empty() {
        m.insert("labels".into(), Value::Object(labels));
    }
}

/// labels 값 제약 검사 — 공백 불가(`^\S+$`) · 1~256 **바이트**.
///
/// `check_label_value` 는 담당자 전용 안내 문구를 쓰므로 그 밖의 라벨은 이쪽을 쓴다.
pub fn check_label_constraints(field: &str, val: &str) -> AppResult<()> {
    if val.chars().any(char::is_whitespace) {
        return Err(AppError::config(format!(
            "{field} 에 공백을 쓸 수 없습니다 (게이트웨이 labels 제약)."
        )));
    }
    if val.len() > MAX_LABEL_BYTES {
        return Err(AppError::config(format!(
            "{field} 가 너무 깁니다 ({}바이트). {MAX_LABEL_BYTES}바이트 이내여야 합니다.",
            val.len()
        )));
    }
    Ok(())
}
