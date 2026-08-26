//! 회귀 테스트.
//!
//! 이 앱에서 조용히 틀리면 가장 위험한 다섯 가지를 고정한다:
//!   1. **프록시 우회** — 시스템/환경변수 프록시가 걸려 있어도 직접 나가야 한다.
//!   2. **플러그인 보존** — 저장이 게이트웨이의 다른 플러그인을 지우면 안 된다.
//!   3. **JWT 형식** — 게이트웨이가 받아들이는 HS256 토큰이어야 한다.
//!   4. **OAS 파싱** — 스펙 한 줄이 어긋나도 경로 비교는 계속 되어야 한다.
//!   5. **등록 판정** — 이미 등록된 API 를 "미등록"으로 보여 주면 중복 route 가 생긴다.

use serde_json::json;

// ── 1. 프록시 우회 ───────────────────────────────────────────

mod proxy {
    use crate::apisix::client;
    use crate::config::EnvConfig;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// APISIX 흉내를 내는 최소 HTTP 서버. 포트를 돌려준다.
    fn spawn_stub() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);

                let body = br#"{"total":0,"list":[]}"#;
                let head = format!(
                    "HTTP/1.1 200 OK\r\n\
                     Server: APISIX/3.9.1\r\n\
                     Content-Type: application/json\r\n\
                     Content-Length: {}\r\n\
                     Connection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(body);
                let _ = s.flush();
            }
        });

        port
    }

    fn cfg(port: u16, no_proxy: bool) -> EnvConfig {
        EnvConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            no_proxy,
            insecure_tls: false,
        }
    }

    /// no_proxy 를 켜면 HTTP_PROXY 환경변수가 죽은 주소를 가리켜도 직접 연결된다.
    /// 끄면 프록시를 타서 실패한다 — 즉 토글이 실제로 동작한다는 뜻이다.
    ///
    /// 두 검증이 같은 프로세스의 환경변수를 공유하므로 한 테스트로 묶었다.
    #[test]
    fn no_proxy_bypasses_env_proxy() {
        let port = spawn_stub();

        // 아무도 듣지 않는 포트를 프록시로 지정한다 → 프록시를 타면 즉시 실패.
        std::env::set_var("HTTP_PROXY", "http://127.0.0.1:9");
        std::env::set_var("HTTPS_PROXY", "http://127.0.0.1:9");
        // NO_PROXY 에 127.0.0.1 이 들어 있으면 음성 케이스가 무의미해지므로 지운다.
        std::env::remove_var("NO_PROXY");
        std::env::remove_var("no_proxy");

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        // (1) no_proxy = true → 성공해야 한다.
        let bypassed = client::build(&cfg(port, true)).expect("client");
        let url = format!("http://127.0.0.1:{port}/apisix/admin/routes");
        let ok = rt.block_on(async { bypassed.get(&url).send().await });
        assert!(
            ok.is_ok(),
            "no_proxy=true 인데 프록시를 탔다 (프록시 우회 실패): {:?}",
            ok.err()
        );
        assert_eq!(ok.unwrap().status().as_u16(), 200);

        // (2) no_proxy = false → 죽은 프록시로 가서 실패해야 한다.
        let proxied = client::build(&cfg(port, false)).expect("client");
        let err = rt.block_on(async { proxied.get(&url).send().await });
        assert!(
            err.is_err(),
            "no_proxy=false 인데 프록시를 타지 않았다 — 토글이 동작하지 않는다"
        );

        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("HTTPS_PROXY");
    }
}

// ── 2. 저장 시 플러그인 보존 ─────────────────────────────────

#[test]
fn route_save_preserves_unknown_plugins() {
    use crate::apisix::routes::{apply_route_form_for_test, RouteForm};

    // 게이트웨이에 이미 limit-count 가 붙어 있고, proxy-rewrite 에는 headers 설정도 있다.
    let existing = json!({
        "id": "42",
        "name": "order-list-v1",
        "uri": "/api/v1/orders",
        "methods": ["GET"],
        "status": 0,
        "service_id": "svc-order-core",
        "create_time": 1700000000,
        "update_time": 1700000100,
        "plugins": {
            "limit-count": { "count": 100, "time_window": 60 },
            "proxy-rewrite": { "uri": "/orders", "headers": { "X-Src": "gw" } },
            "shi-auth": { "allowed_groups": ["ops-admin"], "mode": "strict" }
        }
    });

    let form = RouteForm {
        id: Some("42".into()),
        name: "order-list-v1".into(),
        uri: "/api/v1/orders".into(),
        desc: "주문 목록".into(),
        methods: vec!["GET".into(), "POST".into()],
        service_id: "svc-order-core".into(),
        rewrite: "/orders/v2".into(),
        rewrite_mode: "uri".into(),
        rewrite_regex: vec![],
        groups: vec!["ops-admin".into(), "order-dev".into()],
        auth_mode: String::new(),
        status: Some(0),
        groups_location: None,
    };

    let body = apply_route_form_for_test(existing, &form, false);
    let p = body.get("plugins").unwrap();

    // 앱이 모르는 플러그인은 그대로 살아 있어야 한다.
    assert_eq!(p.pointer("/limit-count/count").unwrap(), 100);
    // 같은 플러그인 안의 다른 필드도 보존된다.
    assert_eq!(p.pointer("/proxy-rewrite/headers/X-Src").unwrap(), "gw");
    assert_eq!(p.pointer("/shi-auth/mode").unwrap(), "strict");

    // 앱이 관리하는 키는 폼 값으로 갱신된다.
    assert_eq!(p.pointer("/proxy-rewrite/uri").unwrap(), "/orders/v2");
    assert_eq!(
        p.pointer("/shi-auth/allowed_groups").unwrap(),
        &json!(["ops-admin", "order-dev"])
    );

    // 서버가 관리하는 필드는 요청 본문에서 빠진다.
    assert!(body.get("create_time").is_none());
    assert!(body.get("update_time").is_none());
    assert!(body.get("id").is_none());

    // 기존 라우트는 status 가 유지된다 (신규만 1 고정).
    assert_eq!(body.get("status").unwrap(), 0);
}

#[test]
fn new_route_is_always_active() {
    use crate::apisix::routes::{apply_route_form_for_test, RouteForm};

    let form = RouteForm {
        id: None,
        name: "new-route".into(),
        uri: "/a, /b".into(),
        desc: String::new(),
        methods: vec![],
        service_id: "svc-1".into(),
        rewrite: String::new(),
        rewrite_mode: String::new(),
        rewrite_regex: vec![],
        groups: vec![],
        auth_mode: String::new(),
        status: None,
        groups_location: None,
    };

    let body = apply_route_form_for_test(json!({}), &form, true);
    assert_eq!(body.get("status").unwrap(), 1);
    // desc 가 비면 키 자체를 보내지 않는다.
    assert!(body.get("desc").is_none());
    // methods 가 비면 키를 빼서 모든 메서드를 허용한다.
    assert!(body.get("methods").is_none());
    // 쉼표가 있으면 uris 배열로 저장한다.
    assert_eq!(body.get("uris").unwrap(), &json!(["/a", "/b"]));
    assert!(body.get("uri").is_none());
}

/// `uri` 와 `regex_uri` 는 **절대 함께 남지 않는다.**
///
/// APISIX proxy-rewrite 는 `if conf.uri ~= nil then … elseif conf.regex_uri ~= nil then` 이라
/// `uri` 가 있으면 regex 를 아예 보지 않는다. 둘이 함께 남으면 화면에는 regex 가 보이는데
/// 게이트웨이는 uri 로 도는, 눈으로 잡을 수 없는 상태가 된다.
#[test]
fn rewrite_modes_are_mutually_exclusive() {
    use crate::apisix::routes::{apply_route_form_for_test, RouteForm};

    let base = || {
        json!({
            "plugins": {
                "limit-count": { "count": 7 },
                "proxy-rewrite": {
                    "uri": "/old",
                    "scheme": "http",
                    "headers": { "X-Src": "gw" }
                }
            }
        })
    };
    let form = |mode: &str, rewrite: &str, regex: Vec<&str>| RouteForm {
        id: Some("1".into()),
        name: "r".into(),
        uri: "/evcp/Vendor/GRP/*".into(),
        desc: String::new(),
        methods: vec!["GET".into()],
        service_id: "svc".into(),
        rewrite: rewrite.into(),
        rewrite_mode: mode.into(),
        rewrite_regex: regex.into_iter().map(String::from).collect(),
        groups: vec![],
        auth_mode: String::new(),
        status: None,
        groups_location: None,
    };

    // regex 모드 → regex_uri 만 남고 uri 는 사라진다.
    let body = apply_route_form_for_test(
        base(),
        &form("regex", "/ignored", vec!["^/evcp/Vendor/GRP/(.*)", "/Vendor/GRP/$1"]),
        false,
    );
    let pr = body.pointer("/plugins/proxy-rewrite").unwrap();
    assert_eq!(
        pr.get("regex_uri").unwrap(),
        &json!(["^/evcp/Vendor/GRP/(.*)", "/Vendor/GRP/$1"])
    );
    assert!(pr.get("uri").is_none(), "regex 모드에서 uri 가 남으면 regex 가 무시된다");
    // 같은 플러그인 안의 다른 키와 다른 플러그인은 그대로다.
    assert_eq!(pr.get("scheme").unwrap(), "http");
    assert_eq!(pr.pointer("/headers/X-Src").unwrap(), "gw");
    assert_eq!(body.pointer("/plugins/limit-count/count").unwrap(), 7);

    // 되돌아오면 regex_uri 가 지워진다 — 남겨 두면 uri 뒤에서 조용히 죽은 설정이 된다.
    let back = json!({ "plugins": { "proxy-rewrite": {
        "regex_uri": ["^/a/(.*)", "/b/$1"], "scheme": "http" } } });
    let body = apply_route_form_for_test(back, &form("uri", "/orders", vec![]), false);
    let pr = body.pointer("/plugins/proxy-rewrite").unwrap();
    assert_eq!(pr.get("uri").unwrap(), "/orders");
    assert!(pr.get("regex_uri").is_none());
    assert_eq!(pr.get("scheme").unwrap(), "http");
}

/// 폼은 첫 쌍만 편집하지만, 게이트웨이에 있던 나머지 쌍은 사라지지 않아야 한다.
/// APISIX 의 regex_uri 는 쌍을 앞에서부터 시도하므로 뒤쪽 쌍도 살아 있는 규칙이다.
#[test]
fn rewrite_regex_keeps_extra_pairs() {
    use crate::apisix::routes::{apply_route_form_for_test, RouteForm};

    let form = RouteForm {
        id: Some("1".into()),
        name: "r".into(),
        uri: "/a/*".into(),
        desc: String::new(),
        methods: vec!["GET".into()],
        service_id: "svc".into(),
        rewrite: String::new(),
        rewrite_mode: "regex".into(),
        // 첫 쌍만 고치고 세 번째·네 번째는 조회한 값을 그대로 실어 보낸 상태다.
        rewrite_regex: ["^/a/(.*)", "/b/$1", "^/other/(.*)", "/other"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        groups: vec![],
        auth_mode: String::new(),
        status: None,
        groups_location: None,
    };

    let body = apply_route_form_for_test(json!({}), &form, false);
    assert_eq!(
        body.pointer("/plugins/proxy-rewrite/regex_uri").unwrap(),
        &json!(["^/a/(.*)", "/b/$1", "^/other/(.*)", "/other"])
    );
}

/// 두 칸을 다 비우면 "rewrite 없음" 이다 — uri 모드에서 빈 칸을 둔 것과 같이 다룬다.
/// 반쯤 채운 것은 저장 전에 막는다 (게이트웨이가 스키마 오류로 거부하는데, 무엇이 비었는지는
/// 여기가 안다).
#[test]
fn blank_regex_pair_removes_the_key() {
    use crate::apisix::routes::{apply_route_form_for_test, validate_for_test, RouteForm};

    let form = |regex: Vec<&str>| RouteForm {
        id: Some("1".into()),
        name: "r".into(),
        uri: "/a/*".into(),
        desc: String::new(),
        methods: vec![],
        service_id: "svc".into(),
        rewrite: String::new(),
        rewrite_mode: "regex".into(),
        rewrite_regex: regex.into_iter().map(String::from).collect(),
        groups: vec![],
        auth_mode: String::new(),
        status: None,
        groups_location: None,
    };
    let base = || json!({ "plugins": { "proxy-rewrite": { "regex_uri": ["^/x/(.*)", "/y/$1"] } } });

    // 전부 비었다 → 키를 지운다. 저장도 통과한다.
    for blank in [vec![], vec!["", ""], vec!["   ", ""]] {
        let f = form(blank);
        assert!(validate_for_test(&f).is_ok());
        assert!(apply_route_form_for_test(base(), &f, false)
            .pointer("/plugins/proxy-rewrite/regex_uri")
            .is_none());
    }

    // 반쯤 채웠다 → 저장을 막는다.
    assert!(validate_for_test(&form(vec!["^/a/(.*)", "   "])).is_err());
    // 홀수 → 짝 없는 항목이 남는다.
    assert!(validate_for_test(&form(vec!["^/a/(.*)", "/b/$1", "^/c/(.*)"])).is_err());
    // 정상 쌍은 통과한다.
    assert!(validate_for_test(&form(vec!["^/a/(.*)", "/b/$1"])).is_ok());

    // 중간이 비어도 **걸러 내지 않는다** — 걸러 내면 쌍이 밀려 엉뚱한 짝이 만들어진다.
    assert!(apply_route_form_for_test(base(), &form(vec!["^/a/(.*)", "", "^/c/(.*)", "/d"]), false)
        .pointer("/plugins/proxy-rewrite/regex_uri")
        .is_none());
}

/// 전체 허용은 "권한그룹 0건" 이 아니라 **권한 플러그인을 떼는 것**이다.
///
/// 빈 `allowed_groups` 를 남기면 게이트웨이에서는 정반대(어느 그룹도 못 들어옴)가 된다.
/// 폼에 남아 있는 그룹 목록도 저장 본문에 실리지 않아야 한다 — 모드가 곧 답이다.
#[test]
fn public_route_drops_the_auth_plugin() {
    use crate::apisix::routes::{apply_route_form_for_test, RouteForm};

    let existing = json!({
        "id": "42",
        "name": "health",
        "uri": "/health",
        "service_id": "svc",
        "plugins": {
            "limit-count": { "count": 100 },
            "proxy-rewrite": { "uri": "/health", "headers": { "X-Src": "gw" } },
            "shi-auth": { "allowed_groups": ["ops-admin"], "mode": "strict" }
        }
    });

    let form = RouteForm {
        id: Some("42".into()),
        name: "health".into(),
        uri: "/health".into(),
        desc: String::new(),
        methods: vec!["GET".into()],
        service_id: "svc".into(),
        rewrite: "/health".into(),
        rewrite_mode: "uri".into(),
        rewrite_regex: vec![],
        // 폼에는 그룹이 남아 있다 (모드를 되돌리면 복원되어야 하므로). 저장에는 안 실린다.
        groups: vec!["ops-admin".into()],
        auth_mode: "public".into(),
        status: Some(1),
        groups_location: None,
    };

    let body = apply_route_form_for_test(existing, &form, false);

    // 플러그인이 통째로 사라진다 — `mode: strict` 같은 다른 필드째로.
    assert!(body.pointer("/plugins/shi-auth").is_none());
    // 빈 껍데기도 남기지 않는다.
    assert!(body.pointer("/plugins/shi-auth/allowed_groups").is_none());
    // 최상위로 새는 일도 없어야 한다.
    assert!(body.get("allowed_groups").is_none());
    // 나머지 플러그인은 그대로다 — 전체 허용은 권한만 떼는 것이다.
    assert_eq!(body.pointer("/plugins/limit-count/count").unwrap(), 100);
    assert_eq!(body.pointer("/plugins/proxy-rewrite/uri").unwrap(), "/health");
    assert_eq!(body.pointer("/plugins/proxy-rewrite/headers/X-Src").unwrap(), "gw");
}

/// 권한을 떼고 rewrite 도 없으면 `plugins` 키 자체가 사라진다 (Service 와 같은 규칙).
#[test]
fn public_route_without_other_plugins_drops_the_plugins_key() {
    use crate::apisix::routes::{apply_route_form_for_test, RouteForm};

    let form = RouteForm {
        id: None,
        name: "public-ping".into(),
        uri: "/ping".into(),
        desc: String::new(),
        methods: vec!["GET".into()],
        service_id: "svc".into(),
        rewrite: String::new(),
        rewrite_mode: String::new(),
        rewrite_regex: vec![],
        groups: vec![],
        auth_mode: "public".into(),
        status: None,
        groups_location: None,
    };

    let body = apply_route_form_for_test(json!({}), &form, true);
    assert!(body.get("plugins").is_none(), "빈 plugins 껍데기를 남기지 않는다");
    assert_eq!(body.get("status").unwrap(), 1);
}

/// 그룹 값이 비표준 자리에 있었어도 전체 허용은 **그 자리까지** 지운다.
///
/// 한쪽만 지우면 남은 자리가 계속 검사를 해서, 화면은 "전체 허용" 인데 호출은 403 이 된다.
#[test]
fn public_route_clears_nonstandard_group_fields() {
    use crate::apisix::models::GroupsLocation;
    use crate::apisix::routes::{apply_route_form_for_test, RouteForm};

    let form = |loc: GroupsLocation| RouteForm {
        id: Some("7".into()),
        name: "r".into(),
        uri: "/a".into(),
        desc: String::new(),
        methods: vec![],
        service_id: "svc".into(),
        rewrite: String::new(),
        rewrite_mode: String::new(),
        rewrite_regex: vec![],
        groups: vec!["partner".into()],
        auth_mode: "public".into(),
        status: None,
        groups_location: Some(loc),
    };

    // (1) 최상위 필드에 있던 경우
    let base = json!({ "uri": "/a", "groups": ["partner"], "plugins": { "limit-count": {} } });
    let loc = GroupsLocation { plugin: String::new(), key: "groups".into(), as_csv: false };
    let body = apply_route_form_for_test(base, &form(loc), false);
    assert!(body.get("groups").is_none());
    assert!(body.pointer("/plugins/limit-count").is_some());

    // (2) 다른 플러그인이 그룹 검사를 하고 있던 경우 — shi-auth 와 함께 지운다.
    let base = json!({
        "uri": "/a",
        "plugins": {
            "shi-auth": {},
            "other-auth": { "allowed_groups": ["partner"] },
            "limit-count": {}
        }
    });
    let loc =
        GroupsLocation { plugin: "other-auth".into(), key: "allowed_groups".into(), as_csv: false };
    let body = apply_route_form_for_test(base, &form(loc), false);
    assert!(body.pointer("/plugins/other-auth").is_none());
    assert!(body.pointer("/plugins/shi-auth").is_none());
    assert!(body.pointer("/plugins/limit-count").is_some());
}

/// 그룹 모드는 예전과 똑같다 — 빈 목록이면 **빈 배열을 남긴다**(= 아무도 접근 못 함).
/// 전체 허용과 구별되지 않으면 폼의 두 모드가 무의미해진다.
#[test]
fn groups_mode_keeps_an_empty_allowed_groups() {
    use crate::apisix::routes::{apply_route_form_for_test, RouteForm};

    let form = RouteForm {
        id: Some("1".into()),
        name: "r".into(),
        uri: "/a".into(),
        desc: String::new(),
        methods: vec![],
        service_id: "svc".into(),
        rewrite: String::new(),
        rewrite_mode: String::new(),
        rewrite_regex: vec![],
        groups: vec![],
        auth_mode: "groups".into(),
        status: None,
        groups_location: None,
    };

    let body = apply_route_form_for_test(json!({ "plugins": { "shi-auth": {} } }), &form, false);
    assert_eq!(body.pointer("/plugins/shi-auth/allowed_groups").unwrap(), &json!([]));
}

/// `has_auth` 는 "권한 검사가 붙어 있는가" 다 — 그룹이 비었는지와 다른 질문이다.
#[test]
fn route_view_tells_public_from_empty_groups() {
    use crate::apisix::models::RouteView;

    let view = |v: serde_json::Value| RouteView::from_value(&v);

    // (1) 플러그인이 없다 → 전체 허용
    let r = view(json!({ "id": "1", "uri": "/ping", "plugins": { "limit-count": {} } }));
    assert!(!r.has_auth);
    assert!(r.groups.is_empty());

    // (2) plugins 자체가 없어도 같다
    assert!(!view(json!({ "id": "2", "uri": "/ping" })).has_auth);

    // (3) 붙어 있고 그룹이 비었다 → 아무도 접근 못 함 (전체 허용이 아니다)
    let r = view(json!({ "id": "3", "uri": "/a", "plugins": { "shi-auth": { "allowed_groups": [] } } }));
    assert!(r.has_auth);
    assert!(r.groups.is_empty());

    // (4) 키 없이 플러그인만 붙어 있어도 검사는 살아 있다
    assert!(view(json!({ "id": "4", "uri": "/a", "plugins": { "shi-auth": {} } })).has_auth);

    // (5) 값이 있으면 당연히 붙어 있다
    let r = view(json!({
        "id": "5", "uri": "/a",
        "plugins": { "shi-auth": { "allowed_groups": ["ops-admin"] } }
    }));
    assert!(r.has_auth);
    assert_eq!(r.groups, vec!["ops-admin"]);

    // (6) 비표준 자리(최상위 필드)도 검사가 붙어 있는 것으로 읽는다
    let r = view(json!({ "id": "6", "uri": "/a", "groups": ["partner"] }));
    assert!(r.has_auth);
    assert_eq!(r.groups_location.plugin, "");
}

#[test]
fn consumer_save_preserves_jwt_auth_extras() {
    use crate::apisix::consumers::{apply_consumer_form_for_test, ConsumerForm};

    let existing = json!({
        "username": "partner_alpha",
        "plugins": {
            "jwt-auth": { "key": "old-key", "secret": "old", "algorithm": "HS256", "exp": 86400 },
            "limit-count": { "count": 10 }
        }
    });

    let form = ConsumerForm {
        username: "partner_alpha".into(),
        desc: "제휴사".into(),
        key: "partner-alpha-key".into(),
        secret: "a3f1c8d92b7e4056ac1de9f2b8710c44".into(),
        groups: vec!["partner".into()],
        is_new: false,
        groups_location: None,
        contacts: None,
    };

    let body = apply_consumer_form_for_test(existing, &form);
    let p = body.get("plugins").unwrap();

    assert_eq!(p.pointer("/jwt-auth/algorithm").unwrap(), "HS256");
    assert_eq!(p.pointer("/jwt-auth/exp").unwrap(), 86400);
    assert_eq!(p.pointer("/limit-count/count").unwrap(), 10);
    assert_eq!(p.pointer("/jwt-auth/key").unwrap(), "partner-alpha-key");
    assert_eq!(p.pointer("/jwt-auth/auth_groups").unwrap(), &json!(["partner"]));
}

// ── 2-b. auth-groups 를 어디에 넣어 뒀든 찾아 읽고, 그 자리에 되쓴다 ──
//
// 이 앱 밖에서 등록된 consumer 는 표기가 달라 화면이 공란으로 보이는 사고가 있었다.
// 읽기는 관대하게, 쓰기는 "읽은 그 자리에" 가 규칙이다.

#[test]
fn finds_auth_groups_in_nonstandard_places() {
    use crate::apisix::models::ConsumerView;

    // (1) 표준 위치 — 게이트웨이가 `auth_conf.auth_groups` 로 읽는 자리
    let c = ConsumerView::from_value(&json!({
        "username": "a",
        "plugins": { "jwt-auth": { "key": "k", "auth_groups": ["partner", "ops"] } }
    }));
    assert_eq!(c.groups, vec!["partner", "ops"]);
    assert_eq!(c.groups_location.plugin, "jwt-auth");
    assert_eq!(c.groups_location.key, "auth_groups");

    // (2) 하이픈 표기
    let c = ConsumerView::from_value(&json!({
        "username": "b",
        "plugins": { "jwt-auth": { "key": "k", "auth-groups": ["internal"] } }
    }));
    assert_eq!(c.groups, vec!["internal"]);
    assert_eq!(c.groups_location.key, "auth-groups");

    // (3) 다른 플러그인 (사내 shi-auth 등)
    let c = ConsumerView::from_value(&json!({
        "username": "c",
        "plugins": {
            "jwt-auth": { "key": "k" },
            "shi-auth": { "allowed_groups": ["billing-ops"] }
        }
    }));
    assert_eq!(c.groups, vec!["billing-ops"]);
    assert_eq!(c.groups_location.plugin, "shi-auth");

    // (4) 콤마 구분 문자열
    let c = ConsumerView::from_value(&json!({
        "username": "d",
        "plugins": { "jwt-auth": { "key": "k", "auth-groups": "partner, mobile" } }
    }));
    assert_eq!(c.groups, vec!["partner", "mobile"]);
    assert!(c.groups_location.as_csv);

    // (5) 최상위 필드
    let c = ConsumerView::from_value(&json!({
        "username": "e",
        "groups": ["qa"],
        "plugins": { "jwt-auth": { "key": "k" } }
    }));
    assert_eq!(c.groups, vec!["qa"]);
    assert_eq!(c.groups_location.plugin, "");

    // (6) 어디에도 없으면 빈 목록 + 기본 위치
    let c = ConsumerView::from_value(&json!({
        "username": "f",
        "plugins": { "jwt-auth": { "key": "k" } }
    }));
    assert!(c.groups.is_empty());
    assert_eq!(c.groups_location, Default::default());

    // (7) 표준 위치가 비어 있고 값은 다른 곳에 있으면 값이 있는 쪽을 택한다.
    let c = ConsumerView::from_value(&json!({
        "username": "g",
        "plugins": {
            "jwt-auth": { "key": "k", "auth_groups": [] },
            "shi-auth": { "allowed_groups": ["ops-admin"] }
        }
    }));
    assert_eq!(c.groups, vec!["ops-admin"]);
    assert_eq!(c.groups_location.plugin, "shi-auth");
}

#[test]
fn saves_auth_groups_back_to_where_they_were_found() {
    use crate::apisix::consumers::{apply_consumer_form_for_test, ConsumerForm};
    use crate::apisix::models::{ConsumerView, GroupsLocation};

    // 다른 도구가 `auth-groups`(하이픈)로 넣어 둔 consumer
    let existing = json!({
        "username": "partner_alpha",
        "plugins": { "jwt-auth": { "key": "k", "secret": "s", "auth-groups": ["partner"] } }
    });
    let view = ConsumerView::from_value(&existing);

    let form = ConsumerForm {
        username: "partner_alpha".into(),
        desc: String::new(),
        key: "k".into(),
        secret: "s".into(),
        groups: vec!["partner".into(), "mobile".into()],
        is_new: false,
        groups_location: Some(view.groups_location.clone()),
        contacts: None,
    };

    let body = apply_consumer_form_for_test(existing, &form);
    let p = body.get("plugins").unwrap();

    // 원래 표기 그대로 갱신되고
    assert_eq!(p.pointer("/jwt-auth/auth-groups").unwrap(), &json!(["partner", "mobile"]));
    // 표준 표기를 새로 만들어 키를 둘로 갈라 놓지 않는다.
    assert!(p.pointer("/jwt-auth/auth_groups").is_none());

    // CSV 로 저장돼 있던 경우엔 CSV 로 되쓴다.
    let csv_loc = GroupsLocation {
        plugin: "jwt-auth".into(),
        key: "auth-groups".into(),
        as_csv: true,
    };
    let form = ConsumerForm {
        username: "u".into(),
        desc: String::new(),
        key: "k".into(),
        secret: "s".into(),
        groups: vec!["a".into(), "b".into()],
        is_new: false,
        groups_location: Some(csv_loc),
        contacts: None,
    };
    let body = apply_consumer_form_for_test(json!({}), &form);
    assert_eq!(body.pointer("/plugins/jwt-auth/auth-groups").unwrap(), "a,b");
}

#[test]
fn new_consumer_writes_groups_where_the_gateway_reads_them() {
    use crate::apisix::consumers::{apply_consumer_form_for_test, ConsumerForm};

    // 신규 등록은 읽어 올 원본이 없어(consumers::save 가 base 를 `{}` 로 둔다) 폼도
    // groups_location 을 보내지 못한다 — 기본 위치가 그대로 저장 위치가 된다.
    let form = ConsumerForm {
        username: "partner_beta".into(),
        desc: String::new(),
        key: "partner-beta-key".into(),
        secret: "s".into(),
        groups: vec!["partner".into()],
        is_new: true,
        groups_location: None,
        contacts: None,
    };

    let body = apply_consumer_form_for_test(json!({}), &form);
    let p = body.get("plugins").unwrap();

    // 게이트웨이의 shi-auth 가 `ctx.consumer.auth_conf.auth_groups` 로 읽는 자리.
    assert_eq!(p.pointer("/jwt-auth/auth_groups").unwrap(), &json!(["partner"]));
    // 하이픈으로 쓰면 Lua 의 dot 접근이 그 키를 보지 못해 인가가 통째로 실패한다
    // ("user does not belong to allowed groups").
    assert!(p.pointer("/jwt-auth/auth-groups").is_none());
}

#[test]
fn standard_group_key_wins_over_legacy_spelling() {
    use crate::apisix::models::ConsumerView;

    // 하이픈으로 잘못 저장됐던 컨슈머를 게이트웨이에서 손으로 고치면 두 키가 함께 남는다.
    // 그때 하이픈 쪽을 읽어 되쓰면 그 조치가 이 앱에서 한 번 저장하는 것으로 되돌아간다.
    let c = ConsumerView::from_value(&json!({
        "username": "partner_alpha",
        "plugins": { "jwt-auth": {
            "key": "k",
            "auth-groups": ["stale"],
            "auth_groups": ["ops-admin"]
        }}
    }));
    assert_eq!(c.groups, vec!["ops-admin"]);
    assert_eq!(c.groups_location.key, "auth_groups");
}

// ── 3. 응답 파싱 ─────────────────────────────────────────────

#[test]
fn extracts_both_v3_and_v2_list_shapes() {
    use crate::apisix::models::extract_list;

    let v3 = json!({
        "total": 1,
        "list": [{ "key": "/apisix/routes/1", "value": { "id": "1", "uri": "/hello" } }]
    });
    let got = extract_list(&v3);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].get("uri").unwrap(), "/hello");

    let v2 = json!({
        "count": "1",
        "node": { "nodes": [{ "key": "/apisix/routes/1", "value": { "id": "1", "uri": "/hi" } }] }
    });
    let got = extract_list(&v2);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].get("uri").unwrap(), "/hi");

    // 목록이 비어 있어도 패닉하지 않는다.
    assert!(extract_list(&json!({ "total": 0, "list": [] })).is_empty());
    assert!(extract_list(&json!({})).is_empty());
}

#[test]
fn route_view_reads_plugin_fields() {
    use crate::apisix::models::RouteView;

    let v = json!({
        "id": 7,
        "name": "billing-invoice",
        "uris": ["/api/v1/invoices/*"],
        "methods": ["GET", "POST"],
        "status": 0,
        "service_id": "svc-billing",
        "update_time": 1_700_000_000,
        "plugins": {
            "proxy-rewrite": { "uri": "/invoices/*" },
            "shi-auth": { "allowed_groups": ["billing-ops"] }
        }
    });

    let r = RouteView::from_value(&v);
    assert_eq!(r.id, "7"); // 숫자 id 도 문자열로 정규화된다
    assert_eq!(r.uri, "/api/v1/invoices/*"); // uris → uri 표기
    assert_eq!(r.rewrite, "/invoices/*");
    assert!(r.rewrite_regex.is_empty());
    assert_eq!(r.groups, vec!["billing-ops"]);
    assert_eq!(r.status, 0);
}

/// `regex_uri` 를 읽지 못하면 목록의 proxy-rewrite 칸이 빈칸이 되고, 폼이 그 자리에 `uri` 를
/// 써 넣어 두 키가 공존하는 본문이 만들어진다 (그러면 regex 가 조용히 죽는다).
#[test]
fn route_view_reads_regex_rewrite() {
    use crate::apisix::models::RouteView;

    let r = RouteView::from_value(&json!({
        "id": "8",
        "uri": "/evcp/Vendor/CMCTB_VENDOR_GRP/*",
        "plugins": { "proxy-rewrite": {
            "regex_uri": ["^/evcp/Vendor/CMCTB_VENDOR_GRP/(.*)", "/Vendor/CMCTB_VENDOR_GRP/$1"],
            "scheme": "http"
        }}
    }));
    assert_eq!(r.rewrite, "", "uri 키는 없다");
    assert_eq!(
        r.rewrite_regex,
        ["^/evcp/Vendor/CMCTB_VENDOR_GRP/(.*)", "/Vendor/CMCTB_VENDOR_GRP/$1"]
    );

    // 쌍이 셋 이상이어도 잘리지 않는다 — 폼이 첫 쌍만 편집해도 나머지가 보존되는 근거다.
    let many = RouteView::from_value(&json!({
        "id": "9",
        "plugins": { "proxy-rewrite": {
            "regex_uri": ["^/a/(.*)", "/b/$1", "^/c/(.*)", "/d"] }}
    }));
    assert_eq!(many.rewrite_regex.len(), 4);
}

// ── 4. JWT ───────────────────────────────────────────────────

#[test]
fn jwt_is_valid_hs256() {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    let r = crate::jwt::sign("partner-alpha-key", "topsecret", None, None).expect("sign");

    let parts: Vec<&str> = r.token.split('.').collect();
    assert_eq!(parts.len(), 3, "JWT 는 3개 세그먼트여야 한다");

    let header = URL_SAFE_NO_PAD.decode(parts[0]).unwrap();
    assert_eq!(String::from_utf8(header).unwrap(), r#"{"alg":"HS256","typ":"JWT"}"#);

    let payload: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
    assert_eq!(payload["key"], "partner-alpha-key");
    // nbf 는 발급 시점이 아니라 고정값(로컬 2025-08-01 00:00)이다.
    assert_eq!(r.nbf, payload["nbf"].as_i64().unwrap());
    assert_eq!(r.nbf_human, "2025-08-01 00:00");
    // 만료는 디자인이 고정한 값 (로컬 3000-12-31 17:59)
    assert_eq!(r.exp, payload["exp"].as_i64().unwrap());
    assert!(r.exp_human.starts_with("3000-12-31"));

    // base64url 패딩이 없어야 한다.
    assert!(!r.token.contains('='));
    assert!(!r.token.contains('+'));
    assert!(!r.token.contains('/'));

    // key·secret 이 같으면 몇 번을 눌러도 같은 토큰이 나온다 (nbf 고정의 목적).
    let again = crate::jwt::sign("partner-alpha-key", "topsecret", None, None).expect("sign");
    assert_eq!(r.token, again.token);

    // secret 이 바뀌면 토큰도 바뀐다.
    let rotated = crate::jwt::sign("partner-alpha-key", "othersecret", None, None).expect("sign");
    assert_ne!(r.token, rotated.token);

    // key·secret 이 없으면 서명하지 않는다.
    assert!(crate::jwt::sign("", "s", None, None).is_err());
    assert!(crate::jwt::sign("k", "", None, None).is_err());
}

#[test]
fn generated_secret_is_32_hex_chars() {
    let a = crate::jwt::gen_secret();
    let b = crate::jwt::gen_secret();
    assert_eq!(a.len(), 32);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b, "매번 다른 값이 나와야 한다");
}

// ── 4-b. 관리 토큰 권한 (perm) ───────────────────────────────

mod admin_token {
    use crate::jwt;
    use crate::perm::{self, Perm, Reason};

    /// 하루짜리 유효 구간. `at()` 이 시각을 인자로 받으므로 실제 시계에 의존하지 않는다.
    const NBF: i64 = 1_767_225_600; // 2026-01-01T00:00:00Z
    const EXP: i64 = 1_767_312_000; // 2026-01-02T00:00:00Z
    const MID: i64 = 1_767_268_800; // 그 사이

    fn admin_token() -> String {
        jwt::sign_admin(NBF, EXP, &Perm::Admin).unwrap().token
    }

    fn scoped_token(ids: &[&str]) -> String {
        let p = Perm::Services(ids.iter().map(|s| s.to_string()).collect());
        jwt::sign_admin(NBF, EXP, &p).unwrap().token
    }

    /// 발급한 토큰이 그대로 되읽힌다 — 이 왕복이 깨지면 발급 화면이 만든 토큰으로
    /// 아무도 로그인할 수 없게 된다.
    #[test]
    fn sign_admin_round_trips_through_decode() {
        let c = perm::decode(&admin_token()).expect("admin 토큰 해석");
        assert_eq!((c.nbf, c.exp), (NBF, EXP));
        assert_eq!(c.perm, Perm::Admin);

        let c = perm::decode(&scoped_token(&["svc-b", "svc-a"])).expect("scoped 토큰 해석");
        // 발급 시 정렬·중복 제거된다 — 같은 권한이면 같은 토큰이어야 한다.
        assert_eq!(c.perm, Perm::Services(vec!["svc-a".into(), "svc-b".into()]));
        assert_eq!(
            scoped_token(&["svc-a", "svc-b", "svc-a"]),
            scoped_token(&["svc-b", "svc-a"]),
            "정렬·중복 제거 후 서명하므로 같은 집합이면 같은 토큰이다"
        );
    }

    #[test]
    fn payload_key_order_is_fixed() {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;

        let t = admin_token();
        let parts: Vec<&str> = t.split('.').collect();
        let payload = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
        assert_eq!(
            String::from_utf8(payload).unwrap(),
            format!(r#"{{"key":"apisix-manage","nbf":{NBF},"exp":{EXP},"perm":"admin"}}"#),
            "키 순서가 바뀌면 같은 권한인데도 토큰 문자열이 달라진다"
        );
        assert!(!t.contains('='), "base64url 패딩이 없어야 한다");
    }

    #[test]
    fn rejects_tampered_and_foreign_tokens() {
        // 서명 위조 — 마지막 세그먼트를 갈아 끼운다.
        let t = admin_token();
        let head = t.rsplit_once('.').unwrap().0;
        assert_eq!(
            perm::decode(&format!("{head}.YWFhYWFh")).unwrap_err(),
            Reason::BadSignature
        );

        // payload 를 고치면 서명이 먼저 깨진다 (권한 승격 시도).
        let forged = {
            use base64::engine::general_purpose::URL_SAFE_NO_PAD;
            use base64::Engine;
            let parts: Vec<&str> = t.split('.').collect();
            let evil = URL_SAFE_NO_PAD
                .encode(r#"{"key":"apisix-manage","nbf":0,"exp":9999999999,"perm":"admin"}"#);
            format!("{}.{}.{}", parts[0], evil, parts[2])
        };
        assert_eq!(perm::decode(&forged).unwrap_err(), Reason::BadSignature);

        // 다른 secret 으로 서명된 토큰.
        let other = jwt::sign("apisix-manage", "not-our-secret", Some(NBF), Some(EXP)).unwrap();
        assert_eq!(perm::decode(&other.token).unwrap_err(), Reason::BadSignature);

        // key 가 다르다 — 서명은 맞지만 우리 관리 토큰이 아니다.
        // (`jwt::sign` 은 perm 을 싣지 않으므로 key 검사가 먼저 걸리는지도 함께 본다)
        let wrong_key =
            jwt::sign("someone-else", crate::perm::ADMIN_SECRET, Some(NBF), Some(EXP)).unwrap();
        assert_eq!(perm::decode(&wrong_key.token).unwrap_err(), Reason::BadKey);

        // JWT 가 아예 아니다 — 예전 평문 X-API-KEY.
        assert_eq!(perm::decode("edd1c9f034335f136f87ad84b625c8f1").unwrap_err(), Reason::NotJwt);
        assert_eq!(perm::decode("a.b").unwrap_err(), Reason::NotJwt);
        assert_eq!(perm::decode("").unwrap_err(), Reason::NotJwt);

        // alg=none 은 서명 검증 전에 걷어낸다.
        let none_alg = {
            use base64::engine::general_purpose::URL_SAFE_NO_PAD;
            use base64::Engine;
            let h = URL_SAFE_NO_PAD.encode(r#"{"alg":"none","typ":"JWT"}"#);
            let p = URL_SAFE_NO_PAD.encode(r#"{"key":"apisix-manage","nbf":0,"exp":9,"perm":"admin"}"#);
            format!("{h}.{p}.x")
        };
        assert_eq!(perm::decode(&none_alg).unwrap_err(), Reason::NotJwt);
    }

    /// 유효기간은 `decode` 가 아니라 `at` 이 본다 — 만료된 토큰도 설정 화면에서
    /// 시작일·종료일을 보여 줘야 하기 때문이다.
    #[test]
    fn validity_window_is_checked_at_use_time() {
        let c = perm::decode(&admin_token()).unwrap();
        assert_eq!(perm::at(&c, NBF - 1), Perm::None(Reason::NotYet));
        assert_eq!(perm::at(&c, NBF), Perm::Admin, "시작일 정각은 유효하다");
        assert_eq!(perm::at(&c, MID), Perm::Admin);
        assert_eq!(perm::at(&c, EXP), Perm::None(Reason::Expired), "종료 정각은 만료다");
        assert_eq!(perm::at(&c, EXP + 1), Perm::None(Reason::Expired));
    }

    #[test]
    fn wont_issue_a_token_nobody_can_use() {
        assert!(jwt::sign_admin(EXP, NBF, &Perm::Admin).is_err(), "종료 < 시작");
        assert!(jwt::sign_admin(NBF, NBF, &Perm::Admin).is_err(), "종료 = 시작");
        assert!(
            jwt::sign_admin(NBF, EXP, &Perm::Services(vec![])).is_err(),
            "권한 service 가 없으면 아무것도 못 하는 토큰이다"
        );
    }

    #[test]
    fn allows_and_allow_blob_agree() {
        let admin = Perm::Admin;
        let scoped = Perm::Services(vec!["svc-a".into(), "svc-b".into()]);
        let empty = Perm::Services(vec![]);
        let none = Perm::None(Reason::Expired);

        assert!(admin.is_admin() && !scoped.is_admin() && !none.is_admin());

        assert!(admin.allows("anything") && admin.allows(""));
        assert!(scoped.allows("svc-a") && scoped.allows("svc-b"));
        assert!(!scoped.allows("svc-c"), "목록에 없는 service");
        assert!(!scoped.allows("svc"), "접두사만 같은 id 가 걸리면 안 된다");
        assert!(!scoped.allows(""), "service 없는 라우트");
        assert!(!empty.allows("svc-a") && !none.allows("svc-a"));

        // 허용목록 문자열 — 빈 문자열이 '제한 없음' 이다 (db::SERVICE_CLAUSE).
        assert_eq!(admin.allow_blob(), "");
        assert_eq!(scoped.allow_blob(), "\nsvc-a\nsvc-b\n");
        assert_eq!(empty.allow_blob(), "\n", "무엇과도 맞지 않는 값");
        assert_eq!(none.allow_blob(), "\n");
    }

    /// `perm` 클레임이 문자열도 배열도 아니거나 배열에 문자열이 아닌 것이 섞이면 거부한다 —
    /// 조용히 넓게/좁게 해석하는 쪽 모두 위험하다.
    #[test]
    fn rejects_malformed_perm_claim() {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        use hmac::{Hmac, Mac};
        use sha2::Sha256;

        let sign = |payload: &str| {
            let h = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
            let p = URL_SAFE_NO_PAD.encode(payload);
            let input = format!("{h}.{p}");
            let mut mac =
                Hmac::<Sha256>::new_from_slice(crate::perm::ADMIN_SECRET.as_bytes()).unwrap();
            mac.update(input.as_bytes());
            format!("{input}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
        };

        for bad in [
            r#"{"key":"apisix-manage","nbf":0,"exp":9,"perm":"superuser"}"#,
            r#"{"key":"apisix-manage","nbf":0,"exp":9,"perm":true}"#,
            r#"{"key":"apisix-manage","nbf":0,"exp":9,"perm":["ok",7]}"#,
            r#"{"key":"apisix-manage","nbf":0,"exp":9}"#,
            r#"{"key":"apisix-manage","exp":9,"perm":"admin"}"#,
        ] {
            assert_eq!(
                perm::decode(&sign(bad)).unwrap_err(),
                Reason::NotJwt,
                "거부되어야 한다: {bad}"
            );
        }

        // 배열은 비어 있어도 유효한 클레임이다 — '권한 service 0개' 는 표현 가능한 상태다.
        let c = perm::decode(&sign(r#"{"key":"apisix-manage","nbf":0,"exp":9,"perm":[]}"#)).unwrap();
        assert_eq!(c.perm, Perm::Services(vec![]));
    }
}

// ── 5. baseUrl 정규화 ────────────────────────────────────────

#[test]
fn admin_base_normalizes_input() {
    use crate::config::EnvConfig;

    let mk = |u: &str| EnvConfig {
        base_url: u.into(),
        no_proxy: true,
        insecure_tls: true,
    };

    assert_eq!(
        mk("https://gw.internal.sds:9180").admin_base().unwrap(),
        "https://gw.internal.sds:9180/apisix/admin"
    );
    // 끝의 슬래시
    assert_eq!(
        mk("https://gw.internal.sds:9180/").admin_base().unwrap(),
        "https://gw.internal.sds:9180/apisix/admin"
    );
    // 스킴 생략 → https 로 보정
    assert_eq!(
        mk("gw.internal.sds:9180").admin_base().unwrap(),
        "https://gw.internal.sds:9180/apisix/admin"
    );
    // 사용자가 실수로 경로까지 넣은 경우 중복되지 않는다
    assert_eq!(
        mk("https://gw.internal.sds:9180/apisix/admin").admin_base().unwrap(),
        "https://gw.internal.sds:9180/apisix/admin"
    );
    assert!(mk("   ").admin_base().is_err());
}

/// 예전 `settings.json` 에 `false` 로 저장돼 있던 토글 2종이 **읽을 때** 켜진다.
///
/// 저장 시점에만 강제하면, 앱을 업데이트하고 설정을 한 번도 저장하지 않은 사용자는
/// 계속 프록시를 타거나 인증서 검증에 걸려 연결이 안 되는데 화면에는 그 토글이 없어서
/// 원인을 알 방법이 없다 (`config.rs` 모듈 주석).
#[test]
fn stored_toggles_are_forced_on_when_read() {
    use crate::config::Settings;

    let legacy = json!({
        "dev":  { "baseUrl": "http://dev:9080",  "noProxy": false, "insecureTls": false },
        "prod": { "baseUrl": "http://prod:7096", "noProxy": true,  "insecureTls": false },
    });
    let mut s: Settings = serde_json::from_value(legacy).expect("예전 설정 형식을 읽을 수 있어야 한다");
    s.force_toggles();

    for cfg in [&s.dev, &s.prod] {
        assert!(cfg.no_proxy, "프록시 우회는 항상 켜져 있어야 한다");
        assert!(cfg.insecure_tls, "인증서 검증 건너뛰기는 항상 켜져 있어야 한다");
    }
    // baseUrl 은 사용자 값이므로 손대지 않는다.
    assert_eq!(s.dev.base_url, "http://dev:9080");
    assert_eq!(s.prod.base_url, "http://prod:7096");

    // 기본값도 같다 — 설정 화면 placeholder 와 짝을 맞춘 사내 주소가 들어 있다.
    let d = Settings::default();
    assert_eq!(d.dev.base_url, "http://60.101.107.90:9080");
    assert_eq!(d.prod.base_url, "http://60.101.207.91:7096");
    assert!(d.dev.no_proxy && d.dev.insecure_tls);
    assert!(d.prod.no_proxy && d.prod.insecure_tls);
}

// ── 6. 에러 분류 ─────────────────────────────────────────────

#[test]
fn http_status_maps_to_actionable_error() {
    use crate::error::{AppError, ErrorKind};

    let e = AppError::from_status(401, "");
    assert_eq!(e.kind, ErrorKind::Unauthorized);
    assert!(e.hint.is_some());

    let e = AppError::from_status(404, "");
    assert_eq!(e.kind, ErrorKind::NotFound);

    // APISIX 의 error_msg 를 그대로 사용자에게 보여준다.
    let e = AppError::from_status(400, r#"{"error_msg":"invalid configuration: failed to check"}"#);
    assert_eq!(e.kind, ErrorKind::BadRequest);
    assert_eq!(e.message, "invalid configuration: failed to check");

    let e = AppError::from_status(503, "upstream down");
    assert_eq!(e.kind, ErrorKind::Gateway);
    assert!(e.message.contains("503"));
}

// ── 7. OAS 파싱 ──────────────────────────────────────────────

mod oas_parse {
    use crate::oas;

    /// 최소한의 정상 OAS 3.0 문서.
    const SPEC: &str = r#"
openapi: 3.0.3
info:
  title: Pet Store
  version: "1.2.0"
servers:
  - url: https://api.example.com/v1
paths:
  /pets:
    get:
      operationId: listPets
      summary: 목록 조회
      tags: [pets]
      responses:
        "200": { description: ok }
    post:
      operationId: createPet
      responses:
        "201": { description: created }
  /pets/{petId}:
    get:
      operationId: getPet
      responses:
        "200": { description: ok }
    parameters:
      - name: petId
        in: path
        required: true
        schema: { type: string }
"#;

    fn find<'a>(doc: &'a oas::OasDoc, method: &str, path: &str) -> &'a oas::OasOp {
        doc.ops
            .iter()
            .find(|o| o.method == method && o.path == path)
            .unwrap_or_else(|| panic!("{method} {path} 를 찾지 못했다"))
    }

    #[test]
    fn extracts_paths_methods_and_metadata() {
        let doc = oas::parse(SPEC).expect("정상 스펙은 파싱되어야 한다");

        assert_eq!(doc.title, "Pet Store");
        assert_eq!(doc.version, "1.2.0");
        // servers 의 경로 부분만 접두사로 쓴다 (호스트는 게이트웨이가 대신한다).
        assert_eq!(doc.server_prefix, "/v1");
        assert!(doc.warning.is_none(), "엄격 파싱이 성공했으면 경고가 없어야 한다");

        assert_eq!(doc.ops.len(), 3, "path 아래 parameters 는 오퍼레이션이 아니다");

        let op = find(&doc, "GET", "/pets");
        assert_eq!(op.operation_id, "listPets");
        assert_eq!(op.summary, "목록 조회");
        assert_eq!(op.tags, vec!["pets".to_string()]);

        find(&doc, "POST", "/pets");
        find(&doc, "GET", "/pets/{petId}");
    }

    #[test]
    fn reads_json_spec_and_bare_path_server() {
        // YAML 파서로 JSON 도 읽는다 — 확장자가 .json 인 스펙을 따로 다루지 않는다.
        let doc = oas::parse(
            r#"{"openapi":"3.0.0","info":{"title":"T","version":"1"},
                "servers":[{"url":"/api/v2/"}],
                "paths":{"/a":{"delete":{"operationId":"delA"}}}}"#,
        )
        .expect("JSON 스펙");

        assert_eq!(doc.server_prefix, "/api/v2", "끝의 / 는 떼어 낸다");
        assert_eq!(doc.ops.len(), 1);
        assert_eq!(doc.ops[0].method, "DELETE");
    }

    #[test]
    fn server_prefix_is_dropped_when_templated() {
        // {basePath} 가 남아 있으면 게이트웨이 uri 와 맞을 수 없으므로 쓰지 않는다.
        let doc = oas::parse(
            r#"{"openapi":"3.0.0","info":{},"servers":[{"url":"https://h/{basePath}"}],
                "paths":{"/a":{"get":{}}}}"#,
        )
        .expect("파싱");
        assert_eq!(doc.server_prefix, "");
    }

    #[test]
    fn falls_back_when_schema_is_violated() {
        // `type: [string, null]` 은 3.1 문법이라 3.0 타입 모델에서 거부된다.
        // 그래도 경로·메서드 비교는 되어야 한다 — 스펙 한 줄에 Import 전체가 막히면 안 된다.
        let spec = r#"
openapi: 3.0.1
info: { title: Loose, version: "1" }
paths:
  /things:
    get:
      operationId: listThings
      parameters:
        - name: q
          in: query
          schema:
            type: [string, "null"]
"#;
        let doc = oas::parse(spec).expect("폴백으로라도 읽혀야 한다");
        assert!(doc.warning.is_some(), "폴백을 썼으면 사용자에게 알려야 한다");
        assert_eq!(doc.ops.len(), 1);
        assert_eq!(doc.ops[0].method, "GET");
        assert_eq!(doc.ops[0].path, "/things");
        assert_eq!(doc.ops[0].operation_id, "listThings");
    }

    #[test]
    fn rejects_swagger_2_and_non_specs() {
        let e = oas::parse(r#"{"swagger":"2.0","paths":{}}"#).expect_err("swagger 2.0 은 거부");
        assert!(e.message.contains("swagger 2.0"), "무엇이 문제인지 알려야 한다: {}", e.message);

        assert!(oas::parse(r#"{"openapi":"4.0.0","paths":{}}"#).is_err());
        assert!(oas::parse("{}").is_err());
        assert!(oas::parse("").is_err());
        // paths 가 비면 비교할 것이 없다.
        assert!(oas::parse(r#"{"openapi":"3.0.0","paths":{}}"#).is_err());
    }
}

// ── 8. uri 정규화 ────────────────────────────────────────────

#[test]
fn folds_every_path_param_syntax_to_one_shape() {
    use crate::oas;

    // OAS 는 {id}, APISIX 파라미터 라우터는 :id, 와일드카드는 * — 셋 다 같은 자리로 접힌다.
    let a = oas::normalize("/pets/{petId}/toys");
    let b = oas::normalize("/pets/:petId/toys");
    let c = oas::normalize("/pets/*/toys");
    assert_eq!(a.norm, b.norm);
    assert_eq!(b.norm, c.norm);
    assert!(!a.wildcard, "중간의 파라미터는 접두 매칭이 아니다");

    // 끝의 * 만 접두 매칭이다.
    let w = oas::normalize("/pets/*");
    assert!(w.wildcard);
    assert_eq!(w.prefix, "/pets/");

    // /* 는 전체 매칭.
    let all = oas::normalize("/*");
    assert!(all.wildcard);
    assert_eq!(all.prefix, "/");

    // 끝의 / 와 쿼리스트링은 무시하고, 대소문자는 보존한다 (APISIX 는 구분한다).
    assert_eq!(oas::normalize("/Pets/").norm, "/Pets");
    assert_ne!(oas::normalize("/pets").norm, oas::normalize("/Pets").norm);
    assert_eq!(oas::normalize("/pets?x=1").norm, "/pets");
    assert_eq!(oas::normalize("/").norm, "/");
}

#[test]
fn suggests_apisix_uri_from_oas_path() {
    use crate::oas;

    // 마지막 세그먼트의 파라미터는 접두 와일드카드로 둘 수 있다.
    assert_eq!(oas::to_apisix_uri("", "/pets/{petId}"), "/pets/*");
    // 중간 파라미터를 * 로 두면 기본 라우터(radixtree_uri)가 매칭하지 못한다 → :name 을 쓴다.
    assert_eq!(oas::to_apisix_uri("", "/pets/{petId}/toys"), "/pets/:petId/toys");
    assert_eq!(oas::to_apisix_uri("/v1", "/pets"), "/v1/pets");
    assert_eq!(oas::to_apisix_uri("v1/", "/pets/{id}/x"), "/v1/pets/:id/x");
    assert_eq!(oas::join_path("/v1", "/"), "/v1");
    assert_eq!(oas::join_path("", "pets"), "/pets");
}

#[test]
fn builds_rewrite_regex_for_paths_with_params() {
    use crate::oas;

    // 사용자가 준 그대로의 사례. uri 는 `/evcp/Vendor/CMCTB_VENDOR_GRP/*` 이고,
    // 그 `*` 자리를 `(.*)` 가 받아 `$1` 로 upstream 에 넘긴다.
    assert_eq!(
        oas::to_rewrite_regex("/evcp", "/Vendor/CMCTB_VENDOR_GRP/{VNDRCD}"),
        Some((
            "^/evcp/Vendor/CMCTB_VENDOR_GRP/(.*)".into(),
            "/Vendor/CMCTB_VENDOR_GRP/$1".into()
        ))
    );

    // 중간 파라미터는 uri 에서 `:name` 이라 한 세그먼트만 먹는다 → `([^/]+)`.
    assert_eq!(
        oas::to_rewrite_regex("/v1", "/orders/{orderId}/items"),
        Some(("^/v1/orders/([^/]+)/items".into(), "/orders/$1/items".into()))
    );

    // 파라미터가 여럿이면 왼쪽부터 번호를 매긴다. 마지막만 `(.*)` 다.
    assert_eq!(
        oas::to_rewrite_regex("", "/a/{x}/b/{y}"),
        Some(("^/a/([^/]+)/b/(.*)".into(), "/a/$1/b/$2".into()))
    );

    // 접두사가 없어도 치환값은 같다 — upstream 이 아는 경로에는 접두사가 붙지 않는다.
    assert_eq!(
        oas::to_rewrite_regex("", "/Vendor/GRP/{CD}"),
        Some(("^/Vendor/GRP/(.*)".into(), "/Vendor/GRP/$1".into()))
    );

    // 파라미터가 없으면 정적 문자열 하나로 충분하다 → proxy-rewrite.uri 를 계속 쓴다.
    assert_eq!(oas::to_rewrite_regex("/v1", "/pets"), None);
    assert_eq!(oas::to_rewrite_regex("", "/"), None);
}

#[test]
fn rewrite_regex_escapes_literal_segments() {
    use crate::oas;

    // `.` 를 그대로 두면 `/v1X0/…` 까지 매칭돼 엉뚱한 요청이 rewrite 된다.
    let (from, to) = oas::to_rewrite_regex("/v1.0", "/a.b/{id}").unwrap();
    assert_eq!(from, r"^/v1\.0/a\.b/(.*)");
    assert_eq!(to, "/a.b/$1", "치환값은 이스케이프하지 않는다 — 정규식이 아니다");
}

#[test]
fn route_name_drops_only_a_trailing_param_segment() {
    use crate::oas;

    // 마지막 파라미터는 uri 에서 `*` 가 되어 route 하나가 모든 값을 처리한다.
    // 이름도 실제로 매칭하는 구간까지만 적는다.
    assert_eq!(
        oas::suggested_name("/evcp", "/Vendor/CMCTB_VENDOR_GRP/{VNDRCD}"),
        "EVCP/Vendor/CMCTB_VENDOR_GRP"
    );
    assert_eq!(
        oas::suggested_name_for("EP_", "/v1", "/Vendor/GRP/{CD}"),
        "EP_Vendor/GRP"
    );

    // 중간 파라미터는 그대로 둔다 — 뒤의 정적 세그먼트가 API 를 구분하는 정보다.
    assert_eq!(
        oas::suggested_name("/v1", "/orders/{orderId}/items"),
        "V1/orders/{orderId}/items"
    );

    // 뗀 결과가 또 파라미터로 끝나도 반복해서 떼지 않는다.
    assert_eq!(oas::suggested_name("", "/a/{x}/{y}"), "a/{x}");

    // 떼면 남는 것이 없는 path 는 원본을 유지한다 — 접두사만인 이름을 만들지 않는다.
    assert_eq!(oas::suggested_name("/v1", "/{id}"), "V1/{id}");
    assert_eq!(oas::suggested_name_for("EP_", "/v1", "/{id}"), "EP_{id}");

    // `:id` · `*` 표기도 같은 파라미터로 본다 (`to_apisix_uri` 와 같은 판정).
    assert_eq!(oas::suggested_name("", "/pets/:petId"), "pets");
    assert_eq!(oas::suggested_name("", "/pets/*"), "pets");
}

#[test]
fn derives_route_name_prefix_from_server_path() {
    use crate::oas;

    // 규약: 앞 슬래시를 떼고 · 대문자로 바꾸고 · 뒤에 슬래시를 붙인다.
    assert_eq!(oas::name_prefix("/v1"), "V1/");
    assert_eq!(oas::name_prefix("/v1/api"), "V1/API/");
    assert_eq!(oas::name_prefix("v1"), "V1/", "앞 슬래시가 없어도 같다");
    assert_eq!(oas::name_prefix("/ep/"), "EP/", "뒤 슬래시가 겹치지 않는다");

    // 접두사가 없으면 빈 문자열이다 — "/" 만 남기면 이름이 슬래시로 시작해 버린다.
    assert_eq!(oas::name_prefix(""), "");
    assert_eq!(oas::name_prefix("/"), "");
    assert_eq!(oas::name_prefix("  "), "");
}

#[test]
fn suggests_route_name_from_prefix_and_raw_path() {
    use crate::oas;

    // 이름의 path 표기는 스펙 원본을 유지한다 (uri 와 달리 사람이 읽는 값이다).
    assert_eq!(
        oas::suggested_name("/v1", "/orders/{orderId}/items"),
        "V1/orders/{orderId}/items"
    );
    // 접두사가 없으면 슬래시로 시작하지 않는다.
    assert_eq!(oas::suggested_name("", "/orders"), "orders");

    // APISIX 의 name 은 100자 제한이다. 넘치면 잘라야 하고, 바이트로 자르면 UTF-8
    // 경계가 깨져 저장이 아니라 직렬화가 먼저 터진다 → char 경계에서 자른다.
    let long = format!("/{}", "가".repeat(200));
    let out = oas::suggested_name("/v1", &long);
    assert_eq!(out.chars().count(), oas::MAX_NAME_LEN);
    assert!(out.starts_with("V1/가"));
}

#[test]
fn service_name_prefix_wins_over_path_prefix() {
    use crate::oas;

    // 접두어가 자기 구분자(`/` 또는 `_`)를 들고 있으므로 슬래시를 끼워 넣지 않는다.
    assert_eq!(
        oas::suggested_name_for("EP_", "/v1", "/orders/{orderId}/items"),
        "EP_orders/{orderId}/items"
    );
    assert_eq!(
        oas::suggested_name_for("EP/", "/v1", "/orders/{orderId}/items"),
        "EP/orders/{orderId}/items"
    );

    // 입력한 그대로 쓴다 — 경로 접두사와 달리 대문자로 바꾸지 않는다.
    assert_eq!(oas::suggested_name_for("ep_", "/v1", "/orders"), "ep_orders");

    // 접두어가 없으면(공백뿐이어도) 경로 접두사 규칙으로 떨어진다.
    assert_eq!(oas::suggested_name_for("", "/v1", "/orders"), "V1/orders");
    assert_eq!(oas::suggested_name_for("   ", "/v1", "/orders"), "V1/orders");
    assert_eq!(oas::suggested_name_for("", "", "/orders"), "orders");

    // 100자 절단은 접두어가 어디서 왔든 같은 자리(char 경계)에서 일어난다.
    let long = format!("/{}", "가".repeat(200));
    let out = oas::suggested_name_for("EP_", "/v1", &long);
    assert_eq!(out.chars().count(), oas::MAX_NAME_LEN);
    assert!(out.starts_with("EP_가"));
}

// ── 9. 등록 판정 (내장 SQLite) ───────────────────────────────

mod compare {
    use crate::apisix::models::{RouteView, ServiceView};
    use crate::db;
    use crate::oas::OasOp;
    use rusqlite::Connection;
    use serde_json::json;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("메모리 DB");
        db::init(&c).expect("스키마");
        c
    }

    /// 게이트웨이 응답 모양에서 RouteView 를 만든다 — 실제 경로와 같은 변환을 타게 한다.
    fn route(id: &str, service: &str, uri: serde_json::Value, methods: &[&str]) -> RouteView {
        let mut v = json!({ "id": id, "name": format!("route-{id}"), "service_id": service });
        let obj = v.as_object_mut().unwrap();
        match &uri {
            serde_json::Value::Array(_) => {
                obj.insert("uris".into(), uri.clone());
            }
            _ => {
                obj.insert("uri".into(), uri.clone());
            }
        }
        if !methods.is_empty() {
            obj.insert("methods".into(), json!(methods));
        }
        RouteView::from_value(&v)
    }

    fn op(method: &str, path: &str) -> OasOp {
        OasOp {
            path: path.into(),
            method: method.into(),
            operation_id: String::new(),
            summary: String::new(),
            tags: vec![],
        }
    }

    #[test]
    fn marks_registered_and_unregistered() {
        let c = conn();
        db::sync_routes(
            &c,
            "dev",
            &[
                route("1", "svc", json!("/pets"), &["GET"]),
                route("2", "svc", json!("/pets/*"), &["GET"]),
                // methods 키가 없는 라우트는 APISIX 에서 모든 메서드를 허용한다.
                route("3", "svc", json!("/health"), &[]),
            ],
        )
        .unwrap();

        db::load_oas_ops(
            &c,
            &[
                op("GET", "/pets"),          // 정확 일치 + 메서드 일치
                op("POST", "/pets"),         // uri 는 있으나 메서드가 없다
                op("GET", "/pets/{petId}"),  // 와일드카드로 걸린다
                op("DELETE", "/health"),     // methods 없는 라우트 → 전 메서드 허용
                op("GET", "/orders"),        // 어디에도 없다
            ],
        )
        .unwrap();

        let rows = db::compare(&c, "dev", "svc", "").unwrap();
        assert_eq!(rows.len(), 5, "오퍼레이션마다 정확히 한 행이 나와야 한다");

        assert_eq!(rows[0].state, db::REGISTERED);
        assert_eq!(rows[0].route_id, "1");
        assert!(!rows[0].wildcard);

        // (path, method) 가 API 의 단위다. uri 만 같고 이 메서드를 받지 않는 라우트는 이 API 를
        // 처리하지 않으므로 미등록이다 — 메서드를 끼워 넣을 대상으로 가리키지 않는다.
        assert_eq!(rows[1].state, db::UNREGISTERED);
        assert_eq!(rows[1].route_id, "");
        assert_eq!(rows[1].suggested_uri, "/pets", "신규 등록 후보는 그대로 준다");

        assert_eq!(rows[2].state, db::REGISTERED);
        assert_eq!(rows[2].route_id, "2");
        assert!(rows[2].wildcard, "와일드카드로 걸렸음을 알려야 한다");

        assert_eq!(rows[3].state, db::REGISTERED, "methods 가 없으면 전 메서드 허용");
        assert_eq!(rows[3].route_id, "3");

        assert_eq!(rows[4].state, db::UNREGISTERED);
        assert_eq!(rows[4].route_id, "");
        // 미등록 건은 신규 폼에 채울 uri 후보를 들고 온다.
        assert_eq!(rows[4].suggested_uri, "/orders");
    }

    #[test]
    fn prefers_route_that_allows_the_method() {
        // 정확 일치하지만 메서드가 없는 라우트와, 와일드카드지만 메서드가 맞는 라우트가
        // 함께 있으면 실제 호출은 후자로 흘러간다. "등록됨"이 정직한 답이다.
        let c = conn();
        db::sync_routes(
            &c,
            "dev",
            &[
                route("exact", "svc", json!("/pets/list"), &["GET"]),
                route("wild", "svc", json!("/pets/*"), &["POST"]),
            ],
        )
        .unwrap();
        db::load_oas_ops(&c, &[op("POST", "/pets/list")]).unwrap();

        let rows = db::compare(&c, "dev", "svc", "").unwrap();
        assert_eq!(rows[0].state, db::REGISTERED);
        assert_eq!(rows[0].route_id, "wild");
    }

    #[test]
    fn scopes_to_selected_service_and_env() {
        let c = conn();
        db::sync_routes(&c, "dev", &[route("1", "other-svc", json!("/pets"), &["GET"])]).unwrap();
        db::sync_routes(&c, "prod", &[route("9", "svc", json!("/pets"), &["GET"])]).unwrap();
        db::load_oas_ops(&c, &[op("GET", "/pets")]).unwrap();

        // 다른 service 의 같은 uri 는 이 비교에서 등록으로 볼 수 없다.
        assert_eq!(db::compare(&c, "dev", "svc", "").unwrap()[0].state, db::UNREGISTERED);
        // 다른 환경(prod)의 라우트도 섞이지 않는다.
        assert_eq!(db::compare(&c, "prod", "svc", "").unwrap()[0].state, db::REGISTERED);
    }

    #[test]
    fn applies_path_prefix() {
        let c = conn();
        db::sync_routes(&c, "dev", &[route("1", "svc", json!("/v1/pets"), &["GET"])]).unwrap();
        db::load_oas_ops(&c, &[op("GET", "/pets")]).unwrap();

        // 접두사 없이는 어긋나고, servers 의 /v1 을 붙이면 맞는다.
        assert_eq!(db::compare(&c, "dev", "svc", "").unwrap()[0].state, db::UNREGISTERED);

        let rows = db::compare(&c, "dev", "svc", "/v1").unwrap();
        assert_eq!(rows[0].state, db::REGISTERED);
        assert_eq!(rows[0].full_path, "/v1/pets", "무엇과 비교했는지 보여 준다");
        assert_eq!(rows[0].path, "/pets", "원본 경로도 유지한다");
    }

    #[test]
    fn expands_uris_array() {
        // uris 배열은 행 하나씩 펼쳐야 둘 다 매칭된다. RouteView.uri 는 ", " 로 이어 붙인
        // 표시용 문자열이라 그대로 쓰면 어느 쪽도 맞지 않는다.
        let c = conn();
        db::sync_routes(
            &c,
            "dev",
            &[route("1", "svc", json!(["/a", "/b"]), &["GET"])],
        )
        .unwrap();
        db::load_oas_ops(&c, &[op("GET", "/a"), op("GET", "/b")]).unwrap();

        let rows = db::compare(&c, "dev", "svc", "").unwrap();
        assert_eq!(rows[0].state, db::REGISTERED);
        assert_eq!(rows[1].state, db::REGISTERED);
    }

    /// 등록된 건은 **지금 저장된 값**도 같이 실어 보낸다 — 프런트가 `suggested_*` 와 대조해
    /// "등록돼 있지만 스펙과 값이 다르다"를 판정한다 (`lib/importDiff.ts`).
    #[test]
    fn carries_current_route_values_for_registered_rows() {
        let c = conn();
        let r = RouteView::from_value(&json!({
            "id": "1",
            "name": "주문 목록 조회",
            "uri": "/v1/orders",
            "desc": "예전 설명",
            "status": 0,
            "service_id": "svc",
            "methods": ["GET"],
            "plugins": { "proxy-rewrite": { "uri": "/legacy/orders" } },
        }));
        db::sync_routes(&c, "dev", &[r]).unwrap();
        db::load_oas_ops(
            &c,
            &[OasOp {
                path: "/orders".into(),
                method: "GET".into(),
                operation_id: "listOrders".into(),
                summary: "주문 목록".into(),
                tags: vec![],
            }],
        )
        .unwrap();

        let rows = db::compare(&c, "dev", "svc", "/v1").unwrap();
        let row = &rows[0];
        assert_eq!(row.state, db::REGISTERED);
        assert_eq!(row.route_name, "주문 목록 조회");
        assert_eq!(row.route_uri, "/v1/orders");
        assert_eq!(row.route_desc, "예전 설명");
        assert_eq!(row.route_rewrite, "/legacy/orders");
        assert_eq!(row.route_status, 0);
        // 스펙 후보는 그대로 — 두 쪽이 다르다는 판정은 프런트가 한다.
        assert_eq!(row.suggested_name, "V1/orders");
        assert_eq!(row.suggested_rewrite, "/orders");
    }

    /// 신규 등록 폼의 프리필 세 값은 전부 Rust 가 계산한다 (프런트에서 다시 만들지 않는다).
    #[test]
    fn prefills_name_uri_and_rewrite_for_unregistered_rows() {
        let c = conn();
        db::load_oas_ops(&c, &[op("GET", "/orders/{orderId}/items")]).unwrap();

        let rows = db::compare(&c, "dev", "svc", "/v1").unwrap();
        let r = &rows[0];
        assert_eq!(r.state, db::UNREGISTERED);

        // name — 접두사를 대문자로 바꾼 것 + 접두사를 뗀 원본 path
        assert_eq!(r.suggested_name, "V1/orders/{orderId}/items");
        // uri — 게이트웨이가 매칭할 표기 (접두사 포함, 중간 파라미터는 :name)
        assert_eq!(r.suggested_uri, "/v1/orders/:orderId/items");
        // proxy-rewrite.uri — upstream 이 아는 경로는 접두사가 없는 원본 path 다
        assert_eq!(r.suggested_rewrite, "/orders/{orderId}/items");
        // 파라미터가 있으므로 regex 쌍도 함께 내려간다. 폼은 이쪽을 쓴다 —
        // 위의 suggested_rewrite 를 그대로 저장하면 `{orderId}` 가 리터럴로 upstream 에 간다.
        assert_eq!(
            r.suggested_rewrite_regex,
            ["^/v1/orders/([^/]+)/items", "/orders/$1/items"]
        );
    }

    /// 사용자가 준 사례를 표 전체 경로로 한 번 더 고정한다 (`oas` 단위 테스트와 별개로,
    /// `db::compare` 가 접두사를 regex 에 실제로 실어 보내는지 본다).
    #[test]
    fn prefills_regex_rewrite_for_dynamic_paths() {
        let c = conn();
        db::load_oas_ops(
            &c,
            &[
                op("GET", "/Vendor/CMCTB_VENDOR_GRP/{VNDRCD}"),
                op("POST", "/Vendor/CMCTB_VENDOR_GRP/{VNDRCD}"),
                op("GET", "/Vendor/CMCTB_VENDOR_GRP"),
            ],
        )
        .unwrap();

        let rows = db::compare(&c, "dev", "svc", "/evcp").unwrap();

        // 같은 path 의 GET · POST 는 서로 다른 행(=서로 다른 API)이다.
        for r in rows.iter().take(2) {
            assert_eq!(r.suggested_uri, "/evcp/Vendor/CMCTB_VENDOR_GRP/*");
            assert_eq!(
                r.suggested_rewrite_regex,
                ["^/evcp/Vendor/CMCTB_VENDOR_GRP/(.*)", "/Vendor/CMCTB_VENDOR_GRP/$1"]
            );
            // 마지막 파라미터를 뗀 이름이라 두 행의 name 이 같아진다 (화면이 경고한다).
            assert_eq!(r.suggested_name, "EVCP/Vendor/CMCTB_VENDOR_GRP");
        }
        assert_eq!(rows[0].method, "GET");
        assert_eq!(rows[1].method, "POST");

        // 파라미터가 없는 path 는 예전 그대로 — 정적 rewrite 를 쓴다.
        let plain = &rows[2];
        assert!(plain.suggested_rewrite_regex.is_empty());
        assert_eq!(plain.suggested_rewrite, "/Vendor/CMCTB_VENDOR_GRP");
        assert_eq!(plain.suggested_name, "EVCP/Vendor/CMCTB_VENDOR_GRP");
    }

    #[test]
    fn prefill_follows_the_prefix_field() {
        let c = conn();
        db::load_oas_ops(&c, &[op("POST", "/orders")]).unwrap();

        // 접두사를 비우면 이름에도 접두사가 없고, rewrite 는 접두사와 무관하게 그대로다.
        let none = db::compare(&c, "dev", "svc", "").unwrap();
        assert_eq!(none[0].suggested_name, "orders");
        assert_eq!(none[0].suggested_uri, "/orders");
        assert_eq!(none[0].suggested_rewrite, "/orders");

        let ep = db::compare(&c, "dev", "svc", "/ep").unwrap();
        assert_eq!(ep[0].suggested_name, "EP/orders");
        assert_eq!(ep[0].suggested_uri, "/ep/orders");
        assert_eq!(ep[0].suggested_rewrite, "/orders", "접두사가 붙지 않는다");
    }

    /// 고른 service 의 `labels.name_prefix` 는 경로 접두사를 **이름에 한해서만** 이긴다.
    #[test]
    fn service_name_prefix_overrides_the_path_prefix() {
        let c = conn();
        db::load_oas_ops(&c, &[op("GET", "/orders/{orderId}/items")]).unwrap();
        db::sync_services(
            &c,
            "dev",
            &[
                ServiceView::from_value(
                    &json!({ "id": "svc-ep", "labels": { "name_prefix": "EP_" } }),
                    &[],
                ),
                ServiceView::from_value(&json!({ "id": "svc-plain" }), &[]),
            ],
        )
        .unwrap();

        let ep = db::compare(&c, "dev", "svc-ep", "/v1").unwrap();
        assert_eq!(ep[0].suggested_name, "EP_orders/{orderId}/items");
        // uri · rewrite 는 접두어와 무관하게 경로 접두사 규칙 그대로다.
        assert_eq!(ep[0].suggested_uri, "/v1/orders/:orderId/items");
        assert_eq!(ep[0].suggested_rewrite, "/orders/{orderId}/items");

        // 접두어가 없는 service 는 지금까지의 규칙 그대로다.
        let plain = db::compare(&c, "dev", "svc-plain", "/v1").unwrap();
        assert_eq!(plain[0].suggested_name, "V1/orders/{orderId}/items");

        // 캐시에 없는 service 도 같은 쪽으로 degrade 한다 (동기화 전에 비교를 돌린 경우).
        let unknown = db::compare(&c, "dev", "svc-none", "/v1").unwrap();
        assert_eq!(unknown[0].suggested_name, "V1/orders/{orderId}/items");
    }
}

// ── 10. 목록 검색 (내장 SQLite) ──────────────────────────────

#[test]
fn sqlite_search_and_counts_replace_the_old_array_filter() {
    use crate::apisix::models::RouteView;
    use crate::db;
    use rusqlite::Connection;

    const ALL: db::RouteScope = db::RouteScope::All;

    let c = Connection::open_in_memory().unwrap();
    db::init(&c).unwrap();

    let mk = |id: &str, name: &str, uri: &str, status: i64| {
        RouteView::from_value(&json!({
            "id": id, "name": name, "uri": uri, "status": status,
            "service_id": "svc", "methods": ["GET"],
        }))
    };
    db::sync_routes(
        &c,
        "dev",
        &[
            mk("1", "order-api", "/orders", 1),
            mk("2", "pet-api", "/pets", 1),
            mk("3", "legacy-api", "/legacy_v1/x", 0),
        ],
    )
    .unwrap();

    // 검색어 없음 → 전체, 원래 순서 유지.
    let page = db::query_routes(&c, "dev", "all", "", "", &ALL, "").unwrap();
    assert_eq!(page.total, 3);
    assert_eq!(page.items.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["1", "2", "3"]);

    // 예전 필터가 JSON 전체를 훑었으므로 name·uri 어느 쪽으로도 잡혀야 한다.
    assert_eq!(db::query_routes(&c, "dev", "all", "pet", "", &ALL, "").unwrap().total, 1);
    assert_eq!(db::query_routes(&c, "dev", "all", "/orders", "", &ALL, "").unwrap().total, 1);
    assert_eq!(db::query_routes(&c, "dev", "all", "API", "", &ALL, "").unwrap().total, 3, "대소문자 무시");

    // '_' 가 LIKE 의 단일문자 와일드카드로 해석되면 안 된다.
    assert_eq!(db::query_routes(&c, "dev", "all", "legacy_v1", "", &ALL, "").unwrap().total, 1);
    assert_eq!(db::query_routes(&c, "dev", "all", "legacyXv1", "", &ALL, "").unwrap().total, 0);

    // chip 은 status 로 나눈다.
    assert_eq!(db::query_routes(&c, "dev", "on", "", "", &ALL, "").unwrap().total, 2);
    assert_eq!(db::query_routes(&c, "dev", "off", "", "", &ALL, "").unwrap().total, 1);

    // counts 는 chip 을 빼고 검색어만 반영한다 — chip 을 눌러도 라벨 숫자가 흔들리지 않아야 한다.
    let page = db::query_routes(&c, "dev", "off", "", "", &ALL, "").unwrap();
    assert_eq!((page.counts.all, page.counts.on, page.counts.off), (3, 2, 1));
    let page = db::query_routes(&c, "dev", "all", "api", "", &ALL, "").unwrap();
    assert_eq!((page.counts.all, page.counts.on, page.counts.off), (3, 2, 1));

    // 단건 조회 (Import 결과 → 상세 이동 경로).
    assert_eq!(db::route_view(&c, "dev", "2").unwrap().unwrap().name, "pet-api");
    assert!(db::route_view(&c, "dev", "nope").unwrap().is_none());

    // 재동기화는 전체 교체다 — 게이트웨이에서 사라진 라우트가 남으면 Import 가 잘못 판정한다.
    db::sync_routes(&c, "dev", &[mk("1", "order-api", "/orders", 1)]).unwrap();
    assert_eq!(db::query_routes(&c, "dev", "all", "", "", &ALL, "").unwrap().total, 1);
    assert!(db::route_view(&c, "dev", "2").unwrap().is_none());
}

/// name 접두사는 검색어와 **다른 축**이다 — 이름이 그 문자열로 시작하는가만 본다.
#[test]
fn name_prefix_filters_by_start_of_name() {
    use crate::apisix::models::RouteView;
    use crate::db;
    use rusqlite::Connection;

    const ALL: db::RouteScope = db::RouteScope::All;

    let c = Connection::open_in_memory().unwrap();
    db::init(&c).unwrap();

    let mk = |id: &str, name: &str, status: i64| {
        RouteView::from_value(&json!({
            "id": id, "name": name, "uri": "/x", "status": status,
            "service_id": "svc", "methods": ["GET"],
        }))
    };
    db::sync_routes(
        &c,
        "dev",
        &[
            mk("1", "EP_orders", 1),
            mk("2", "EP_pets", 0),
            mk("3", "EPXother", 1),
            mk("4", "V1/orders", 1),
            mk("5", "legacy-EP_orders", 1),
        ],
    )
    .unwrap();

    let ids = |pfx: &str| -> Vec<String> {
        db::query_routes(&c, "dev", "all", "", pfx, &ALL, "")
            .unwrap()
            .items
            .iter()
            .map(|r| r.id.clone())
            .collect()
    };

    // 빈 값은 "조건 없음" 이다.
    assert_eq!(ids("").len(), 5);

    // 접두사로 시작하는 것만. `_` 를 LIKE 의 단일문자 와일드카드로 읽으면 EPXother 가 딸려 온다.
    assert_eq!(ids("EP_"), ["1", "2"]);
    // 이름 **중간**에 들어간 접두사는 걸리지 않는다 (검색어 축과 갈리는 지점).
    assert!(!ids("EP_").contains(&"5".to_string()));
    assert_eq!(ids("V1/"), ["4"]);

    // 대소문자는 무시한다 — 경로에서 파생한 접두어(V1/)와 사용자가 등록한 것(ep_)이 섞인다.
    assert_eq!(ids("ep_"), ["1", "2"]);
    assert_eq!(ids("  EP_  "), ["1", "2"], "앞뒤 공백은 다듬는다");

    // 다른 축과는 AND 로 걸린다.
    assert_eq!(db::query_routes(&c, "dev", "on", "", "EP_", &ALL, "").unwrap().total, 1);
    assert_eq!(db::query_routes(&c, "dev", "all", "pets", "EP_", &ALL, "").unwrap().total, 1);
    assert_eq!(db::query_routes(&c, "dev", "all", "orders", "V1/", &ALL, "").unwrap().total, 1);

    // counts 는 chip 만 빼고 접두사는 반영한다. 반영하지 않으면 `?5` 가 여기서 바인딩되지 않아
    // rusqlite 가 InvalidParameterCount 를 던진다 — 이 assert 가 그것까지 잡는다.
    let page = db::query_routes(&c, "dev", "on", "", "EP_", &ALL, "").unwrap();
    assert_eq!((page.counts.all, page.counts.on, page.counts.off), (2, 1, 1));
}

// ── 10-b. 관리 권한으로 조회 좁히기 (SERVICE_CLAUSE) ─────────

/// 관리 토큰이 특정 service 만 담고 있으면 Route 조회의 모든 숫자가 그 범위로 좁아진다.
///
/// 목록 · chip 건수 · 좌측 패널 집계 · 대시보드 KPI 가 각자 다른 쿼리라, 하나만 좁히면
/// 화면들이 서로 다른 답을 한다. 그 네 곳을 한 테스트에서 함께 본다.
#[test]
fn service_allowlist_narrows_every_route_count() {
    use crate::apisix::models::{ConsumerView, RouteView};
    use crate::db;
    use crate::perm::{Perm, Reason};
    use rusqlite::Connection;

    const ALL: db::RouteScope = db::RouteScope::All;

    let c = Connection::open_in_memory().unwrap();
    db::init(&c).unwrap();

    // svc-a 2건(1 활성 · 1 비활성) · svc-b 1건. 넷째는 service 도 권한그룹도 없는 라우트다
    // — '그룹 제한 없음' 축과 허용목록이 겹칠 때를 보기 위한 것이다.
    let mk = |id: &str, name: &str, svc: &str, status: i64| {
        RouteView::from_value(&json!({
            "id": id, "name": name, "uri": format!("/{name}"), "status": status,
            "service_id": svc, "methods": ["GET"],
            "plugins": { "shi-auth": { "allowed_groups": ["g1"] } },
        }))
    };
    let orphan = RouteView::from_value(&json!({
        "id": "4", "name": "orphan", "uri": "/orphan", "status": 1,
        "service_id": "", "methods": ["GET"],
    }));
    db::sync_routes(
        &c,
        "dev",
        &[
            mk("1", "a-on", "svc-a", 1),
            mk("2", "a-off", "svc-a", 0),
            mk("3", "b-on", "svc-b", 1),
            orphan,
        ],
    )
    .unwrap();
    db::sync_consumers(
        &c,
        "dev",
        &[ConsumerView::from_value(&json!({
            "username": "u",
            "plugins": { "shi-auth": { "auth_groups": ["g1"] } },
        }))],
    )
    .unwrap();

    let blob = |p: &Perm| p.allow_blob();
    let admin = blob(&Perm::Admin);
    let only_a = blob(&Perm::Services(vec!["svc-a".into()]));
    let a_and_b = blob(&Perm::Services(vec!["svc-a".into(), "svc-b".into()]));
    let nothing = blob(&Perm::Services(vec![]));
    let expired = blob(&Perm::None(Reason::Expired));

    let total = |allow: &str| db::query_routes(&c, "dev", "all", "", "", &ALL, allow).unwrap().total;

    // 전체 관리자는 제한이 없다 — service 없는 라우트까지 본다.
    assert_eq!(total(&admin), 4);
    assert_eq!(total(&only_a), 2);
    assert_eq!(total(&a_and_b), 3, "service 없는 4번은 빠진다");

    // 권한이 하나도 없으면 0건이어야 한다. 특히 service 없는 라우트가 새어 나오면 안 된다
    // — 빈 허용목록의 바늘(`"\n\n"`)이 곧 그 라우트의 바늘이라 실수하기 쉬운 자리다.
    assert_eq!(total(&nothing), 0);
    assert_eq!(total(&expired), 0);

    // 목록에 없는 service 로 걸러도 0건 (접두사만 같은 id 가 걸리는지도 함께 본다).
    assert_eq!(total(&blob(&Perm::Services(vec!["svc".into()]))), 0);
    assert_eq!(total(&blob(&Perm::Services(vec!["svc-c".into()]))), 0);

    // chip 건수는 목록과 같은 범위여야 한다 — svc-a 는 활성 1 · 비활성 1.
    let page = db::query_routes(&c, "dev", "on", "", "", &ALL, &only_a).unwrap();
    assert_eq!(page.total, 1, "chip=on 은 활성만");
    assert_eq!((page.counts.all, page.counts.on, page.counts.off), (2, 1, 1));

    // 검색어·접두사와 함께 걸려도 축이 서로를 지우지 않는다.
    assert_eq!(db::query_routes(&c, "dev", "all", "b-on", "", &ALL, &only_a).unwrap().total, 0);
    assert_eq!(db::query_routes(&c, "dev", "all", "", "A-", &ALL, &only_a).unwrap().total, 2);

    // 좌측 패널 집계도 같은 범위다.
    let acc = db::consumer_access_counts(&c, "dev", &admin).unwrap();
    assert_eq!((acc.all, acc.ungrouped), (4, 1));
    let acc = db::consumer_access_counts(&c, "dev", &only_a).unwrap();
    assert_eq!(acc.all, 2);
    assert_eq!(acc.ungrouped, 0, "그룹 없는 4번은 service 도 없어 권한 밖이다");
    assert_eq!(acc.items[0].count, 2, "g1 로 svc-a 두 건에 접근한다");
    let acc = db::consumer_access_counts(&c, "dev", &nothing).unwrap();
    assert_eq!((acc.all, acc.ungrouped), (0, 0));
    assert_eq!(acc.items.len(), 1, "접근 가능 라우트가 0이어도 컨슈머는 목록에 남는다");
    assert_eq!(acc.items[0].count, 0);

    // 대시보드 KPI 도 같은 범위다 (컨슈머 건수는 좁히지 않는다).
    let o = db::overview_counts(&c, "dev", &only_a).unwrap();
    assert_eq!((o.routes, o.routes_active, o.routes_inactive), (2, 1, 1));
    assert_eq!(o.consumers, 1);
    let o = db::overview_counts(&c, "dev", &admin).unwrap();
    assert_eq!(o.routes, 4);

    // '그룹 제한 없음' 축과 겹쳐도 허용목록이 살아 있다 — 4번만 그룹이 없다.
    let ung = db::query_routes(&c, "dev", "all", "", "", &db::RouteScope::Ungrouped, &admin)
        .unwrap();
    assert_eq!(ung.total, 1);
    let ung = db::query_routes(&c, "dev", "all", "", "", &db::RouteScope::Ungrouped, &a_and_b)
        .unwrap();
    assert_eq!(ung.total, 0, "그룹 없는 라우트는 service 도 없어 권한 밖이다");
}

// ── 11. 담당자 (labels · name{n} / dept{n}) ──────────────────

#[test]
fn contacts_parse_from_labels() {
    use crate::apisix::models::ConsumerView;

    let v = json!({
        "username": "partner_alpha",
        "labels": {
            // 짝이 맞는 쌍
            "name1": "김철수",  "dept1": "플랫폼",
            // name 만
            "name2": "이영희",
            // dept 만
            "dept3": "결제",
            // 두 자리 — 문자열 정렬이면 name2 앞으로 오는 자리다
            "name10": "박민수", "dept10": "인증",
            // 우리 키가 아닌 것들 — 앞자리 0 · 0번 · 숫자 아님 · 접미사 없음
            "name01": "무시", "name0": "무시", "nameX": "무시", "name": "무시",
            // 관계없는 라벨
            "env": "prod",
            // 빈 값
            "name4": ""
        }
    });

    let c = ConsumerView::from_value(&v);
    let got: Vec<(&str, &str)> =
        c.contacts.iter().map(|x| (x.name.as_str(), x.dept.as_str())).collect();

    // 숫자 순으로 정렬된다 — name10 이 name2 뒤다.
    assert_eq!(got, vec![("김철수", "플랫폼"), ("이영희", ""), ("", "결제"), ("박민수", "인증")]);
}

#[test]
fn contacts_write_back_preserves_other_labels() {
    use crate::apisix::consumers::{apply_consumer_form_for_test, ConsumerForm};
    use crate::apisix::models::Contact;

    let existing = json!({
        "username": "u",
        "labels": { "env": "prod", "name1": "김철수", "dept1": "플랫폼", "name2": "이영희" },
        "plugins": { "jwt-auth": { "key": "k", "secret": "s" } }
    });

    let form = ConsumerForm {
        username: "u".into(),
        desc: String::new(),
        key: "k".into(),
        secret: "s".into(),
        groups: vec![],
        is_new: false,
        groups_location: None,
        contacts: Some(vec![Contact { name: "박민수".into(), dept: "결제".into() }]),
    };

    let body = apply_consumer_form_for_test(existing, &form);
    let labels = body.get("labels").unwrap();

    assert_eq!(labels.get("name1").unwrap(), "박민수");
    assert_eq!(labels.get("dept1").unwrap(), "결제");
    // 남아 있던 두 번째 담당자는 사라지고,
    assert!(labels.get("name2").is_none());
    // 우리 것이 아닌 라벨은 그대로다.
    assert_eq!(labels.get("env").unwrap(), "prod");
}

#[test]
fn contacts_renumber_densely_and_allow_dept_only() {
    use crate::apisix::consumers::{apply_consumer_form_for_test, ConsumerForm};
    use crate::apisix::models::Contact;

    let form = ConsumerForm {
        username: "u".into(),
        desc: String::new(),
        key: "k".into(),
        secret: "s".into(),
        groups: vec![],
        is_new: true,
        groups_location: None,
        contacts: Some(vec![
            Contact { name: "A".into(), dept: String::new() },
            Contact { name: String::new(), dept: "B".into() },
            // 완전히 빈 행은 버린다 (그리드에서 행만 추가하고 안 채운 경우)
            Contact::default(),
        ]),
    };

    let body = apply_consumer_form_for_test(json!({}), &form);
    let labels = body.get("labels").unwrap().as_object().unwrap();

    // minLength = 1 이라 빈 값은 "" 가 아니라 키를 생략한다.
    assert_eq!(labels.len(), 2, "{labels:?}");
    assert_eq!(labels.get("name1").unwrap(), "A");
    assert_eq!(labels.get("dept2").unwrap(), "B");
    assert!(labels.get("dept1").is_none());
    assert!(labels.get("name2").is_none());
}

#[test]
fn empty_contacts_removes_the_labels_key() {
    use crate::apisix::consumers::{apply_consumer_form_for_test, ConsumerForm};

    let mk = |contacts| ConsumerForm {
        username: "u".into(),
        desc: String::new(),
        key: "k".into(),
        secret: "s".into(),
        groups: vec![],
        is_new: false,
        groups_location: None,
        contacts,
    };

    // 담당자 라벨만 있던 경우 → labels 키 자체가 사라진다 ("labels": {} 를 남기지 않는다)
    let only = json!({ "username": "u", "labels": { "name1": "김철수" } });
    let body = apply_consumer_form_for_test(only, &mk(Some(vec![])));
    assert!(body.get("labels").is_none(), "{body}");

    // 다른 라벨이 함께 있으면 labels 는 살아남고 그 라벨만 남는다.
    let mixed = json!({ "username": "u", "labels": { "env": "prod", "name1": "김철수" } });
    let body = apply_consumer_form_for_test(mixed, &mk(Some(vec![])));
    let labels = body.get("labels").unwrap().as_object().unwrap();
    assert_eq!(labels.len(), 1);
    assert_eq!(labels.get("env").unwrap(), "prod");
}

/// `contacts: None` 은 "미지정" 이고 "전부 삭제" 가 아니다.
///
/// api.ts 의 consumerSave 는 필드를 하나씩 나열하는 객체 리터럴이라 한 줄만 빠뜨려도
/// 이 경로를 타게 된다. 그때 게이트웨이의 담당자 라벨이 지워지면 되돌릴 방법이 없다.
#[test]
fn contacts_none_preserves_existing_labels() {
    use crate::apisix::consumers::{apply_consumer_form_for_test, ConsumerForm};

    let existing = json!({
        "username": "u",
        "labels": { "env": "prod", "name1": "김철수", "dept1": "플랫폼" }
    });

    let form = ConsumerForm {
        username: "u".into(),
        desc: String::new(),
        key: "k".into(),
        secret: "s".into(),
        groups: vec![],
        is_new: false,
        groups_location: None,
        contacts: None,
    };

    let body = apply_consumer_form_for_test(existing.clone(), &form);
    assert_eq!(body.get("labels").unwrap(), existing.get("labels").unwrap());
}

#[test]
fn rejects_label_value_with_whitespace() {
    use crate::apisix::models::check_label_value;

    // 한글 자체는 문제없다 — `\S` 가 바이트 단위라 한글 바이트는 전부 non-space 다.
    assert!(check_label_value("부서", "플랫폼개발팀").is_ok());

    let e = check_label_value("1행 부서", "플랫폼 개발팀").unwrap_err();
    assert!(e.message.contains("1행 부서"), "{}", e.message);
    assert!(e.message.contains("공백"), "{}", e.message);

    // 길이는 바이트로 센다 (Lua 의 #str).
    assert!(check_label_value("성명", &"가".repeat(85)).is_ok()); // 255 바이트
    assert!(check_label_value("성명", &"가".repeat(86)).is_err()); // 258 바이트
}

// ── 12. 컨슈머 접근 권한 (Route ↔ Consumer 조인) ─────────────

mod access {
    use crate::apisix::models::{ConsumerView, RouteView};
    use crate::db;
    use rusqlite::Connection;
    use serde_json::json;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("메모리 DB");
        db::init(&c).expect("스키마");
        c
    }

    /// 게이트웨이 응답 모양에서 만든다 — find_groups 를 실제로 타게 한다.
    fn route(id: &str, name: &str, status: i64, groups: serde_json::Value) -> RouteView {
        RouteView::from_value(&json!({
            "id": id, "name": name, "uri": format!("/{name}"), "status": status,
            "service_id": "svc", "plugins": { "shi-auth": { "allowed_groups": groups } }
        }))
    }

    fn consumer(username: &str, groups: serde_json::Value) -> ConsumerView {
        ConsumerView::from_value(&json!({
            "username": username,
            "plugins": { "jwt-auth": { "key": username, "secret": "s", "auth_groups": groups } }
        }))
    }

    /// 조회 범위 — 전체 / 컨슈머 한 명 / 그룹 제한 없음.
    const ALL: db::RouteScope = db::RouteScope::All;
    const UNGROUPED: db::RouteScope = db::RouteScope::Ungrouped;
    fn user(username: &str) -> db::RouteScope {
        db::RouteScope::Consumer { username: username.into() }
    }

    /// 3 라우트 · 3 컨슈머로 교집합 판정 전체를 확인한다.
    #[test]
    fn routes_filtered_by_consumer_access() {
        let c = conn();
        db::sync_routes(
            &c,
            "dev",
            &[
                route("1", "partner-api", 1, json!(["partner"])),
                route("2", "ops-api", 0, json!(["ops"])),
                route("3", "open-api", 1, json!([])),
            ],
        )
        .unwrap();
        db::sync_consumers(
            &c,
            "dev",
            &[
                consumer("alpha", json!(["partner"])),
                consumer("beta", json!(["partner", "ops"])),
                consumer("gamma", json!([])),
            ],
        )
        .unwrap();

        let total =
            |scope: &db::RouteScope| db::query_routes(&c, "dev", "all", "", "", scope, "").unwrap().total;

        assert_eq!(total(&ALL), 3, "필터 없으면 전체");
        assert_eq!(total(&user("alpha")), 1);
        assert_eq!(total(&user("beta")), 2);
        assert_eq!(total(&user("gamma")), 0, "그룹이 없는 컨슈머는 아무것도 못 본다");

        // allowed_groups 가 빈 라우트는 어떤 컨슈머로도 걸리지 않는다.
        // (그래서 좌측 패널이 '그룹 제한 없음' 건수를 따로 보여 준다)
        let names: Vec<String> = db::query_routes(&c, "dev", "all", "", "", &user("beta"), "")
            .unwrap()
            .items
            .iter()
            .map(|r| r.name.clone())
            .collect();
        assert_eq!(names, vec!["partner-api", "ops-api"]);
    }

    /// 그룹을 둘 이상 공유해도 라우트는 한 번만 나온다.
    /// EXISTS 세미조인을 평범한 JOIN 으로 "고치면" 이 테스트가 깨진다.
    #[test]
    fn consumer_filter_returns_each_route_once() {
        let c = conn();
        db::sync_routes(&c, "dev", &[route("1", "both", 1, json!(["a", "b"]))]).unwrap();
        db::sync_consumers(&c, "dev", &[consumer("u", json!(["a", "b"]))]).unwrap();

        let page = db::query_routes(&c, "dev", "all", "", "", &user("u"), "").unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.counts.all, 1);
    }

    /// 상단 chip 라벨의 숫자는 chip 은 빼고 컨슈머·검색어는 반영한다.
    /// 컨슈머로 좁혀 2건이 남았는데 chip 이 전체 건수를 말하면 안 된다.
    #[test]
    fn counts_follow_the_selected_consumer_but_not_the_chip() {
        let c = conn();
        db::sync_routes(
            &c,
            "dev",
            &[
                route("1", "partner-on", 1, json!(["partner"])),
                route("2", "partner-off", 0, json!(["partner"])),
                route("3", "ops-on", 1, json!(["ops"])),
            ],
        )
        .unwrap();
        db::sync_consumers(&c, "dev", &[consumer("alpha", json!(["partner"]))]).unwrap();

        // chip 을 눌러도 라벨 숫자는 그대로다.
        for chip in ["all", "on", "off"] {
            let counts = db::query_routes(&c, "dev", chip, "", "", &user("alpha"), "").unwrap().counts;
            assert_eq!((counts.all, counts.on, counts.off), (2, 1, 1), "chip={chip}");
        }
        // 반면 total 은 chip 을 반영한다.
        assert_eq!(db::query_routes(&c, "dev", "on", "", "", &user("alpha"), "").unwrap().total, 1);

        // 검색어도 반영한다.
        let counts = db::query_routes(&c, "dev", "all", "partner-on", "", &user("alpha"), "").unwrap().counts;
        assert_eq!((counts.all, counts.on, counts.off), (1, 1, 0));
    }

    #[test]
    fn consumer_access_counts_are_zero_filled_and_search_independent() {
        let c = conn();
        db::sync_routes(
            &c,
            "dev",
            &[
                route("1", "shared", 1, json!(["a", "b"])),
                route("2", "only-a", 1, json!(["a"])),
                route("3", "open", 1, json!([])),
            ],
        )
        .unwrap();
        db::sync_consumers(
            &c,
            "dev",
            &[
                consumer("both", json!(["a", "b"])),
                consumer("nomatch", json!(["zzz"])),
                consumer("nogroups", json!([])),
            ],
        )
        .unwrap();

        let acc = db::consumer_access_counts(&c, "dev", "").unwrap();
        assert_eq!(acc.all, 3);
        assert_eq!(acc.ungrouped, 1, "allowed_groups 가 빈 라우트");

        let by: std::collections::HashMap<&str, i64> =
            acc.items.iter().map(|i| (i.username.as_str(), i.count)).collect();
        // COUNT(DISTINCT) 증명: 'shared' 는 a·b 두 그룹으로 걸리지만 1건이다.
        assert_eq!(by["both"], 2);
        assert_eq!(by["nomatch"], 0);
        assert_eq!(by["nogroups"], 0, "LEFT JOIN 이라 행 자체는 남는다");
        assert_eq!(acc.items.len(), 3);
    }

    /// 그룹 비교는 대소문자를 구분한다 — 게이트웨이가 요청 시점에 하는 비교와 같아야 한다.
    /// 화면이 "접근 가능"이라 했는데 실제 호출이 403 이면 화면이 깐깐한 것보다 훨씬 나쁘다.
    #[test]
    fn group_matching_is_case_sensitive() {
        let c = conn();
        db::sync_routes(&c, "dev", &[route("1", "r", 1, json!(["Partner"]))]).unwrap();
        db::sync_consumers(&c, "dev", &[consumer("u", json!(["partner"]))]).unwrap();

        assert_eq!(db::query_routes(&c, "dev", "all", "", "", &user("u"), "").unwrap().total, 0);
        assert_eq!(db::consumer_access_counts(&c, "dev", "").unwrap().items[0].count, 0);
    }

    /// to_string_list 는 중복을 제거하지 않는다. 정션 테이블이 OR IGNORE 가 아니면
    /// 이런 컨슈머 하나가 PK 충돌로 sync 트랜잭션 전체를 깨뜨려 목록이 통째로 빈다.
    #[test]
    fn duplicate_groups_do_not_break_sync() {
        let c = conn();
        db::sync_routes(&c, "dev", &[route("1", "r", 1, json!(["ops", "ops"]))]).unwrap();
        // CSV 표기도 같은 경로를 탄다.
        db::sync_consumers(&c, "dev", &[consumer("u", json!("ops, ops"))]).unwrap();

        assert_eq!(db::query_routes(&c, "dev", "all", "", "", &user("u"), "").unwrap().total, 1);
        assert_eq!(db::consumer_access_counts(&c, "dev", "").unwrap().items[0].count, 1);
    }

    /// 캐시의 `view` 열 왕복이 무손실이어야 한다 (ConsumerView: Deserialize).
    #[test]
    fn consumer_cache_round_trips_view() {
        let c = conn();
        let src = ConsumerView::from_value(&json!({
            "username": "partner_alpha",
            "desc": "제휴사 알파",
            "labels": { "env": "prod", "name1": "김철수", "dept1": "플랫폼" },
            "update_time": 1_760_000_000i64,
            "plugins": {
                "jwt-auth": { "key": "k", "secret": "s", "auth-groups": ["partner"] },
                "limit-count": { "count": 100 }
            }
        }));
        db::sync_consumers(&c, "dev", std::slice::from_ref(&src)).unwrap();

        let got = db::consumers_cached(&c, "dev").unwrap();
        assert_eq!(got.len(), 1);
        let g = &got[0];
        assert_eq!(g.username, src.username);
        assert_eq!(g.desc, src.desc);
        assert_eq!(g.key, src.key);
        assert_eq!(g.secret, src.secret);
        assert_eq!(g.has_secret, src.has_secret);
        assert_eq!(g.has_jwt_auth, src.has_jwt_auth);
        assert_eq!(g.groups, src.groups);
        // 비표준 표기(auth-groups)에서 읽은 위치가 그대로 살아남아야 저장이 같은 자리로 간다.
        assert_eq!(g.groups_location, src.groups_location);
        assert_eq!(g.groups_location.key, "auth-groups");
        assert_eq!(g.contacts, src.contacts);
        assert_eq!(g.updated, src.updated);
        // 원본은 통째로 보존된다 — JSON 탭의 '게이트웨이 원본' 이 이걸 그대로 보여 준다.
        assert_eq!(g.raw, src.raw);
    }

    #[test]
    fn consumer_sync_replaces_and_is_env_scoped() {
        let c = conn();
        db::sync_consumers(
            &c,
            "dev",
            &[consumer("a", json!(["x"])), consumer("b", json!(["x"]))],
        )
        .unwrap();
        db::sync_consumers(&c, "prod", &[consumer("p", json!(["x"]))]).unwrap();
        assert_eq!(db::consumers_cached(&c, "dev").unwrap().len(), 2);

        // 재동기화는 전체 교체다 — 게이트웨이에서 지워진 컨슈머가 패널에 남으면 안 된다.
        db::sync_consumers(&c, "dev", &[consumer("a", json!(["x"]))]).unwrap();
        let dev: Vec<String> =
            db::consumers_cached(&c, "dev").unwrap().iter().map(|x| x.username.clone()).collect();
        assert_eq!(dev, vec!["a"]);
        // 다른 환경은 건드리지 않는다.
        assert_eq!(db::consumers_cached(&c, "prod").unwrap().len(), 1);
    }

    /// 접근 판정은 환경별로 격리돼야 한다 — dev 의 컨슈머가 prod 의 라우트를 보면 안 된다.
    #[test]
    fn access_join_is_env_scoped() {
        let c = conn();
        db::sync_routes(&c, "dev", &[route("1", "dev-r", 1, json!(["shared"]))]).unwrap();
        db::sync_routes(&c, "prod", &[route("9", "prod-r", 1, json!(["shared"]))]).unwrap();
        db::sync_consumers(&c, "dev", &[consumer("u", json!(["shared"]))]).unwrap();

        let page = db::query_routes(&c, "dev", "all", "", "", &user("u"), "").unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].name, "dev-r");
        // prod 에는 그 username 의 컨슈머가 없으니 아무것도 안 걸린다.
        assert_eq!(db::query_routes(&c, "prod", "all", "", "", &user("u"), "").unwrap().total, 0);
    }

    /// '그룹 제한 없음' 범위 — allowed_groups 가 빈 라우트만 남는다.
    ///
    /// 이 라우트들은 어떤 컨슈머로도 걸리지 않아서(위 `routes_filtered_by_consumer_access`)
    /// 예전에는 좌측 패널의 건수로만 존재를 알 수 있고 목록으로 볼 방법이 없었다.
    #[test]
    fn ungrouped_scope_shows_only_routes_without_groups() {
        let c = conn();
        db::sync_routes(
            &c,
            "dev",
            &[
                route("1", "partner-on", 1, json!(["partner"])),
                route("2", "free-on", 1, json!([])),
                route("3", "free-off", 0, json!([])),
            ],
        )
        .unwrap();
        db::sync_consumers(&c, "dev", &[consumer("alpha", json!(["partner"]))]).unwrap();

        let page = db::query_routes(&c, "dev", "all", "", "", &UNGROUPED, "").unwrap();
        assert_eq!(
            page.items.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            ["free-on", "free-off"]
        );
        // 좌측 패널의 건수와 같은 것을 세고 있어야 한다.
        assert_eq!(page.total, db::consumer_access_counts(&c, "dev", "").unwrap().ungrouped);

        // chip · 검색어와 AND 로 겹친다.
        assert_eq!(db::query_routes(&c, "dev", "on", "", "", &UNGROUPED, "").unwrap().total, 1);
        assert_eq!(db::query_routes(&c, "dev", "all", "free-off", "", &UNGROUPED, "").unwrap().total, 1);
        assert_eq!(db::query_routes(&c, "dev", "all", "partner", "", &UNGROUPED, "").unwrap().total, 0);

        // chip 라벨의 숫자도 범위를 따라간다 — 컨슈머를 골랐을 때와 같은 이유다
        // (`counts_follow_the_selected_consumer_but_not_the_chip`). 여기서 `?4` 가
        // route_counts 에도 실제로 바인딩됐는지 드러난다.
        for chip in ["all", "on", "off"] {
            let counts = db::query_routes(&c, "dev", chip, "", "", &UNGROUPED, "").unwrap().counts;
            assert_eq!((counts.all, counts.on, counts.off), (2, 1, 1), "chip={chip}");
        }

        // 범위는 배타적이다 — 컨슈머를 고르면 그룹 없는 라우트는 안 보인다.
        assert_eq!(db::query_routes(&c, "dev", "all", "", "", &user("alpha"), "").unwrap().total, 1);
    }

    /// 새 절도 환경별로 격리돼야 한다 (`access_join_is_env_scoped` 와 같은 이유).
    #[test]
    fn ungrouped_scope_is_env_scoped() {
        let c = conn();
        db::sync_routes(&c, "dev", &[route("1", "dev-free", 1, json!([]))]).unwrap();
        db::sync_routes(
            &c,
            "prod",
            &[route("9", "prod-free", 1, json!([])), route("8", "prod-p", 1, json!(["p"]))],
        )
        .unwrap();

        let page = db::query_routes(&c, "dev", "all", "", "", &UNGROUPED, "").unwrap();
        assert_eq!(page.items.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["dev-free"]);

        let page = db::query_routes(&c, "prod", "all", "", "", &UNGROUPED, "").unwrap();
        assert_eq!(page.items.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["prod-free"]);
    }

    /// 프런트가 보내는 모양 그대로 역직렬화되는지 — IPC 계약에 걸 수 있는 유일한 자동 검사다.
    /// (`src/types.ts` 의 `RouteScope`. 태그 이름이나 필드 이름이 어긋나면 여기서 깨진다.)
    #[test]
    fn route_scope_deserializes_from_the_wire_shape() {
        let parse = |v: serde_json::Value| {
            serde_json::from_value::<db::RouteScope>(v).expect("범위").binds_for_test()
        };

        assert_eq!(parse(json!({ "kind": "all" })), ("".to_string(), 0));
        assert_eq!(parse(json!({ "kind": "ungrouped" })), ("".to_string(), 1));
        assert_eq!(
            parse(json!({ "kind": "consumer", "username": "alpha" })),
            ("alpha".to_string(), 0)
        );
        // 공백은 다듬어 넘긴다 — 앞뒤 공백 때문에 조용히 0건이 되면 안 된다.
        assert_eq!(
            parse(json!({ "kind": "consumer", "username": " alpha " })),
            ("alpha".to_string(), 0)
        );
        // 태그가 없거나 모르는 값이면 실패해야 한다 (조용히 전체가 되면 안 된다).
        assert!(serde_json::from_value::<db::RouteScope>(json!({ "username": "a" })).is_err());
        assert!(serde_json::from_value::<db::RouteScope>(json!({ "kind": "nope" })).is_err());
    }

    #[test]
    fn overview_counts_come_from_the_cache() {
        let c = conn();
        db::sync_routes(
            &c,
            "dev",
            &[
                route("1", "on-a", 1, json!([])),
                route("2", "on-b", 1, json!([])),
                route("3", "off", 0, json!([])),
            ],
        )
        .unwrap();
        db::sync_consumers(&c, "dev", &[consumer("a", json!([])), consumer("b", json!([]))])
            .unwrap();
        // jwt-auth 가 없는 컨슈머
        db::sync_consumers(
            &c,
            "prod",
            &[ConsumerView::from_value(&json!({ "username": "nojwt" }))],
        )
        .unwrap();

        let o = db::overview_counts(&c, "dev", "").unwrap();
        assert_eq!((o.routes, o.routes_active, o.routes_inactive), (3, 2, 1));
        assert_eq!((o.consumers, o.consumers_jwt), (2, 2));

        let p = db::overview_counts(&c, "prod", "").unwrap();
        assert_eq!((p.consumers, p.consumers_jwt), (1, 0));
    }
}

// ── 13. Service 저장 (labels · 플러그인 보존) ────────────────

mod service_form {
    use crate::apisix::models::{ServiceView, UpstreamView};
    use crate::apisix::services::{apply_service_form_for_test as apply, ServiceForm};
    use serde_json::{json, Value};

    fn form() -> ServiceForm {
        serde_json::from_value(json!({
            "id": "svc-order",
            "name": "order-api",
            "desc": "주문 API",
            "upstreamId": "ups-order",
            "specUrl": "https://git.internal/order/openapi.yaml",
            "logKey": "ep",
            // 기본값에 기대지 않고 명시한다 — 기본값이 바뀌면 이 픽스처를 쓰는 테스트가
            // 조용히 다른 것을 검증하게 된다.
            "jwtAuth": true,
        }))
        .expect("폼")
    }

    #[test]
    fn writes_jwt_auth_and_shi_log_key() {
        let out = apply(json!({}), &form());

        // jwt-auth 는 "붙어 있어야 한다"가 요구사항 — 빈 객체로 넣는다.
        assert_eq!(out.pointer("/plugins/jwt-auth"), Some(&json!({})));
        assert_eq!(out.pointer("/plugins/shi-log/key"), Some(&json!("ep")));
        assert_eq!(out.pointer("/upstream_id"), Some(&json!("ups-order")));
        assert_eq!(out.pointer("/labels/spec_url"), Some(&json!("https://git.internal/order/openapi.yaml")));

        // 서버가 관리하는 필드는 본문에 실리지 않는다.
        assert!(out.get("id").is_none());
        assert!(out.get("create_time").is_none());
    }

    // ── 예외 케이스: 두 플러그인은 없을 수도 있다 ──────────────
    //
    // 저장은 GET 해 온 원본에 얹는 머지다. 그래서 "안 넣는다"로는 지워지지 않고,
    // 아래 테스트들은 모두 **원본에 있던 것이 사라지는지**를 본다.

    /// 토글 OFF 는 "이 service 에 jwt-auth 는 필요 없다" 다 — 설정이 있어도 지운다.
    #[test]
    fn jwt_auth_off_removes_the_plugin() {
        let mut f = form();
        f.jwt_auth = false;

        let base = json!({
            "plugins": {
                "jwt-auth": { "header": "authorization", "hide_credentials": true },
                "shi-log": { "key": "old" },
            },
        });
        let out = apply(base, &f);

        assert!(out.pointer("/plugins/jwt-auth").is_none(), "설정이 있어도 지운다");
        // 다른 플러그인은 건드리지 않는다 — 껐다고 shi-log 까지 사라지면 안 된다.
        assert_eq!(out.pointer("/plugins/shi-log/key"), Some(&json!("ep")));
    }

    /// 빈 log-key 는 `key: ""` 가 아니라 shi-log 를 통째로 지우라는 뜻이다.
    /// `key` 만 지우면 로그 키 없는 플러그인이 남아 게이트웨이에서 무슨 일이 날지 모른다.
    #[test]
    fn blank_log_key_removes_the_whole_shi_log() {
        let mut f = form();
        f.log_key = String::new();

        let base = json!({
            "plugins": {
                "jwt-auth": {},
                "shi-log": { "key": "old", "level": "info" },
            },
        });
        let out = apply(base, &f);

        assert!(out.pointer("/plugins/shi-log").is_none(), "level 까지 함께 사라진다");
        // jwt-auth 는 토글이 켜져 있으므로 남는다.
        assert_eq!(out.pointer("/plugins/jwt-auth"), Some(&json!({})));
    }

    /// 저장이 `trim()` 한 값을 쓰므로 공백뿐인 값은 빈 값과 같은 뜻이어야 한다.
    /// (`"e p"` 는 여전히 거절된다 — rejects_values_the_gateway_would_reject)
    #[test]
    fn whitespace_only_log_key_removes_shi_log() {
        let mut f = form();
        f.log_key = "   ".into();

        assert!(!super::service_validate_fails(&f), "공백뿐인 값은 '지워라' 이지 에러가 아니다");

        let out = apply(json!({ "plugins": { "shi-log": { "key": "old" } } }), &f);
        assert!(out.pointer("/plugins/shi-log").is_none());
    }

    /// 앱이 관리하는 플러그인이 하나도 남지 않으면 `plugins` 키 자체를 없앤다 —
    /// `set_label` 이 labels 에 하는 것과 같은 규칙이다 (빈 껍데기를 남기지 않는다).
    #[test]
    fn no_managed_plugins_removes_the_plugins_key() {
        let mut f = form();
        f.jwt_auth = false;
        f.log_key = String::new();

        let base = json!({ "plugins": { "jwt-auth": {}, "shi-log": { "key": "old" } } });
        let out = apply(base, &f);

        assert!(out.get("plugins").is_none(), "plugins: {{}} 라는 빈 껍데기를 남기지 않는다");

        // 애초에 plugins 가 없던 service 도 같은 모양이 나온다.
        assert!(apply(json!({}), &f).get("plugins").is_none());
    }

    /// "아무런 플러그인이 없으면" 이 조건이다 — 앱이 모르는 플러그인이 남아 있으면
    /// `plugins` 는 유지된다. `is_empty()` 로 판단하므로 자연히 성립한다.
    #[test]
    fn unknown_plugin_keeps_the_plugins_key() {
        let mut f = form();
        f.jwt_auth = false;
        f.log_key = String::new();

        let base = json!({
            "plugins": {
                "jwt-auth": {},
                "shi-log": { "key": "old" },
                "limit-count": { "count": 100, "time_window": 60 },
            },
        });
        let out = apply(base, &f);

        assert_eq!(out.pointer("/plugins/limit-count/count"), Some(&json!(100)));
        assert!(out.pointer("/plugins/jwt-auth").is_none());
        assert!(out.pointer("/plugins/shi-log").is_none());
        // 관리 대상 둘만 빠지고 나머지는 그대로다.
        let left = out.pointer("/plugins").and_then(Value::as_object).expect("plugins 유지");
        assert_eq!(left.len(), 1, "limit-count 하나만 남는다");
    }

    /// 삭제한 거절 케이스(`log-key 누락`)의 반대편을 명시적으로 못 박는다.
    #[test]
    fn blank_log_key_is_allowed() {
        let mut f = form();
        f.log_key = String::new();
        assert!(!super::service_validate_fails(&f));
    }

    /// 플러그인이 없는 service 도 조회 → 폼 프리필이 성립해야 한다.
    /// `view_reads_back_what_the_form_wrote` 의 짝이다 (그쪽은 둘 다 붙은 경우).
    #[test]
    fn view_reads_back_a_service_without_plugins() {
        let mut f = form();
        f.jwt_auth = false;
        f.log_key = String::new();

        let mut saved = apply(json!({}), &f);
        saved["id"] = json!("svc-order");

        let view = ServiceView::from_value(&saved, &[]);
        // 이 두 값이 폼의 토글과 log-key 칸으로 그대로 내려간다 (types.ts 의 serviceToForm).
        assert!(!view.has_jwt_auth);
        assert_eq!(view.log_key, "");
    }

    /// jwt-auth 를 `{}` 로 덮으면 게이트웨이에 설정된 옵션이 사라진다 — 있으면 보존한다.
    #[test]
    fn preserves_existing_jwt_auth_config_and_other_plugins() {
        let base = json!({
            "id": "svc-order",
            "create_time": 1,
            "plugins": {
                "jwt-auth": { "header": "authorization", "hide_credentials": true },
                "shi-log": { "key": "old", "level": "info" },
                "limit-count": { "count": 100, "time_window": 60 },
            },
        });

        let out = apply(base, &form());

        assert_eq!(out.pointer("/plugins/jwt-auth/header"), Some(&json!("authorization")));
        assert_eq!(out.pointer("/plugins/jwt-auth/hide_credentials"), Some(&json!(true)));
        // shi-log 는 key 만 갈아 끼우고 나머지 필드는 남는다.
        assert_eq!(out.pointer("/plugins/shi-log/key"), Some(&json!("ep")));
        assert_eq!(out.pointer("/plugins/shi-log/level"), Some(&json!("info")));
        // 앱이 모르는 플러그인은 손대지 않는다.
        assert_eq!(out.pointer("/plugins/limit-count/count"), Some(&json!(100)));
    }

    #[test]
    fn spec_url_label_does_not_disturb_other_labels() {
        let base = json!({ "labels": { "name1": "박승우", "dept1": "플랫폼개발팀" } });
        let out = apply(base, &form());

        assert_eq!(out.pointer("/labels/name1"), Some(&json!("박승우")));
        assert_eq!(out.pointer("/labels/dept1"), Some(&json!("플랫폼개발팀")));
        assert_eq!(out.pointer("/labels/spec_url").and_then(Value::as_str).map(|s| s.starts_with("https://")), Some(true));
    }

    /// `minLength = 1` 이라 빈 값은 `""` 로 쓸 수 없다 — 키를 통째로 지운다.
    #[test]
    fn blank_spec_url_removes_only_that_label() {
        let mut f = form();
        f.spec_url = String::new();

        let base = json!({ "labels": { "spec_url": "https://old", "name1": "박승우" } });
        let out = apply(base, &f);

        assert!(out.pointer("/labels/spec_url").is_none());
        assert_eq!(out.pointer("/labels/name1"), Some(&json!("박승우")));

        // 라벨이 하나도 남지 않으면 labels 키 자체를 없앤다.
        let bare = apply(json!({ "labels": { "spec_url": "https://old" } }), &f);
        assert!(bare.get("labels").is_none());
    }

    #[test]
    fn writes_name_prefix_label_and_reads_it_back() {
        let mut f = form();
        f.name_prefix = "EP_".into();

        let out = apply(json!({ "labels": { "name1": "박승우" } }), &f);
        assert_eq!(out.pointer("/labels/name_prefix"), Some(&json!("EP_")));
        assert_eq!(out.pointer("/labels/name1"), Some(&json!("박승우")), "다른 라벨은 남는다");
        assert!(out.pointer("/labels/spec_url").is_some(), "spec_url 과 나란히 들어간다");

        // 게이트웨이 응답 모양으로 되돌려 읽으면 폼이 쓴 값이 그대로 나온다.
        let mut saved = out;
        saved["id"] = json!("svc-order");
        assert_eq!(ServiceView::from_value(&saved, &[]).name_prefix, "EP_");
    }

    /// spec_url 과 같은 성질이다 — 빈 값은 `""` 로 쓰지 않고 그 키만 지운다.
    #[test]
    fn blank_name_prefix_removes_only_that_label() {
        let base = json!({ "labels": { "name_prefix": "EP_", "name1": "박승우" } });
        let out = apply(base, &form()); // 폼의 name_prefix 는 비어 있다

        assert!(out.pointer("/labels/name_prefix").is_none());
        assert_eq!(out.pointer("/labels/name1"), Some(&json!("박승우")));
    }

    /// 끝문자(`/`·`_`)는 규약이지 게이트웨이 제약이 아니다 — 화면이 경고하고 저장은 통과시킨다.
    #[test]
    fn name_prefix_without_a_separator_still_saves() {
        let mut f = form();
        f.name_prefix = "EP".into();
        assert!(!super::service_validate_fails(&f));
    }

    #[test]
    fn view_reads_back_what_the_form_wrote() {
        // 요청 본문에는 id 가 실리지 않는다(서버가 관리한다). 게이트웨이 **응답**에는
        // 들어 있으므로 그 모양으로 되돌려 놓고 읽는다 — 실제 save() 경로와 같다.
        let mut saved = apply(json!({}), &form());
        assert!(saved.get("id").is_none(), "요청 본문에는 id 가 없다");
        saved["id"] = json!("svc-order");

        let ups = vec![UpstreamView::from_value(&json!({
            "id": "ups-order",
            "nodes": { "10.20.3.11:8080": 1 },
        }))];

        let view = ServiceView::from_value(&saved, &ups);
        assert_eq!(view.spec_url, "https://git.internal/order/openapi.yaml");
        assert_eq!(view.log_key, "ep");
        assert!(view.has_jwt_auth);
        assert_eq!(view.upstream_id, "ups-order");
        assert_eq!(view.upstream_label, "10.20.3.11:8080", "upstream_id 로 노드를 찾아 온다");
        assert_eq!(view.option_label, "svc-order · order-api (10.20.3.11:8080)");
    }

    #[test]
    fn rejects_values_the_gateway_would_reject() {
        // 게이트웨이의 400 은 어느 값이 왜 틀렸는지 알려 주지 않으므로 저장 전에 막는다.
        let cases: Vec<(&str, Value)> = vec![
            ("name 누락", json!({ "name": "", "upstreamId": "u", "logKey": "ep" })),
            ("upstream 누락", json!({ "name": "n", "upstreamId": "", "logKey": "ep" })),
            // log-key 누락은 더 이상 거절 대상이 아니다 — shi-log 를 지우라는 뜻이다
            // (blank_log_key_is_allowed 가 반대편을 못 박는다).
            ("log-key 공백", json!({ "name": "n", "upstreamId": "u", "logKey": "e p" })),
            // labels 값 제약: ^\S+$
            ("spec_url 공백", json!({ "name": "n", "upstreamId": "u", "logKey": "ep",
                                     "specUrl": "https://a b/x.yaml" })),
            // URL 박스가 임의 파일 읽기가 되지 않도록 스킴을 제한한다 (client::fetch_text 와 같은 규칙)
            ("spec_url 스킴", json!({ "name": "n", "upstreamId": "u", "logKey": "ep",
                                      "specUrl": "file:///etc/passwd" })),
            // labels 값은 256 바이트가 상한이다
            ("spec_url 길이", json!({ "name": "n", "upstreamId": "u", "logKey": "ep",
                                      "specUrl": format!("https://h/{}", "a".repeat(300)) })),
            // name 접두어도 labels 로 들어가므로 같은 제약을 받는다.
            ("name 접두어 공백", json!({ "name": "n", "upstreamId": "u", "logKey": "ep",
                                       "namePrefix": "EP 1/" })),
            ("name 접두어 길이", json!({ "name": "n", "upstreamId": "u", "logKey": "ep",
                                       "namePrefix": "a".repeat(300) })),
        ];

        for (label, payload) in cases {
            let f: ServiceForm = serde_json::from_value(payload).expect("폼");
            // validate 는 비공개이므로 머지 앞단을 타는 공개 경로로 확인한다.
            assert!(super::service_validate_fails(&f), "{label} 은 거부돼야 한다");
        }
    }
}

/// `ServiceForm::validate` 는 비공개다. 테스트에서 검증만 떼어 부르기 위한 통로.
fn service_validate_fails(f: &crate::apisix::services::ServiceForm) -> bool {
    crate::apisix::services::validate_for_test(f).is_err()
}

// ── 14. Upstream 저장 (nodes · timeout · 미지 필드 보존) ─────

mod upstream_form {
    use crate::apisix::models::UpstreamView;
    use crate::apisix::upstreams::{apply_upstream_form_for_test as apply, UpstreamForm};
    use serde_json::json;

    fn form() -> UpstreamForm {
        serde_json::from_value(json!({
            "id": "ups-order",
            "name": "order-upstream",
            "desc": "주문 서비스",
            "nodes": [
                { "host": "10.20.3.11", "port": 8080 },
                { "host": "10.20.3.12", "port": 8080, "weight": 3 },
            ],
            "timeout": { "connect": 10.0, "send": 10.0, "read": 60.0 },
        }))
        .expect("폼")
    }

    #[test]
    fn writes_nodes_as_array_with_default_weight() {
        let out = apply(json!({}), &form());

        // 쓰기는 배열 표기로 고정한다 — 맵 키에 host:port 를 조립하면 IPv6·포트 없는
        // 노드에서 표기가 애매해진다.
        let nodes = out.get("nodes").and_then(|n| n.as_array()).expect("배열");
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0], json!({ "host": "10.20.3.11", "port": 8080, "weight": 1 }));
        assert_eq!(nodes[1]["weight"], json!(3), "읽은 weight 는 그대로 되쓴다");

        assert_eq!(out.pointer("/timeout/connect"), Some(&json!(10.0)));
        assert_eq!(out.pointer("/timeout/read"), Some(&json!(60.0)));
        assert_eq!(out.get("type"), Some(&json!("roundrobin")), "없으면 기본값을 넣는다");
    }

    /// 폼에 없는 설정을 저장 한 번으로 날려 버리면 안 된다.
    #[test]
    fn preserves_fields_the_form_does_not_show() {
        let base = json!({
            "id": "ups-order",
            "update_time": 123,
            "type": "chash",
            "hash_on": "header",
            "key": "x-user",
            "retries": 2,
            "scheme": "https",
            "checks": { "active": { "http_path": "/healthz" } },
        });

        let out = apply(base, &form());

        assert_eq!(out.get("type"), Some(&json!("chash")), "이미 있으면 덮지 않는다");
        assert_eq!(out.get("hash_on"), Some(&json!("header")));
        assert_eq!(out.get("retries"), Some(&json!(2)));
        assert_eq!(out.get("scheme"), Some(&json!("https")));
        assert_eq!(out.pointer("/checks/active/http_path"), Some(&json!("/healthz")));
        assert!(out.get("update_time").is_none(), "서버 관리 필드는 제외한다");
    }

    /// 게이트웨이는 두 표기를 모두 준다. 읽기는 둘 다 받아야 화면이 비지 않는다.
    #[test]
    fn reads_both_node_shapes() {
        let map = UpstreamView::from_value(&json!({
            "id": "u1",
            "nodes": { "10.0.0.1:8080": 1, "example.com": 2 },
        }));
        let hosts: Vec<&str> = map.nodes.iter().map(|n| n.host.as_str()).collect();
        assert!(hosts.contains(&"10.0.0.1"));
        // 포트가 없는 키는 host 로만 남는다 (콜론이 없으면 나누지 않는다).
        assert!(hosts.contains(&"example.com"));
        let with_port = map.nodes.iter().find(|n| n.host == "10.0.0.1").unwrap();
        assert_eq!(with_port.port, Some(8080));

        let arr = UpstreamView::from_value(&json!({
            "id": "u2",
            "nodes": [{ "host": "10.0.0.9", "port": 9000, "weight": 5 }],
        }));
        assert_eq!(arr.nodes.len(), 1);
        assert_eq!(arr.nodes[0].port, Some(9000));
        assert_eq!(arr.nodes[0].weight, Some(5));
        assert_eq!(arr.node_label, "10.0.0.9:9000");
    }

    #[test]
    fn defaults_timeout_when_gateway_has_none() {
        // 요구된 기본값 — connect 10 · send 10 · read 60
        let v = UpstreamView::from_value(&json!({ "id": "u", "nodes": [] }));
        assert_eq!(v.timeout.connect, 10.0);
        assert_eq!(v.timeout.send, 10.0);
        assert_eq!(v.timeout.read, 60.0);
        assert_eq!(v.r#type, "roundrobin");
    }

    #[test]
    fn round_trips_through_apply_and_view() {
        let saved = apply(json!({}), &form());
        let v = UpstreamView::from_value(&saved);
        assert_eq!(v.nodes.len(), 2);
        assert_eq!(v.node_label, "10.20.3.11:8080 외 1");
        assert_eq!(v.timeout.read, 60.0);
    }

    #[test]
    fn rejects_nodes_the_gateway_would_reject() {
        let cases: Vec<(&str, serde_json::Value)> = vec![
            ("노드 없음", json!({ "name": "n", "nodes": [] })),
            ("host 공란", json!({ "name": "n", "nodes": [{ "host": " ", "port": 80 }] })),
            ("host 공백", json!({ "name": "n", "nodes": [{ "host": "a b", "port": 80 }] })),
            ("port 0", json!({ "name": "n", "nodes": [{ "host": "h", "port": 0 }] })),
            ("port 초과", json!({ "name": "n", "nodes": [{ "host": "h", "port": 70000 }] })),
            ("name 누락", json!({ "name": "", "nodes": [{ "host": "h", "port": 80 }] })),
            (
                "timeout 0",
                json!({ "name": "n", "nodes": [{ "host": "h", "port": 80 }],
                        "timeout": { "connect": 0.0, "send": 1.0, "read": 1.0 } }),
            ),
        ];

        for (label, payload) in cases {
            let f: UpstreamForm = serde_json::from_value(payload).expect("폼");
            assert!(super::upstream_validate_fails(&f), "{label} 은 거부돼야 한다");
        }
    }
}

/// `UpstreamForm::validate` 는 비공개다. 테스트에서 검증만 떼어 부르기 위한 통로.
fn upstream_validate_fails(f: &crate::apisix::upstreams::UpstreamForm) -> bool {
    crate::apisix::upstreams::validate_for_test(f).is_err()
}

// ── 15. Upstream · Service 캐시 ──────────────────────────────

mod meta_cache {
    use crate::apisix::models::{ServiceView, UpstreamView};
    use crate::db;
    use rusqlite::Connection;
    use serde_json::json;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("메모리 DB");
        db::init(&c).expect("스키마");
        c
    }

    fn upstream(id: &str, host: &str) -> UpstreamView {
        UpstreamView::from_value(&json!({
            "id": id,
            "name": format!("{id}-name"),
            "nodes": [{ "host": host, "port": 8080, "weight": 1 }],
        }))
    }

    fn service(id: &str, upstream_id: &str, spec: &str, ups: &[UpstreamView]) -> ServiceView {
        ServiceView::from_value(
            &json!({
                "id": id,
                "name": format!("{id}-name"),
                "upstream_id": upstream_id,
                "labels": { "spec_url": spec },
                "plugins": { "jwt-auth": {}, "shi-log": { "key": "ep" } },
            }),
            ups,
        )
    }

    #[test]
    fn cache_round_trips_both_views() {
        let c = conn();
        let ups = vec![upstream("u1", "10.0.0.1")];
        db::sync_upstreams(&c, "dev", &ups).unwrap();
        db::sync_services(&c, "dev", &[service("s1", "u1", "https://spec/a.yaml", &ups)]).unwrap();

        let back = db::upstreams_cached(&c, "dev").unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].nodes[0].host, "10.0.0.1");
        assert_eq!(back[0].timeout.read, 60.0);
        assert_eq!(back[0].node_label, "10.0.0.1:8080");

        let svcs = db::services_cached(&c, "dev").unwrap();
        assert_eq!(svcs.len(), 1);
        assert_eq!(svcs[0].spec_url, "https://spec/a.yaml");
        assert_eq!(svcs[0].log_key, "ep");
        assert!(svcs[0].has_jwt_auth);
        assert_eq!(svcs[0].option_label, "s1 · s1-name (10.0.0.1:8080)");
    }

    /// 부분 upsert 를 하면 게이트웨이에서 지워진 항목이 콤보에 유령으로 남는다.
    #[test]
    fn sync_replaces_and_is_env_scoped() {
        let c = conn();
        let ups = vec![upstream("u1", "10.0.0.1"), upstream("u2", "10.0.0.2")];
        db::sync_upstreams(&c, "dev", &ups).unwrap();
        db::sync_upstreams(&c, "prod", &[upstream("u9", "10.9.9.9")]).unwrap();

        // 게이트웨이에서 u2 가 사라졌다 → 캐시에도 남지 않아야 한다.
        db::sync_upstreams(&c, "dev", &ups[..1]).unwrap();

        let dev = db::upstreams_cached(&c, "dev").unwrap();
        assert_eq!(dev.len(), 1);
        assert_eq!(dev[0].id, "u1");

        // 다른 환경은 건드리지 않는다.
        let prod = db::upstreams_cached(&c, "prod").unwrap();
        assert_eq!(prod.len(), 1);
        assert_eq!(prod[0].id, "u9");

        db::sync_services(&c, "dev", &[service("s1", "u1", "https://a", &ups)]).unwrap();
        assert_eq!(db::services_cached(&c, "prod").unwrap().len(), 0);
        db::sync_services(&c, "dev", &[]).unwrap();
        assert_eq!(db::services_cached(&c, "dev").unwrap().len(), 0);
    }

    #[test]
    fn keeps_gateway_order() {
        let c = conn();
        let ups: Vec<UpstreamView> =
            ["b", "a", "c"].iter().map(|id| upstream(id, "10.0.0.1")).collect();
        db::sync_upstreams(&c, "dev", &ups).unwrap();

        let ids: Vec<String> =
            db::upstreams_cached(&c, "dev").unwrap().into_iter().map(|u| u.id).collect();
        assert_eq!(ids, vec!["b", "a", "c"], "seq 로 게이트웨이 순서를 유지한다");
    }
}
