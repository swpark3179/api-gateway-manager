//! 내장 SQLite 캐시 — Route 목록 검색과 OAS Import 비교의 공용 인덱스.
//!
//! # 왜 SQLite 인가
//!
//! 예전에는 프런트가 라우트 배열을 통째로 들고 매 키 입력마다 `JSON.stringify(route)` 로
//! 전문 검색을 했다. 라우트가 수백 건이 되면 눈에 띄게 느려지고, 무엇보다 Import 기능이
//! 필요로 하는 "이 uri·method 가 등록돼 있나"를 배열 순회로 풀면 (스펙 오퍼레이션 수) ×
//! (라우트 수) 번 비교하게 된다. uri 를 정규화해 인덱스로 만들어 두면 두 문제가 같이 풀린다.
//!
//! # 무엇이 들어 있나
//!
//! Route · Consumer · Upstream · Service 의 **전체 목록**, 그리고 Route/Consumer 의 그룹을
//! 이어 주는 정션 테이블이다.
//! 목록 화면은 게이트웨이를 부르지 않고 여기만 본다. 채우는 경로는 두 가지다 —
//! 부트스트랩(기동 · 환경 전환 · 상단 새로고침 버튼)과, 저장·삭제 직후의 해당 리소스 재동기화.
//!
//! # 메모리 전용
//!
//! `Connection::open_in_memory()` 다. 디스크에 남기지 않으므로 앱을 다시 켜면 비어 있고,
//! 기동 시의 전체 조회가 첫 채우기다. 게이트웨이가 진실의 원천이고 이건 조회 가속용 사본이라,
//! 디스크에 stale 데이터가 남을 위험은 아예 만들지 않았다. 대신 사본이 얼마나 오래된
//! 것인지를 화면(마지막 갱신시각)에 드러내 사용자가 판단할 수 있게 한다.
//!
//! # 스레드 안전
//!
//! `rusqlite::Connection` 은 `Sync` 가 아니므로 `Mutex` 로 감싸 Tauri 관리 상태에 넣는다.
//! 이 파일의 함수들은 전부 `&Connection` 만 받는 순수 함수라 테스트에서 그대로 부를 수 있다.

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::apisix::models::{ConsumerView, RouteView, ServiceView, UpstreamView};
use crate::error::{AppError, AppResult};
use crate::oas::{self, OasOp};

/// Tauri 관리 상태로 등록되는 캐시 핸들.
pub struct Cache(pub Mutex<Connection>);

impl Cache {
    pub fn new() -> AppResult<Self> {
        let conn = Connection::open_in_memory().map_err(sql_err)?;
        init(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    /// 잠금을 잡아 클로저를 실행한다. 잠금이 독이 됐으면(다른 스레드 패닉) 에러로 바꾼다.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let guard = self
            .0
            .lock()
            .map_err(|_| AppError::internal("캐시 잠금이 손상되었습니다. 앱을 다시 시작하세요."))?;
        f(&guard)
    }
}

fn sql_err(e: rusqlite::Error) -> AppError {
    AppError::internal(format!("로컬 캐시 처리 실패: {e}"))
}

// ── 스키마 ───────────────────────────────────────────────────

pub fn init(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = MEMORY;

        -- 목록/검색용. RouteView 를 JSON 그대로 담아 열↔구조체 매핑 버그 여지를 없앤다.
        CREATE TABLE IF NOT EXISTS routes (
          env        TEXT    NOT NULL,
          id         TEXT    NOT NULL,
          seq        INTEGER NOT NULL,          -- 게이트웨이가 준 원래 순서 (표시 순서 유지)
          name       TEXT    NOT NULL DEFAULT '',
          uri        TEXT    NOT NULL DEFAULT '',
          service_id TEXT    NOT NULL DEFAULT '',
          status     INTEGER NOT NULL DEFAULT 1,
          search     TEXT    NOT NULL,          -- 소문자 통합 블롭 (기존 전문 검색과 동등)
          view       TEXT    NOT NULL,          -- serde_json::to_string(&RouteView)
          PRIMARY KEY (env, id)
        );
        CREATE INDEX IF NOT EXISTS routes_env_seq ON routes(env, seq);

        -- uri 매칭 인덱스. uris 배열은 행 하나씩 펼친다.
        CREATE TABLE IF NOT EXISTS route_uris (
          env      TEXT    NOT NULL,
          route_id TEXT    NOT NULL,
          norm     TEXT    NOT NULL,   -- 파라미터 세그먼트를 접은 경로 (oas::normalize)
          prefix   TEXT    NOT NULL,   -- 와일드카드면 '*' 앞부분, 아니면 norm 과 동일
          wildcard INTEGER NOT NULL    -- 끝이 '*' 인가 (APISIX 접두 매칭)
        );
        CREATE INDEX IF NOT EXISTS route_uris_norm ON route_uris(env, norm);
        CREATE INDEX IF NOT EXISTS route_uris_wild ON route_uris(env, wildcard);

        -- 행이 0건이면 "모든 메서드 허용" 이다 (APISIX 는 methods 키가 없으면 전체 허용).
        CREATE TABLE IF NOT EXISTS route_methods (
          env      TEXT NOT NULL,
          route_id TEXT NOT NULL,
          method   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS route_methods_lookup ON route_methods(env, route_id, method);

        -- route 의 allowed_groups. 한 행이 그룹 하나다.
        -- PK 는 (env, route_id) → grp 방향(컨슈머 접근 판정의 EXISTS)을,
        -- 보조 인덱스는 (env, grp) → route_id 방향(접근 건수 집계)을 탄다. 둘 다 필요하다.
        CREATE TABLE IF NOT EXISTS route_groups (
          env      TEXT NOT NULL,
          route_id TEXT NOT NULL,
          grp      TEXT NOT NULL,
          PRIMARY KEY (env, route_id, grp)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS route_groups_grp ON route_groups(env, grp);

        -- Consumer 목록. routes 와 같은 이유로 ConsumerView 를 JSON 그대로 담는다.
        -- 검색용 search 열이 없는 것은 의도적이다 — Consumer 목록 화면은 건수가 적어
        -- 프런트 배열 필터(store.filterConsumers)를 그대로 쓴다.
        CREATE TABLE IF NOT EXISTS consumers (
          env      TEXT    NOT NULL,
          username TEXT    NOT NULL,
          seq      INTEGER NOT NULL,          -- 게이트웨이가 준 원래 순서 (표시 순서 유지)
          has_jwt  INTEGER NOT NULL DEFAULT 0,-- 대시보드 KPI 를 캐시에서 계산하기 위한 것
          view     TEXT    NOT NULL,          -- serde_json::to_string(&ConsumerView)
          PRIMARY KEY (env, username)
        );
        CREATE INDEX IF NOT EXISTS consumers_env_seq ON consumers(env, seq);

        -- consumer 의 auth-groups. route_groups 와 대칭이다.
        CREATE TABLE IF NOT EXISTS consumer_groups (
          env      TEXT NOT NULL,
          username TEXT NOT NULL,
          grp      TEXT NOT NULL,
          PRIMARY KEY (env, username, grp)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS consumer_groups_grp ON consumer_groups(env, grp);

        -- Upstream 목록. routes 와 같은 이유로 UpstreamView 를 JSON 그대로 담는다.
        CREATE TABLE IF NOT EXISTS upstreams (
          env    TEXT    NOT NULL,
          id     TEXT    NOT NULL,
          seq    INTEGER NOT NULL,          -- 게이트웨이가 준 원래 순서 (표시 순서 유지)
          name   TEXT    NOT NULL DEFAULT '',
          search TEXT    NOT NULL,          -- 소문자 통합 블롭
          view   TEXT    NOT NULL,          -- serde_json::to_string(&UpstreamView)
          PRIMARY KEY (env, id)
        );
        CREATE INDEX IF NOT EXISTS upstreams_env_seq ON upstreams(env, seq);

        -- Service 목록. spec_url 과 name_prefix 를 열로 뽑아 둔 것은 Import 화면이 service 를
        -- 고른 순간 그 두 값만 필요하기 때문이다 (view 전체를 파싱하지 않아도 된다).
        CREATE TABLE IF NOT EXISTS services (
          env         TEXT    NOT NULL,
          id          TEXT    NOT NULL,
          seq         INTEGER NOT NULL,
          name        TEXT    NOT NULL DEFAULT '',
          upstream_id TEXT    NOT NULL DEFAULT '',
          spec_url    TEXT    NOT NULL DEFAULT '',
          -- route 명 접두어. 비교할 때 `oas::suggested_name_for` 로 넘어간다.
          name_prefix TEXT    NOT NULL DEFAULT '',
          search      TEXT    NOT NULL,
          view        TEXT    NOT NULL,     -- serde_json::to_string(&ServiceView)
          PRIMARY KEY (env, id)
        );
        CREATE INDEX IF NOT EXISTS services_env_seq ON services(env, seq);

        -- Import 한 OAS 문서의 오퍼레이션. 비교를 SQL 조인 한 번으로 끝내기 위한 것.
        CREATE TABLE IF NOT EXISTS oas_ops (
          seq          INTEGER PRIMARY KEY,
          path         TEXT NOT NULL,
          method       TEXT NOT NULL,
          operation_id TEXT NOT NULL DEFAULT '',
          summary      TEXT NOT NULL DEFAULT '',
          full_path    TEXT NOT NULL DEFAULT '',
          -- APISIX route 의 uri 후보 (신규 생성 폼 프리필). oas::to_apisix_uri 참조.
          suggested_uri TEXT NOT NULL DEFAULT '',
          -- route 명 후보. service 의 name 접두어가 있으면 그것을 그대로, 없으면 경로 접두사를
          -- 대문자로 바꾼 것 + 원본 path 다. oas::suggested_name_for 참조.
          suggested_name TEXT NOT NULL DEFAULT '',
          norm         TEXT NOT NULL DEFAULT ''
        );
        "#,
    )
    .map_err(sql_err)?;
    Ok(())
}

// ── Route 캐시 채우기 ────────────────────────────────────────

/// 해당 환경의 캐시를 전체 교체한다.
///
/// 부분 갱신(upsert)을 하지 않는 이유: 게이트웨이에서 삭제된 라우트가 캐시에 남으면
/// Import 가 "등록됨"으로 잘못 판정한다. 전체 조회 결과가 곧 진실이므로 통째로 바꾼다.
pub fn sync_routes(conn: &Connection, env: &str, routes: &[RouteView]) -> AppResult<()> {
    let tx = conn.unchecked_transaction().map_err(sql_err)?;

    tx.execute("DELETE FROM routes WHERE env = ?1", params![env]).map_err(sql_err)?;
    tx.execute("DELETE FROM route_uris WHERE env = ?1", params![env]).map_err(sql_err)?;
    tx.execute("DELETE FROM route_methods WHERE env = ?1", params![env]).map_err(sql_err)?;
    tx.execute("DELETE FROM route_groups WHERE env = ?1", params![env]).map_err(sql_err)?;

    {
        let mut ins_route = tx
            .prepare(
                "INSERT INTO routes (env, id, seq, name, uri, service_id, status, search, view)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(sql_err)?;
        let mut ins_uri = tx
            .prepare(
                "INSERT INTO route_uris (env, route_id, norm, prefix, wildcard)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(sql_err)?;
        let mut ins_method = tx
            .prepare("INSERT INTO route_methods (env, route_id, method) VALUES (?1, ?2, ?3)")
            .map_err(sql_err)?;
        // OR IGNORE 인 이유: models::to_string_list 는 trim·빈값 제거는 하지만 중복 제거는
        // 하지 않는다. allowed_groups 에 같은 값이 두 번 들어 있는 라우트 하나가 PK 충돌로
        // sync 트랜잭션 전체를 깨뜨리면 목록 화면이 통째로 빈다.
        let mut ins_group = tx
            .prepare("INSERT OR IGNORE INTO route_groups (env, route_id, grp) VALUES (?1, ?2, ?3)")
            .map_err(sql_err)?;

        for (i, r) in routes.iter().enumerate() {
            // id 가 없는 라우트는 상세로 갈 수도, PUT/DELETE 경로를 만들 수도 없다.
            // (env, id) 가 PK 라 빈 id 가 둘이면 sync 자체가 깨지므로 건너뛴다.
            // models::unwrap_item 이 key 에서라도 id 를 보충하므로 실제로는 거의 없다 —
            // 그래도 조용히 사라지면 목록 건수가 게이트웨이와 어긋나므로 로그를 남긴다.
            if r.id.trim().is_empty() {
                log::warn!(
                    "id 를 알 수 없는 라우트를 캐시에서 제외했습니다 (name={}, uri={})",
                    r.name,
                    r.uri
                );
                continue;
            }

            let view = serde_json::to_string(r)?;
            // 예전 프런트 필터가 JSON.stringify(route) 전체를 훑었으므로 같은 범위를 유지한다.
            let search = view.to_lowercase();

            ins_route
                .execute(params![
                    env,
                    &r.id,
                    i as i64,
                    &r.name,
                    &r.uri,
                    &r.service_id,
                    r.status,
                    search,
                    view
                ])
                .map_err(sql_err)?;

            for u in raw_uris(r) {
                let n = oas::normalize(&u);
                ins_uri
                    .execute(params![env, &r.id, n.norm, n.prefix, n.wildcard as i64])
                    .map_err(sql_err)?;
            }

            for m in &r.methods {
                let m = m.trim().to_uppercase();
                if !m.is_empty() {
                    ins_method.execute(params![env, &r.id, m]).map_err(sql_err)?;
                }
            }

            // 값은 그대로 넣는다 — to_string_list 가 이미 trim 했고 빈 값을 걸렀다.
            // 대소문자도 접지 않는다 (grp 열 주석 참조).
            for g in &r.groups {
                ins_group.execute(params![env, &r.id, g]).map_err(sql_err)?;
            }
        }
    }

    tx.commit().map_err(sql_err)?;
    Ok(())
}

/// 매칭에 쓸 uri 목록을 게이트웨이 원본에서 뽑는다.
///
/// `RouteView.uri` 는 여러 개일 때 `", "` 로 이어 붙인 **표시용** 문자열이라
/// (models::uri_of 참조) 그대로 매칭에 쓰면 안 된다. `raw` 의 `uri` / `uris` 를 직접 읽는다.
fn raw_uris(r: &RouteView) -> Vec<String> {
    let mut out = Vec::new();

    if let Some(u) = r.raw.get("uri").and_then(Value::as_str) {
        if !u.trim().is_empty() {
            out.push(u.to_string());
        }
    }
    if let Some(arr) = r.raw.get("uris").and_then(Value::as_array) {
        for u in arr.iter().filter_map(Value::as_str) {
            if !u.trim().is_empty() {
                out.push(u.to_string());
            }
        }
    }

    // raw 가 비어 있는 경우(직접 만든 RouteView 등)의 안전망 — 표시용 문자열을 되쪼갠다.
    if out.is_empty() && !r.uri.trim().is_empty() {
        out.extend(r.uri.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned));
    }

    out.sort();
    out.dedup();
    out
}

// ── Route 조회 ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RouteCounts {
    pub all: i64,
    pub on: i64,
    pub off: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutesPage {
    pub items: Vec<RouteView>,
    pub total: i64,
    /// chip 을 빼고 검색어·컨슈머만 적용한 상태별 건수 — 상단 chip 라벨이 쓴다.
    /// 좌측 패널은 이걸 쓰지 않는다 (`consumer_access_counts` 참조).
    pub counts: RouteCounts,
}

/// Route 목록의 조회 범위 — 좌측 패널이 고르는 축.
///
/// 세 값이 한 축이라 열거형으로 둔다. `Option<String>` + `bool` 두 인자로 나누면
/// "컨슈머도 고르고 그룹 제한 없음도 고른" 상태를 표현할 수 있게 되고, 그러면 그게 무슨
/// 뜻인지 SQL 이 정해야 한다. 프런트의 `RouteScope`(types.ts)와 같은 모양이다.
///
/// `rename_all` 은 열거형에서 **variant 이름만** 바꾼다. 구조체 variant 의 필드 이름까지
/// camelCase 로 받으려면 `rename_all_fields` 가 따로 필요하다 — 지금은 `username` 이 한
/// 단어라 우연히 맞지만, 두 단어 필드가 붙는 순간 조용히 snake_case 로 남는다.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RouteScope {
    #[default]
    All,
    Consumer {
        username: String,
    },
    Ungrouped,
}

impl RouteScope {
    /// SQL 바인딩 두 개로 편다. "빈 문자열 = 조건 없음" 관례가 여기 한 곳에만 있다.
    fn binds(&self) -> (&str, i64) {
        match self {
            RouteScope::All => ("", 0),
            RouteScope::Consumer { username } => (username.trim(), 0),
            RouteScope::Ungrouped => ("", 1),
        }
    }
}

/// 와이어 모양 테스트가 `binds` 결과를 보기 위한 통로 (`binds` 는 비공개다).
#[cfg(test)]
impl RouteScope {
    pub fn binds_for_test(&self) -> (String, i64) {
        let (u, g) = self.binds();
        (u.to_string(), g)
    }
}

/// 조회 범위를 SQL 조건으로 바꾼다.
///
/// 조건 조각을 붙였다 뗐다 하는 대신 `?3 = '' OR …` 형태를 쓴다. 조각을 빼면 SQL 에서 `?3` 이
/// 사라져 `params!` 길이가 안 맞고 rusqlite 가 런타임에 `InvalidParameterCount` 를 던진다.
/// (검색어의 `?2` 가 이미 같은 관례를 쓴다.) `?4` 도 마찬가지로 항상 바인딩한다.
///
/// `EXISTS` 는 첫 일치에서 멈추는 세미조인이라 **`DISTINCT` 가 필요 없다** — 넣으면 정렬이
/// 강제돼 `ORDER BY seq` 가 `routes_env_seq` 인덱스를 못 탄다.
/// 서브쿼리를 `route_groups` 에서 시작하는 것도 의도적이다: `(env, route_id)` PK 로 몇 행만
/// 훑고 `consumer_groups` 를 PK 로 조회한다. 반대로 시작하면 그 그룹을 가진 모든 라우트로 퍼진다.
const ACCESS_CLAUSE: &str = " AND (?3 = '' OR EXISTS (
          SELECT 1 FROM route_groups rg
            JOIN consumer_groups cg ON cg.env = rg.env AND cg.grp = rg.grp
           WHERE rg.env = ?1 AND rg.route_id = routes.id AND cg.username = ?3))
        AND (?4 = 0 OR NOT EXISTS (
          SELECT 1 FROM route_groups rg
           WHERE rg.env = ?1 AND rg.route_id = routes.id))";

/// name 접두사 조건.
///
/// 검색어(`?2`)와 **다른 축**이다. 검색어는 `search` 블롭 어디에나 걸리는 '포함' 이고,
/// 이쪽은 `name` 이 그 문자열로 **시작**하는가만 본다. 사내 route 명 규약(`EP_…`)으로
/// 한 덩어리를 골라내는 용도라, 이름 중간에 우연히 들어간 `EP_` 까지 걸리면 안 된다.
///
/// `LIKE ?5 || '%'` 를 쓰지 않는다 — route 명에 흔한 `_` 가 LIKE 의 단일문자 와일드카드라
/// `EP_` 가 `EPX…` 까지 잡는다 (`instr` 을 쓰는 검색어 쪽과 같은 이유).
///
/// 대소문자는 무시한다. 경로 접두사에서 파생한 접두어는 대문자(`V1/`)지만 service 에
/// 등록한 접두어는 사용자가 쓴 그대로(`ep_`)라, 목록에서 고르는 값과 저장된 값의 대소문자가
/// 다를 수 있다. `?5` 는 호출부가 이미 소문자로 정규화해서 넘긴다 (`needle`).
const NAME_PREFIX_CLAUSE: &str =
    " AND (?5 = '' OR substr(lower(name), 1, length(?5)) = ?5)";

/// chip 값(`all` / `on` / `off`)을 status 조건으로 바꾼다.
fn status_clause(chip: &str) -> &'static str {
    match chip {
        "on" => " AND status = 1",
        "off" => " AND status <> 1",
        _ => "",
    }
}

/// 검색어를 정규화한다. 빈 문자열은 "조건 없음"이다.
fn needle(q: &str) -> String {
    q.trim().to_lowercase()
}

/// 네 축(상태 chip · 검색어 · name 접두사 · 조회 범위)을 적용해 라우트를 조회한다.
///
/// `scope` 가 `Consumer` 면 그 컨슈머의 auth-groups 와 라우트의 allowed_groups 교집합이
/// 비어 있지 않은 라우트만 남는다. allowed_groups 가 아예 없는 라우트는 어떤 컨슈머로도
/// 걸리지 않으므로, 그것만 보는 `Ungrouped` 를 따로 둔다.
pub fn query_routes(
    conn: &Connection,
    env: &str,
    chip: &str,
    q: &str,
    name_prefix: &str,
    scope: &RouteScope,
) -> AppResult<RoutesPage> {
    let n = needle(q);
    let pfx = needle(name_prefix);
    let (user, ungrouped) = scope.binds();

    // instr() 은 LIKE 와 달리 % · _ 를 메타문자로 취급하지 않는다.
    // uri 에 밑줄이 흔하므로 검색어를 이스케이프해야 하는 부담을 아예 없앤다.
    let sql = format!(
        "SELECT view FROM routes
          WHERE env = ?1 AND (?2 = '' OR instr(search, ?2) > 0){}{}{}
          ORDER BY seq",
        ACCESS_CLAUSE,
        NAME_PREFIX_CLAUSE,
        status_clause(chip)
    );

    let mut stmt = conn.prepare(&sql).map_err(sql_err)?;
    let rows = stmt
        .query_map(params![env, &n, user, ungrouped, &pfx], |row| row.get::<_, String>(0))
        .map_err(sql_err)?;

    let mut items = Vec::new();
    for r in rows {
        let json = r.map_err(sql_err)?;
        items.push(serde_json::from_str::<RouteView>(&json)?);
    }

    let counts = route_counts(conn, env, q, name_prefix, scope)?;
    Ok(RoutesPage { total: items.len() as i64, items, counts })
}

/// chip 을 **뺀** 나머지 축(검색어 · name 접두사 · 조회 범위)만 적용한 상태별 건수.
///
/// chip 을 빼는 이유는 chip 을 눌러도 라벨의 숫자가 흔들리지 않게 하기 위해서고,
/// 나머지를 **넣는** 이유는 그것들이 chip 과 나란한 필터가 아니라 조회 범위이기 때문이다.
/// 컨슈머로 8건이 남았는데 chip 이 `status 1 (312)` 라고 말하면 안 된다.
/// ('그룹 제한 없음' · name 접두사도 같은 이유로 반영해야 한다 — 안 하면 `?4` · `?5` 가
/// 여기서 바인딩되지 않아 rusqlite 가 아예 `InvalidParameterCount` 를 던진다.)
pub fn route_counts(
    conn: &Connection,
    env: &str,
    q: &str,
    name_prefix: &str,
    scope: &RouteScope,
) -> AppResult<RouteCounts> {
    let n = needle(q);
    let pfx = needle(name_prefix);
    let (user, ungrouped) = scope.binds();
    conn.query_row(
        &format!(
            "SELECT COUNT(*),
                    COALESCE(SUM(status =  1), 0),
                    COALESCE(SUM(status <> 1), 0)
               FROM routes
              WHERE env = ?1
                AND (?2 = '' OR instr(search, ?2) > 0){ACCESS_CLAUSE}{NAME_PREFIX_CLAUSE}"
        ),
        params![env, &n, user, ungrouped, &pfx],
        |row| Ok(RouteCounts { all: row.get(0)?, on: row.get(1)?, off: row.get(2)? }),
    )
    .map_err(sql_err)
}

/// 캐시에서 라우트 한 건. Import 결과 행 클릭 → 상세 이동에 쓴다
/// (목록이 필터된 상태라 프런트 배열에 없을 수 있다).
pub fn route_view(conn: &Connection, env: &str, id: &str) -> AppResult<Option<RouteView>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT view FROM routes WHERE env = ?1 AND id = ?2",
            params![env, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_err)?;

    match json {
        Some(j) => Ok(Some(serde_json::from_str::<RouteView>(&j)?)),
        None => Ok(None),
    }
}

// ── Consumer 캐시 채우기 ─────────────────────────────────────

/// 해당 환경의 Consumer 캐시를 전체 교체한다.
///
/// `sync_routes` 와 같은 이유로 부분 갱신을 하지 않는다 — 게이트웨이에서 지워진 컨슈머가
/// 캐시에 남으면 Route 화면 좌측 패널에 유령 항목이 뜨고, 그걸 눌러 필터링하면
/// "권한 있는 API 가 0건"이라는 거짓 답을 보게 된다.
///
/// # 그룹 값은 원문 그대로, 대소문자를 구분한다
///
/// 게이트웨이의 `shi-auth` 가 요청 시점에 하는 비교를 화면이 그대로 흉내를 내야 하기 때문이다.
/// 화면이 "접근 가능"이라고 했는데 실제 호출이 403 이면, 화면이 깐깐한 것보다 훨씬 나쁘다.
/// (`oas::normalize` 가 uri 대소문자를 보존하는 것과 같은 판단이다.)
/// `COLLATE NOCASE` 는 ASCII 만 접어서 한글 그룹명에는 아무 효과가 없으므로 쓰지 않는다.
pub fn sync_consumers(conn: &Connection, env: &str, items: &[ConsumerView]) -> AppResult<()> {
    let tx = conn.unchecked_transaction().map_err(sql_err)?;

    tx.execute("DELETE FROM consumers WHERE env = ?1", params![env]).map_err(sql_err)?;
    tx.execute("DELETE FROM consumer_groups WHERE env = ?1", params![env]).map_err(sql_err)?;

    {
        let mut ins = tx
            .prepare(
                "INSERT INTO consumers (env, username, seq, has_jwt, view)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(sql_err)?;
        // sync_routes 의 route_groups 와 같은 이유로 OR IGNORE 다.
        let mut ins_group = tx
            .prepare(
                "INSERT OR IGNORE INTO consumer_groups (env, username, grp) VALUES (?1, ?2, ?3)",
            )
            .map_err(sql_err)?;

        for (i, c) in items.iter().enumerate() {
            // APISIX 는 username 을 보장하지만 models::unwrap_item 은 key 에서 id 만 보충하고
            // username 은 보충하지 않는다. 빈 값이 둘이면 PK 가 깨지므로 건너뛰되,
            // 조용히 사라지면 건수가 게이트웨이와 어긋나므로 로그를 남긴다. (sync_routes 와 동일)
            if c.username.trim().is_empty() {
                log::warn!("username 을 알 수 없는 컨슈머를 캐시에서 제외했습니다 (key={})", c.key);
                continue;
            }

            let view = serde_json::to_string(c)?;
            ins.execute(params![env, &c.username, i as i64, c.has_jwt_auth as i64, view])
                .map_err(sql_err)?;

            for g in &c.groups {
                ins_group.execute(params![env, &c.username, g]).map_err(sql_err)?;
            }
        }
    }

    tx.commit().map_err(sql_err)?;
    Ok(())
}

/// 캐시의 Consumer 전체 목록. 게이트웨이 순서를 유지한다.
pub fn consumers_cached(conn: &Connection, env: &str) -> AppResult<Vec<ConsumerView>> {
    let mut stmt = conn
        .prepare("SELECT view FROM consumers WHERE env = ?1 ORDER BY seq")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map(params![env], |row| row.get::<_, String>(0))
        .map_err(sql_err)?;

    let mut out = Vec::new();
    for r in rows {
        out.push(serde_json::from_str::<ConsumerView>(&r.map_err(sql_err)?)?);
    }
    Ok(out)
}

// ── 컨슈머 접근 권한 (Route ↔ Consumer 조인) ────────────────

/// 컨슈머 한 명이 접근할 수 있는 라우트 수.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerAccess {
    pub username: String,
    pub count: i64,
}

/// Route 화면 좌측 패널이 쓰는 집계.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccessCounts {
    /// 필터 없는 전체 라우트 수 — 패널의 '전체 Route' 행.
    pub all: i64,
    /// allowed_groups 가 비어 어떤 컨슈머로도 걸리지 않는 라우트 수.
    pub ungrouped: i64,
    pub items: Vec<ConsumerAccess>,
}

/// 컨슈머별 접근 가능 라우트 수를 한 번에 집계한다.
///
/// 검색어·status chip 을 **반영하지 않는다.** 이 숫자는 결과 요약이 아니라 범위 선택을 돕는
/// 고정값이라, 타이핑할 때마다 패널의 모든 숫자가 흔들리면 고를 수가 없다.
pub fn consumer_access_counts(conn: &Connection, env: &str) -> AppResult<AccessCounts> {
    let all: i64 = conn
        .query_row("SELECT COUNT(*) FROM routes WHERE env = ?1", params![env], |r| r.get(0))
        .map_err(sql_err)?;

    let ungrouped: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM routes r
              WHERE r.env = ?1
                AND NOT EXISTS (SELECT 1 FROM route_groups rg
                                 WHERE rg.env = r.env AND rg.route_id = r.id)",
            params![env],
            |r| r.get(0),
        )
        .map_err(sql_err)?;

    let mut stmt = conn
        .prepare(
            // COUNT(DISTINCT …) 가 필수다: 컨슈머와 라우트가 그룹을 둘 이상 공유하면
            // 같은 (컨슈머, 라우트) 쌍이 조인 결과에 여러 행으로 나온다.
            // LEFT JOIN 이라 그룹이 없는 컨슈머도 0 으로 남는다.
            "SELECT c.username, COUNT(DISTINCT rg.route_id)
               FROM consumers c
               LEFT JOIN consumer_groups cg
                      ON cg.env = c.env AND cg.username = c.username
               LEFT JOIN route_groups rg
                      ON rg.env = c.env AND rg.grp = cg.grp
              WHERE c.env = ?1
              GROUP BY c.username
              ORDER BY c.username",
        )
        .map_err(sql_err)?;

    let rows = stmt
        .query_map(params![env], |r| {
            Ok(ConsumerAccess { username: r.get(0)?, count: r.get(1)? })
        })
        .map_err(sql_err)?;

    let items = rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)?;
    Ok(AccessCounts { all, ungrouped, items })
}

/// 대시보드 KPI 중 캐시에서 셀 수 있는 것.
///
/// 이게 없으면 앱을 켤 때마다 route·consumer 전체 조회가 네 번(부트스트랩 2 + 대시보드 2)
/// 나가고, 50건짜리 호출 이력이 목록 조회로 도배된다.
#[derive(Debug, Clone, Copy, Default)]
pub struct OverviewCounts {
    pub routes: i64,
    pub routes_active: i64,
    pub routes_inactive: i64,
    pub consumers: i64,
    pub consumers_jwt: i64,
}

pub fn overview_counts(conn: &Connection, env: &str) -> AppResult<OverviewCounts> {
    let (routes, routes_active, routes_inactive) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(status = 1), 0), COALESCE(SUM(status <> 1), 0)
               FROM routes WHERE env = ?1",
            params![env],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(sql_err)?;

    let (consumers, consumers_jwt) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(has_jwt = 1), 0) FROM consumers WHERE env = ?1",
            params![env],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql_err)?;

    Ok(OverviewCounts { routes, routes_active, routes_inactive, consumers, consumers_jwt })
}

// ── Upstream · Service 캐시 ─────────────────────────────────

/// 게이트웨이에서 받은 Upstream 목록으로 캐시를 **교체**한다.
///
/// `sync_routes` 와 같은 이유로 부분 upsert 를 하지 않는다 — 게이트웨이에서 지워진 항목이
/// 캐시에 남으면 Service 폼의 upstream 콤보에 유령 항목이 뜨고, 그걸 고르면 저장이 400 이 된다.
pub fn sync_upstreams(conn: &Connection, env: &str, items: &[UpstreamView]) -> AppResult<()> {
    let tx = conn.unchecked_transaction().map_err(sql_err)?;
    tx.execute("DELETE FROM upstreams WHERE env = ?1", params![env]).map_err(sql_err)?;
    {
        let mut ins = tx
            .prepare(
                "INSERT INTO upstreams (env, id, seq, name, search, view)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(sql_err)?;
        for (i, u) in items.iter().enumerate() {
            if u.id.trim().is_empty() {
                log::warn!("id 가 없는 upstream 을 건너뜁니다 (name={})", u.name);
                continue;
            }
            let view = serde_json::to_string(u)?;
            ins.execute(params![env, &u.id, i as i64, &u.name, view.to_lowercase(), view])
                .map_err(sql_err)?;
        }
    }
    tx.commit().map_err(sql_err)?;
    Ok(())
}

/// 캐시의 Upstream 전체 목록. 게이트웨이 순서를 유지한다.
pub fn upstreams_cached(conn: &Connection, env: &str) -> AppResult<Vec<UpstreamView>> {
    let mut stmt = conn
        .prepare("SELECT view FROM upstreams WHERE env = ?1 ORDER BY seq")
        .map_err(sql_err)?;
    let rows =
        stmt.query_map(params![env], |row| row.get::<_, String>(0)).map_err(sql_err)?;

    let mut out = Vec::new();
    for r in rows {
        out.push(serde_json::from_str::<UpstreamView>(&r.map_err(sql_err)?)?);
    }
    Ok(out)
}

/// 게이트웨이에서 받은 Service 목록으로 캐시를 **교체**한다.
pub fn sync_services(conn: &Connection, env: &str, items: &[ServiceView]) -> AppResult<()> {
    let tx = conn.unchecked_transaction().map_err(sql_err)?;
    tx.execute("DELETE FROM services WHERE env = ?1", params![env]).map_err(sql_err)?;
    {
        let mut ins = tx
            .prepare(
                "INSERT INTO services
                        (env, id, seq, name, upstream_id, spec_url, name_prefix, search, view)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(sql_err)?;
        for (i, sv) in items.iter().enumerate() {
            if sv.id.trim().is_empty() {
                log::warn!("id 가 없는 service 를 건너뜁니다 (name={})", sv.name);
                continue;
            }
            let view = serde_json::to_string(sv)?;
            ins.execute(params![
                env,
                &sv.id,
                i as i64,
                &sv.name,
                &sv.upstream_id,
                &sv.spec_url,
                &sv.name_prefix,
                view.to_lowercase(),
                view
            ])
            .map_err(sql_err)?;
        }
    }
    tx.commit().map_err(sql_err)?;
    Ok(())
}

/// 캐시의 Service 전체 목록. 게이트웨이 순서를 유지한다.
pub fn services_cached(conn: &Connection, env: &str) -> AppResult<Vec<ServiceView>> {
    let mut stmt = conn
        .prepare("SELECT view FROM services WHERE env = ?1 ORDER BY seq")
        .map_err(sql_err)?;
    let rows =
        stmt.query_map(params![env], |row| row.get::<_, String>(0)).map_err(sql_err)?;

    let mut out = Vec::new();
    for r in rows {
        out.push(serde_json::from_str::<ServiceView>(&r.map_err(sql_err)?)?);
    }
    Ok(out)
}

// ── OAS 비교 ─────────────────────────────────────────────────

/// 스펙 오퍼레이션 한 건의 판정 결과.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompareRow {
    /// 원본 OAS path (`/pets/{petId}`)
    pub path: String,
    /// 접두사를 적용한 경로 — 실제로 게이트웨이와 비교한 값
    pub full_path: String,
    pub method: String,
    pub operation_id: String,
    pub summary: String,
    /// `registered` · `unregistered`
    pub state: String,
    /// 매칭된 route 의 id. 미등록이면 빈 문자열
    pub route_id: String,
    /// 아래 `route_*` 는 **매칭된 route 에 지금 저장돼 있는 값**이다.
    /// 프런트가 `suggested_*` 와 대조해 "등록돼 있지만 스펙과 값이 다르다"를 판정한다
    /// (`lib/importDiff.ts`). 캐시의 `RouteView` 를 그대로 옮기므로 `route_cached` 로
    /// 다시 읽어 만드는 diff 화면의 기준값과 어긋날 자리가 없다.
    pub route_name: String,
    pub route_uri: String,
    pub route_desc: String,
    pub route_rewrite: String,
    /// 매칭된 route 의 `proxy-rewrite.regex_uri` (배열 그대로, 없으면 빈 배열).
    pub route_rewrite_regex: Vec<String>,
    pub route_status: i64,
    /// 정확 일치가 아니라 와일드카드(`/a/*`) 로 걸렸는가
    pub wildcard: bool,
    /// 미등록 건을 신규 생성할 때 폼에 채울 uri 후보.
    /// 경로 파라미터 변환 규칙이 한 곳에만 있어야 하므로 프런트에서 다시 만들지 않는다.
    pub suggested_uri: String,
    /// 신규 생성 폼의 `name` 후보 — 접두어 + 접두사를 뗀 원본 path. 접두어는 고른 service 의
    /// `labels.name_prefix` 가 있으면 그것(`EP_`), 없으면 경로 접두사에서 파생한 것(`V1/`)이다.
    /// (`oas::suggested_name_for`. uri 와 같은 이유로 프런트에서 다시 만들지 않는다.)
    pub suggested_name: String,
    /// 신규 생성 폼의 `proxy-rewrite.uri` 후보 — 접두사를 붙이지 않은 OAS 원본 path.
    /// 게이트웨이 uri 에는 접두사가 붙지만 upstream 이 아는 경로는 접두사 없는 쪽이다.
    ///
    /// **경로 파라미터가 있으면 이 값을 쓰지 않는다** — 아래 `suggested_rewrite_regex` 를 쓴다.
    pub suggested_rewrite: String,
    /// 신규 생성 폼의 `proxy-rewrite.regex_uri` 후보 (패턴, 치환) — 파라미터가 없으면 빈 배열.
    ///
    /// `proxy-rewrite.uri` 는 정적 문자열이라 `{VNDRCD}` 를 치환하지 않는다. 파라미터가 있는
    /// path 를 `uri` 로 프리필하면 중괄호가 리터럴로 upstream 에 나간다 (`oas::to_rewrite_regex`).
    pub suggested_rewrite_regex: Vec<String>,
}

pub const REGISTERED: &str = "registered";
pub const UNREGISTERED: &str = "unregistered";

/// 파싱한 오퍼레이션을 캐시에 적재한다 (이전 문서는 버린다).
pub fn load_oas_ops(conn: &Connection, ops: &[OasOp]) -> AppResult<()> {
    let tx = conn.unchecked_transaction().map_err(sql_err)?;
    tx.execute("DELETE FROM oas_ops", []).map_err(sql_err)?;
    {
        let mut ins = tx
            .prepare(
                "INSERT INTO oas_ops (seq, path, method, operation_id, summary)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(sql_err)?;
        for (i, o) in ops.iter().enumerate() {
            ins.execute(params![
                i as i64,
                &o.path,
                o.method.to_uppercase(),
                &o.operation_id,
                &o.summary
            ])
            .map_err(sql_err)?;
        }
    }
    tx.commit().map_err(sql_err)?;
    Ok(())
}

/// 오퍼레이션 하나에 걸린 라우트 후보. `compare` 가 이 중 최선 하나만 남긴다.
///
/// **이 메서드를 받는 라우트만 후보가 된다** — uri 만 같고 메서드가 다른 라우트는 이 API 를
/// 처리하지 않으므로 (path, method) 단위로 보면 이 API 는 등록돼 있지 않다.
///
/// `view` 는 `RouteView` 의 JSON 이다. 열로 하나씩 실어 오는 대신 통째로 들고 있다가
/// **이긴 후보만** 파싱한다 — `route_cached` 와 같은 값을 보게 되므로 표의 판정과
/// diff 화면의 기준값이 어긋날 수 없다.
struct Cand {
    view: String,
    wildcard: bool,
}

/// 적재된 오퍼레이션을 선택한 service 안의 라우트와 비교한다.
///
/// 조인 한 번으로 (오퍼레이션 × 후보 라우트) 쌍을 전부 뽑고 순위 결정만 Rust 에서 한다.
/// SQL 안에서 순위까지 매기면 읽기 어려워지고, 후보 수는 오퍼레이션당 한두 개라 이 편이 낫다.
///
/// 판정은 `registered` · `unregistered` **둘**이다. 등록된 건이 스펙과 값까지 같은지는
/// 여기서 정하지 않는다 — `route_*` (지금 저장된 값) 과 `suggested_*` (스펙 후보) 를 함께
/// 실어 보내고, 그 대조는 프런트의 `lib/importDiff.ts` 한 곳에서만 한다.
pub fn compare(
    conn: &Connection,
    env: &str,
    service_id: &str,
    prefix: &str,
) -> AppResult<Vec<CompareRow>> {
    // 고른 service 가 route 명 접두어를 갖고 있으면 그것이 경로 접두사를 이긴다.
    // 캐시에 없는 service (동기화 전 등) 는 빈 문자열이라 기존 규칙으로 degrade 한다.
    let svc_prefix: String = conn
        .query_row(
            "SELECT name_prefix FROM services WHERE env = ?1 AND id = ?2",
            params![env, service_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql_err)?
        .unwrap_or_default();

    // 접두사가 바뀌면 비교 대상 경로가 달라진다 — 매번 다시 계산해 넣는다.
    {
        let tx = conn.unchecked_transaction().map_err(sql_err)?;
        let rows: Vec<(i64, String)> = {
            let mut stmt = tx.prepare("SELECT seq, path FROM oas_ops").map_err(sql_err)?;
            let it = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                .map_err(sql_err)?;
            it.collect::<Result<_, _>>().map_err(sql_err)?
        };
        {
            let mut upd = tx
                .prepare(
                    "UPDATE oas_ops SET full_path = ?2, norm = ?3, suggested_uri = ?4,
                            suggested_name = ?5
                      WHERE seq = ?1",
                )
                .map_err(sql_err)?;
            for (seq, path) in rows {
                let full = oas::join_path(prefix, &path);
                let norm = oas::normalize(&full).norm;
                let suggested = oas::to_apisix_uri(prefix, &path);
                let name = oas::suggested_name_for(&svc_prefix, prefix, &path);
                upd.execute(params![seq, full, norm, suggested, name]).map_err(sql_err)?;
            }
        }
        tx.commit().map_err(sql_err)?;
    }

    // substr 비교로 접두 매칭한다. LIKE 를 쓰면 uri 안의 '_' 가 단일문자 와일드카드로
    // 해석돼 `/a_b/*` 가 `/aXb/...` 까지 잡아 버린다.
    let mut stmt = conn
        .prepare(
            "SELECT o.seq, o.path, o.full_path, o.method, o.operation_id, o.summary,
                    r.view, ru.wildcard,
                    o.suggested_uri, o.suggested_name,
                    EXISTS(SELECT 1 FROM route_methods m
                            WHERE m.env = ?1 AND m.route_id = r.id AND m.method = o.method),
                    (SELECT COUNT(*) FROM route_methods m
                            WHERE m.env = ?1 AND m.route_id = r.id)
               FROM oas_ops o
               LEFT JOIN route_uris ru
                      ON ru.env = ?1
                     AND (ru.norm = o.norm
                          OR (ru.wildcard = 1
                              AND substr(o.norm, 1, length(ru.prefix)) = ru.prefix))
               LEFT JOIN routes r
                      ON r.env = ru.env AND r.id = ru.route_id AND r.service_id = ?2
              ORDER BY o.seq",
        )
        .map_err(sql_err)?;

    // seq 별로 최선의 후보 하나만 남긴다.
    let mut acc: Vec<(CompareRow, Option<Cand>)> = Vec::new();
    let mut last_seq: Option<i64> = None;

    let mut rows = stmt
        .query(params![env, service_id])
        .map_err(sql_err)?;

    while let Some(row) = rows.next().map_err(sql_err)? {
        let seq: i64 = row.get(0).map_err(sql_err)?;
        // LEFT JOIN 이므로 걸린 라우트가 없으면 NULL 이다.
        let view: Option<String> = row.get(6).map_err(sql_err)?;

        let cand = match view {
            Some(v) if !v.is_empty() => {
                let method_count: i64 = row.get(11).map_err(sql_err)?;
                let method_hit: bool = row.get(10).map_err(sql_err)?;
                // methods 키가 없는 라우트는 모든 메서드를 허용한다 (APISIX 규칙).
                // 그 외에는 이 메서드를 받는 라우트만 후보다 (`Cand` 주석 참조).
                if method_count == 0 || method_hit {
                    Some(Cand { view: v, wildcard: row.get::<_, i64>(7).map_err(sql_err)? != 0 })
                } else {
                    None
                }
            }
            _ => None,
        };

        if last_seq != Some(seq) {
            last_seq = Some(seq);
            let path: String = row.get(1).map_err(sql_err)?;
            // 파라미터가 있는 path 는 regex 쌍을, 없으면 빈 배열을 준다. 열을 늘리지 않고
            // 여기서 계산하는 이유는 `prefix` 와 `path` 가 이 자리에 둘 다 있기 때문이다.
            let rewrite_regex = oas::to_rewrite_regex(prefix, &path)
                .map(|(from, to)| vec![from, to])
                .unwrap_or_default();
            acc.push((
                CompareRow {
                    path: path.clone(),
                    full_path: row.get(2).map_err(sql_err)?,
                    method: row.get(3).map_err(sql_err)?,
                    operation_id: row.get(4).map_err(sql_err)?,
                    summary: row.get(5).map_err(sql_err)?,
                    state: UNREGISTERED.to_string(),
                    route_id: String::new(),
                    route_name: String::new(),
                    route_uri: String::new(),
                    route_desc: String::new(),
                    route_rewrite: String::new(),
                    route_rewrite_regex: Vec::new(),
                    route_status: 0,
                    wildcard: false,
                    suggested_uri: row.get(8).map_err(sql_err)?,
                    suggested_name: row.get(9).map_err(sql_err)?,
                    // 접두사를 붙이지 않은 원본 path 가 곧 rewrite 후보다.
                    suggested_rewrite: path,
                    suggested_rewrite_regex: rewrite_regex,
                },
                None,
            ));
        }

        if let Some(c) = cand {
            let slot = &mut acc.last_mut().expect("행 하나는 이미 push 되어 있다").1;
            // 후보 순위는 정확 일치 우선이다 — 메서드는 이미 후보 조건에 들어가 있다.
            if slot.as_ref().map(|best| best.wildcard && !c.wildcard).unwrap_or(true) {
                *slot = Some(c);
            }
        }
    }

    let mut out = Vec::with_capacity(acc.len());
    for (mut row, best) in acc {
        if let Some(c) = best {
            // 이긴 후보만 파싱한다 (`Cand` 주석 참조).
            let r: RouteView = serde_json::from_str(&c.view)?;
            row.state = REGISTERED.to_string();
            row.route_id = r.id;
            row.route_name = r.name;
            row.route_uri = r.uri;
            row.route_desc = r.desc;
            row.route_rewrite = r.rewrite;
            row.route_rewrite_regex = r.rewrite_regex;
            row.route_status = r.status;
            row.wildcard = c.wildcard;
        }
        out.push(row);
    }
    Ok(out)
}
