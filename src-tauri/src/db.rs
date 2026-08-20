//! 내장 SQLite 캐시 — Route 목록 검색과 OAS Import 비교의 공용 인덱스.
//!
//! # 왜 SQLite 인가
//!
//! 예전에는 프런트가 라우트 배열을 통째로 들고 매 키 입력마다 `JSON.stringify(route)` 로
//! 전문 검색을 했다. 라우트가 수백 건이 되면 눈에 띄게 느려지고, 무엇보다 Import 기능이
//! 필요로 하는 "이 uri·method 가 등록돼 있나"를 배열 순회로 풀면 (스펙 오퍼레이션 수) ×
//! (라우트 수) 번 비교하게 된다. uri 를 정규화해 인덱스로 만들어 두면 두 문제가 같이 풀린다.
//!
//! # 메모리 전용
//!
//! `Connection::open_in_memory()` 다. 디스크에 남기지 않으므로 앱을 다시 켜면 비어 있고,
//! 목록 화면에 들어갈 때(또는 리프레시 버튼)의 전체 조회가 유일한 채우기 경로다.
//! 게이트웨이가 진실의 원천이고 이건 조회 가속용 사본이라, stale 데이터를 들고 있을 위험을
//! 아예 만들지 않는 편을 택했다.
//!
//! # 스레드 안전
//!
//! `rusqlite::Connection` 은 `Sync` 가 아니므로 `Mutex` 로 감싸 Tauri 관리 상태에 넣는다.
//! 이 파일의 함수들은 전부 `&Connection` 만 받는 순수 함수라 테스트에서 그대로 부를 수 있다.

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::apisix::models::RouteView;
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
    /// chip 필터를 빼고 검색어만 적용한 상태별 건수 — chip 라벨과 사이드 패널이 쓴다.
    pub counts: RouteCounts,
}

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

pub fn query_routes(conn: &Connection, env: &str, chip: &str, q: &str) -> AppResult<RoutesPage> {
    let n = needle(q);

    // instr() 은 LIKE 와 달리 % · _ 를 메타문자로 취급하지 않는다.
    // uri 에 밑줄이 흔하므로 검색어를 이스케이프해야 하는 부담을 아예 없앤다.
    let sql = format!(
        "SELECT view FROM routes
          WHERE env = ?1 AND (?2 = '' OR instr(search, ?2) > 0){}
          ORDER BY seq",
        status_clause(chip)
    );

    let mut stmt = conn.prepare(&sql).map_err(sql_err)?;
    let rows = stmt
        .query_map(params![env, &n], |row| row.get::<_, String>(0))
        .map_err(sql_err)?;

    let mut items = Vec::new();
    for r in rows {
        let json = r.map_err(sql_err)?;
        items.push(serde_json::from_str::<RouteView>(&json)?);
    }

    let counts = route_counts(conn, env, q)?;
    Ok(RoutesPage { total: items.len() as i64, items, counts })
}

/// 검색어만 적용한 상태별 건수. chip 을 눌러도 라벨의 숫자가 흔들리지 않게 하려고 분리했다.
pub fn route_counts(conn: &Connection, env: &str, q: &str) -> AppResult<RouteCounts> {
    let n = needle(q);
    conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(status =  1), 0),
                COALESCE(SUM(status <> 1), 0)
           FROM routes
          WHERE env = ?1 AND (?2 = '' OR instr(search, ?2) > 0)",
        params![env, &n],
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
    /// `registered` · `methodMismatch` · `unregistered`
    pub state: String,
    /// 매칭된 route 의 id. 미등록이면 빈 문자열
    pub route_id: String,
    pub route_name: String,
    pub route_uri: String,
    pub route_status: i64,
    /// 정확 일치가 아니라 와일드카드(`/a/*`) 로 걸렸는가
    pub wildcard: bool,
    /// 미등록 건을 신규 생성할 때 폼에 채울 uri 후보.
    /// 경로 파라미터 변환 규칙이 한 곳에만 있어야 하므로 프런트에서 다시 만들지 않는다.
    pub suggested_uri: String,
}

pub const REGISTERED: &str = "registered";
pub const METHOD_MISMATCH: &str = "methodMismatch";
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
struct Cand {
    route_id: String,
    route_name: String,
    route_uri: String,
    route_status: i64,
    wildcard: bool,
    method_ok: bool,
}

impl Cand {
    /// 후보 순위 — 메서드가 맞는 쪽을 먼저, 같으면 정확 일치를 먼저.
    ///
    /// 메서드를 정확 일치보다 우선하는 이유: uri 만 같고 메서드가 다른 라우트와,
    /// 와일드카드지만 메서드가 맞는 라우트가 함께 있으면 실제 호출은 후자로 흘러간다.
    /// 그 상황에서 "등록됨"이 정직한 답이다.
    fn score(&self) -> i32 {
        (if self.method_ok { 100 } else { 0 }) + (if self.wildcard { 0 } else { 10 })
    }
}

/// 적재된 오퍼레이션을 선택한 service 안의 라우트와 비교한다.
///
/// 조인 한 번으로 (오퍼레이션 × 후보 라우트) 쌍을 전부 뽑고 순위 결정만 Rust 에서 한다.
/// SQL 안에서 순위까지 매기면 읽기 어려워지고, 후보 수는 오퍼레이션당 한두 개라 이 편이 낫다.
pub fn compare(
    conn: &Connection,
    env: &str,
    service_id: &str,
    prefix: &str,
) -> AppResult<Vec<CompareRow>> {
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
                    "UPDATE oas_ops SET full_path = ?2, norm = ?3, suggested_uri = ?4
                      WHERE seq = ?1",
                )
                .map_err(sql_err)?;
            for (seq, path) in rows {
                let full = oas::join_path(prefix, &path);
                let norm = oas::normalize(&full).norm;
                let suggested = oas::to_apisix_uri(prefix, &path);
                upd.execute(params![seq, full, norm, suggested]).map_err(sql_err)?;
            }
        }
        tx.commit().map_err(sql_err)?;
    }

    // substr 비교로 접두 매칭한다. LIKE 를 쓰면 uri 안의 '_' 가 단일문자 와일드카드로
    // 해석돼 `/a_b/*` 가 `/aXb/...` 까지 잡아 버린다.
    let mut stmt = conn
        .prepare(
            "SELECT o.seq, o.path, o.full_path, o.method, o.operation_id, o.summary,
                    r.id, r.name, r.uri, r.status, ru.wildcard,
                    o.suggested_uri,
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
        let route_id: Option<String> = row.get(6).map_err(sql_err)?;

        let cand = match route_id {
            Some(id) if !id.is_empty() => {
                let method_count: i64 = row.get(13).map_err(sql_err)?;
                let method_hit: bool = row.get(12).map_err(sql_err)?;
                Some(Cand {
                    route_id: id,
                    route_name: row.get(7).map_err(sql_err)?,
                    route_uri: row.get(8).map_err(sql_err)?,
                    route_status: row.get(9).map_err(sql_err)?,
                    wildcard: row.get::<_, i64>(10).map_err(sql_err)? != 0,
                    // methods 키가 없는 라우트는 모든 메서드를 허용한다 (APISIX 규칙).
                    method_ok: method_count == 0 || method_hit,
                })
            }
            _ => None,
        };

        if last_seq != Some(seq) {
            last_seq = Some(seq);
            acc.push((
                CompareRow {
                    path: row.get(1).map_err(sql_err)?,
                    full_path: row.get(2).map_err(sql_err)?,
                    method: row.get(3).map_err(sql_err)?,
                    operation_id: row.get(4).map_err(sql_err)?,
                    summary: row.get(5).map_err(sql_err)?,
                    state: UNREGISTERED.to_string(),
                    route_id: String::new(),
                    route_name: String::new(),
                    route_uri: String::new(),
                    route_status: 0,
                    wildcard: false,
                    suggested_uri: row.get(11).map_err(sql_err)?,
                },
                None,
            ));
        }

        if let Some(c) = cand {
            let slot = &mut acc.last_mut().expect("행 하나는 이미 push 되어 있다").1;
            if slot.as_ref().map(|best| c.score() > best.score()).unwrap_or(true) {
                *slot = Some(c);
            }
        }
    }

    Ok(acc
        .into_iter()
        .map(|(mut row, best)| {
            if let Some(c) = best {
                row.state =
                    if c.method_ok { REGISTERED.to_string() } else { METHOD_MISMATCH.to_string() };
                row.route_id = c.route_id;
                row.route_name = c.route_name;
                row.route_uri = c.route_uri;
                row.route_status = c.route_status;
                row.wildcard = c.wildcard;
            }
            row
        })
        .collect())
}
