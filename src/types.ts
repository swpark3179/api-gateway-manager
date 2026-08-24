/** Rust DTO(`src-tauri/src/**`)와 1:1 대응하는 타입. serde 가 camelCase 로 직렬화한다. */

export type EnvKey = "dev" | "prod";
export type Section = "dash" | "routes" | "consumers" | "upstreams" | "services" | "settings";
/**
 * `import` · `diff` 는 Route 섹션 전용이다.
 *   import  OAS 스펙 비교 화면 (ImportScreen)
 *   diff    비교 결과에서 등록된 API 를 눌렀을 때의 중간 단계 — 스펙 적용본과 저장분의 차이를
 *           보여 주고 무엇을 적용할지 고르게 한다 (ImportDiffScreen). 차이가 없으면 이 단계를
 *           건너뛰고 바로 `detail` 로 간다.
 */
export type View = "list" | "detail" | "create" | "import" | "diff";
export type Tab = "form" | "json" | "jwt";
export type Kind = "route" | "consumer" | "service" | "upstream";

// ── 설정 ─────────────────────────────────────────────────────

export interface EnvConfigView {
  baseUrl: string;
  noProxy: boolean;
  insecureTls: boolean;
  hasToken: boolean;
  /** 마스킹된 표시용 문자열. 원문 토큰은 프런트로 내려오지 않는다. */
  tokenMasked: string;
  adminBase: string;
}

export interface SettingsView {
  dev: EnvConfigView;
  prod: EnvConfigView;
}

export interface EnvPayload {
  baseUrl: string;
  noProxy: boolean;
  insecureTls: boolean;
  /** null = 기존 토큰 유지, "" = 삭제, 그 외 = 교체 */
  token: string | null;
}

export interface TestResult {
  ok: boolean;
  text: string;
}

// ── 리소스 ───────────────────────────────────────────────────

/** auth-groups(allowed_groups)가 게이트웨이에서 실제로 저장돼 있던 자리. */
export interface GroupsLocation {
  /** plugins 아래 플러그인 이름. 빈 문자열이면 최상위 필드 */
  plugin: string;
  key: string;
  /** 원본이 배열이 아니라 "a,b" 형태 문자열이었는지 */
  asCsv: boolean;
}

export interface RouteView {
  id: string;
  name: string;
  uri: string;
  desc: string;
  methods: string[];
  status: number;
  serviceId: string;
  rewrite: string;
  groups: string[];
  groupsLocation: GroupsLocation;
  updateTime: number | null;
  updated: string;
  /** 게이트웨이 원본 객체 — JSON 탭의 '게이트웨이 원본' 보기용 */
  raw: unknown;
}

/**
 * 게이트웨이 `labels` 의 `name{n}` / `dept{n}` 쌍에서 읽은 관련 담당자.
 *
 * 번호 규칙(재번호 · 앞자리 0 배제 · 빈 값은 키 생략)의 **진실은 Rust** 다
 * (`models::contacts_of` · `set_contacts_at`) — 저장 때 실제로 적용되는 것이 그쪽이다.
 * JSON 탭이 담당자를 같이 보여 주기 위해 `lib/design.ts` 에 표시 전용 사본이 있다
 * (`contactLabels` · `contactsFromLabels`). 규칙을 고칠 때 두 곳을 함께 봐야 한다.
 */
export interface Contact {
  name: string;
  dept: string;
}

export interface ConsumerView {
  username: string;
  desc: string;
  key: string;
  secret: string;
  hasSecret: boolean;
  groups: string[];
  groupsLocation: GroupsLocation;
  hasJwtAuth: boolean;
  contacts: Contact[];
  updateTime: number | null;
  updated: string;
  /** 게이트웨이 원본 객체 — JSON 탭의 '게이트웨이 원본' 보기용 */
  raw: unknown;
}

// ── Upstream / Service ───────────────────────────────────────

/**
 * upstream 노드 하나.
 *
 * `weight` 는 폼에 노출하지 않지만 조회한 값을 그대로 되쓴다 — 화면에 없는 값을 조용히
 * 1 로 덮으면 게이트웨이에 설정된 가중치가 사라진다.
 */
export interface UpstreamNode {
  host: string;
  port: number | null;
  weight: number | null;
}

/** 초 단위. 폼 기본값은 connect 10 · send 10 · read 60. */
export interface UpstreamTimeout {
  connect: number;
  send: number;
  read: number;
}

export interface UpstreamView {
  id: string;
  name: string;
  desc: string;
  /** 로드밸런싱 방식. 게이트웨이에 없으면 `roundrobin` 으로 채워 온다 */
  type: string;
  nodes: UpstreamNode[];
  timeout: UpstreamTimeout;
  /** `10.20.3.11:8080 외 2` — 목록·셀렉트 라벨 */
  nodeLabel: string;
  updateTime: number | null;
  updated: string;
  raw: unknown;
}

export interface ServiceView {
  id: string;
  name: string;
  desc: string;
  upstreamId: string;
  /** 게이트웨이 `labels.spec_url`. Import 가 파일 첨부 없이 비교할 때 읽는 주소 */
  specUrl: string;
  /** `plugins["shi-log"].key` */
  logKey: string;
  /** `plugins["jwt-auth"]` 가 붙어 있는가 */
  hasJwtAuth: boolean;
  /** 참조 upstream 의 대표 노드. 못 찾으면 빈 문자열 */
  upstreamLabel: string;
  /** `svc-order · order-api (10.20.3.11:8080)` — Rust 가 조립한 셀렉트 라벨 */
  optionLabel: string;
  updateTime: number | null;
  updated: string;
  raw: unknown;
}

// ── Route 목록 캐시 (내장 SQLite) ───────────────────────────

export interface RouteCounts {
  all: number;
  on: number;
  off: number;
}

/** `routes_query` 의 응답. */
export interface RoutesPage {
  items: RouteView[];
  /** 세 축(chip · 검색어 · 컨슈머)을 모두 적용한 건수 — 하단 '총 N건' */
  total: number;
  /** chip 을 빼고 검색어·컨슈머만 적용한 건수 — 상단 chip 라벨 */
  counts: RouteCounts;
}

/** 컨슈머 한 명이 접근할 수 있는 라우트 수. */
export interface ConsumerAccess {
  username: string;
  count: number;
}

/**
 * Route 목록의 조회 범위 — 좌측 패널이 고르는 축.
 *
 * 세 값이 **한 축**이라 판별 유니온으로 둔다. `string | null` 로는 '그룹 제한 없음' 을 담을
 * 자리가 없고, `consumer` + `ungrouped` 두 필드로 나누면 둘 다 켜진 상태를 표현할 수 있게
 * 되어 SQL 쪽에서 무슨 뜻인지 정할 수밖에 없다. Rust 의 `db::RouteScope` 와 같은 모양이다
 * (serde 내부 태그 `kind`).
 *
 * `chip`(status 축)과는 여전히 별개 필드다 — 그 둘은 AND 로 동시에 걸린다.
 */
export type RouteScope =
  | { kind: "all" }
  | { kind: "consumer"; username: string }
  | { kind: "ungrouped" };

/** 조회 범위 전체. */
export const ALL_ROUTES: RouteScope = { kind: "all" };

/**
 * 비교·행 식별용 문자열.
 *
 * 객체를 `===` 로 비교하면 매 렌더마다 새로 만든 `{kind:"consumer"}` 가 절대 같아지지 않아
 * 좌측 패널의 선택 표시가 영영 켜지지 않는다.
 */
export const scopeKey = (s: RouteScope): string =>
  s.kind === "consumer" ? `c:${s.username}` : s.kind;

/** 화면에 표시할 범위 이름. 전체 범위는 표시할 것이 없다. */
export const scopeLabel = (s: RouteScope): string | null =>
  s.kind === "consumer" ? s.username : s.kind === "ungrouped" ? "그룹 제한 없음" : null;

/**
 * Route 화면 좌측 패널이 쓰는 집계.
 *
 * `RouteCounts` 와 달리 검색어·chip·컨슈머를 **아무것도 반영하지 않는다.**
 * 결과 요약이 아니라 범위를 고르기 위한 고정값이라, 타이핑할 때마다 모든 숫자가
 * 흔들리면 고를 수가 없다.
 */
export interface AccessCounts {
  /** 필터 없는 전체 라우트 수 */
  all: number;
  /** allowed_groups 가 비어 어떤 컨슈머로도 걸리지 않는 라우트 수 */
  ungrouped: number;
  items: ConsumerAccess[];
}

// ── OAS Import ───────────────────────────────────────────────

/** 스펙을 어디서 읽을지. 세 입력 경로가 모두 이 형태로 Rust 에 넘어간다. */
export interface ImportSource {
  /**
   * `text` = 드래그&드롭, `path` = 파일 다이얼로그,
   * `url` = **service 의 `spec_url`** (화면에 주소 입력란은 없다 — 파일을 첨부하지 않았을 때
   * 선택한 service 의 라벨에서 읽어 온다)
   */
  kind: "text" | "path" | "url";
  value: string;
  /** `url` 일 때만 의미 있다. 스펙 주소는 사외라 프록시가 필요할 수 있다. */
  noProxy?: boolean;
}

export interface OasOp {
  path: string;
  method: string;
  operationId: string;
  summary: string;
  tags: string[];
}

export interface OasDoc {
  title: string;
  version: string;
  /** `servers[0].url` 의 경로 부분. 비교 접두사의 기본값으로만 쓴다. */
  serverPrefix: string;
  ops: OasOp[];
  /** OAS 스키마 검증이 실패해 관대한 폴백으로 읽었을 때의 안내 */
  warning?: string;
}

/**
 * Rust 의 판정 — 이 API (path, method) 를 처리하는 route 가 있는가.
 *
 * uri 는 맞지만 그 메서드를 받지 않는 route 는 이 API 의 대상이 아니므로 `unregistered` 다
 * (`db::compare`). 등록된 건이 스펙과 **값까지** 같은지는 프런트가 판정한다 —
 * `lib/importDiff.ts` 의 `RowVerdict`.
 */
export type MatchState = "registered" | "unregistered";

/** 스펙 오퍼레이션 한 건의 등록 여부 판정. */
export interface CompareRow {
  /** 원본 OAS path (`/pets/{petId}`) */
  path: string;
  /** 접두사를 적용해 실제로 게이트웨이와 비교한 경로 */
  fullPath: string;
  method: string;
  operationId: string;
  summary: string;
  state: MatchState;
  /** 매칭된 route 의 id. 미등록이면 빈 문자열 */
  routeId: string;
  /**
   * 대상 route 에 **지금 저장돼 있는** 값 — `suggested*` 와 대조해 "등록됐지만 스펙과 값이
   * 다르다"를 판정한다 (`lib/importDiff.ts`). Rust 가 캐시의 `RouteView` 를 그대로 옮긴
   * 값이라, diff 화면이 `route_cached` 로 다시 읽어 만드는 기준값과 어긋나지 않는다.
   */
  routeName: string;
  routeUri: string;
  routeDesc: string;
  routeRewrite: string;
  routeStatus: number;
  /** 정확 일치가 아니라 와일드카드(`/a/*`)로 걸렸는가 */
  wildcard: boolean;
  /** 미등록 건을 신규 생성할 때 채울 uri 후보 (Rust 가 계산한다) */
  suggestedUri: string;
  /** 신규 폼의 `name` 후보 — `V1/` 같은 접두사 + 접두사를 뗀 원본 path */
  suggestedName: string;
  /** 신규 폼의 `proxy-rewrite.uri` 후보 — 접두사를 붙이지 않은 OAS 원본 path */
  suggestedRewrite: string;
}

// ── 대시보드 ─────────────────────────────────────────────────

export interface ActivityEntry {
  verb: string;
  /** 디자인의 배지 클래스: primary / success / neutral / error */
  cls: string;
  target: string;
  note: string;
  path: string;
  when: string;
  ok: boolean;
}

export interface Overview {
  routes: number;
  routesActive: number;
  routesInactive: number;
  consumers: number;
  consumersJwt: number;
  services: number;
  upstreams: number;
  version: string | null;
  latencyMs: number | null;
}

export interface DashboardPayload {
  overview: Overview;
  activity: ActivityEntry[];
  baseUrl: string;
  adminBase: string;
  tokenMasked: string;
  noProxy: boolean;
  insecureTls: boolean;
}

// ── JWT ──────────────────────────────────────────────────────

export interface JwtResult {
  token: string;
  nbf: number;
  exp: number;
  nbfHuman: string;
  expHuman: string;
  /** pretty-print 된 payload — 화면에 그대로 출력한다 */
  payload: string;
  alg: string;
}

// ── 에러 ─────────────────────────────────────────────────────

export type ErrorKind =
  | "unauthorized"
  | "connect"
  | "tls"
  | "notFound"
  | "badRequest"
  | "gateway"
  | "config"
  | "internal";

export interface AppError {
  kind: ErrorKind;
  message: string;
  hint?: string;
  status?: number;
}

// ── 폼 ───────────────────────────────────────────────────────

export interface RouteFormState {
  kind: "route";
  /** null = 신규 (POST /routes 로 APISIX 가 id 자동 생성) */
  id: string | null;
  name: string;
  uri: string;
  desc: string;
  methods: string[];
  serviceId: string;
  rewrite: string;
  groups: string[];
  status: number;
  /** 조회 때 찾은 저장 위치. 신규면 null → 기본 위치를 쓴다 */
  groupsLocation: GroupsLocation | null;
}

export interface ConsumerFormState {
  kind: "consumer";
  username: string;
  desc: string;
  key: string;
  secret: string;
  groups: string[];
  contacts: Contact[];
  isNew: boolean;
  /** 게이트웨이가 secret 을 돌려주지 않은 경우 JWT 탭에서 안내한다 */
  hasSecret: boolean;
  /** 조회 때 찾은 저장 위치. 신규면 null → 기본 위치를 쓴다 */
  groupsLocation: GroupsLocation | null;
}

/**
 * upstream 노드 입력 한 줄. 숫자를 **문자열로** 들고 있는 이유는 편집 중 빈 칸이
 * 가능해야 하기 때문이다 (`port: number` 면 지우는 순간 NaN 이 된다).
 * 숫자 변환은 `api.upstreamSave` 한 곳에서 한다.
 */
export interface UpstreamNodeInput {
  host: string;
  port: string;
  /** 화면에 없지만 조회값을 실어 보낸다 (UpstreamNode.weight 주석 참조) */
  weight: string;
}

export interface UpstreamFormState {
  kind: "upstream";
  /** null = 신규 (POST /upstreams 로 APISIX 가 id 자동 생성) */
  id: string | null;
  name: string;
  desc: string;
  nodes: UpstreamNodeInput[];
  timeout: { connect: string; send: string; read: string };
}

export interface ServiceFormState {
  kind: "service";
  /** null = 신규 (POST /services 로 APISIX 가 id 자동 생성) */
  id: string | null;
  name: string;
  desc: string;
  upstreamId: string;
  /** `labels.spec_url` 로 저장된다 */
  specUrl: string;
  /** `plugins["shi-log"].key` */
  logKey: string;
}

export type FormState =
  | RouteFormState
  | ConsumerFormState
  | ServiceFormState
  | UpstreamFormState;

export const emptyRouteForm = (serviceId: string): RouteFormState => ({
  kind: "route",
  id: null,
  name: "",
  uri: "",
  desc: "",
  methods: ["GET"],
  serviceId,
  rewrite: "",
  groups: [],
  status: 1,
  groupsLocation: null,
});

export const emptyConsumerForm = (): ConsumerFormState => ({
  kind: "consumer",
  username: "",
  desc: "",
  key: "",
  secret: "",
  groups: [],
  contacts: [],
  isNew: true,
  hasSecret: true,
  groupsLocation: null,
});

export const routeToForm = (r: RouteView): RouteFormState => ({
  kind: "route",
  id: r.id || null,
  name: r.name,
  uri: r.uri,
  desc: r.desc,
  methods: [...r.methods],
  serviceId: r.serviceId,
  rewrite: r.rewrite,
  groups: [...r.groups],
  status: r.status,
  groupsLocation: r.groupsLocation,
});

/**
 * Import 의 미등록 행 → 신규 Route 폼.
 *
 * `name` · `uri` · `rewrite` 세 값은 **모두 Rust 가 계산한 것을 그대로 쓴다**
 * (`oas::suggested_name` · `oas::to_apisix_uri`). 규칙이 두 곳에 있으면 반드시 어긋나고,
 * Rust 쪽에는 테스트가 붙어 있다.
 *
 *   name    `V1/orders/{orderId}/items`  접두사를 대문자로 + 접두사를 뗀 원본 path
 *   uri     `/v1/orders/:orderId/items`  게이트웨이가 매칭하는 표기 (접두사 포함)
 *   rewrite `/orders/{orderId}/items`    upstream 이 아는 경로 (접두사 없음)
 *
 * `groupsLocation` 은 null 로 둬서 기존 기본 위치 규칙(shi-auth.allowed_groups)에 맡긴다.
 */
export const routeFormFromOas = (row: CompareRow, serviceId: string): RouteFormState => ({
  ...emptyRouteForm(serviceId),
  name: row.suggestedName,
  uri: row.suggestedUri,
  rewrite: row.suggestedRewrite,
  desc: specDesc(row),
  methods: [row.method],
});

/** APISIX 의 `desc` 길이 제한. */
export const MAX_DESC_LEN = 255;

/**
 * 스펙 요약 → `desc` 후보.
 *
 * 신규 등록 프리필(`routeFormFromOas`)과 기존 API 와의 diff(`lib/importDiff`)가 **같은 값**을
 * 써야 한다. 두 곳에서 각자 자르면 "신규로 만든 값" 과 "적용하겠다고 보여 준 값" 이 달라진다.
 */
export const specDesc = (row: CompareRow): string =>
  row.summary.trim().slice(0, MAX_DESC_LEN);

/** 요구된 기본 timeout — connect 10 · send 10 · read 60 (초). */
export const DEFAULT_TIMEOUT = { connect: "10", send: "10", read: "60" };

export const emptyUpstreamForm = (): UpstreamFormState => ({
  kind: "upstream",
  id: null,
  name: "",
  desc: "",
  nodes: [{ host: "", port: "", weight: "1" }],
  timeout: { ...DEFAULT_TIMEOUT },
});

export const emptyServiceForm = (upstreamId: string): ServiceFormState => ({
  kind: "service",
  id: null,
  name: "",
  desc: "",
  upstreamId,
  specUrl: "",
  logKey: "",
});

const numText = (v: number | null, fallback = ""): string =>
  v === null || v === undefined ? fallback : String(v);

export const upstreamToForm = (u: UpstreamView): UpstreamFormState => ({
  kind: "upstream",
  id: u.id || null,
  name: u.name,
  desc: u.desc,
  // 노드가 없는 upstream 도 편집할 수 있어야 하므로 빈 행 하나를 준다.
  nodes:
    u.nodes.length > 0
      ? u.nodes.map((n) => ({
          host: n.host,
          port: numText(n.port),
          weight: numText(n.weight, "1"),
        }))
      : [{ host: "", port: "", weight: "1" }],
  timeout: {
    connect: String(u.timeout.connect),
    send: String(u.timeout.send),
    read: String(u.timeout.read),
  },
});

export const serviceToForm = (s: ServiceView): ServiceFormState => ({
  kind: "service",
  id: s.id || null,
  name: s.name,
  desc: s.desc,
  upstreamId: s.upstreamId,
  specUrl: s.specUrl,
  logKey: s.logKey,
});

export const consumerToForm = (c: ConsumerView): ConsumerFormState => ({
  kind: "consumer",
  username: c.username,
  desc: c.desc,
  key: c.key,
  secret: c.secret,
  groups: [...c.groups],
  // groups 와 같은 이유로 깊은 복사한다 — 폼 편집이 목록의 원본을 건드리면 안 된다.
  contacts: c.contacts.map((x) => ({ ...x })),
  isNew: false,
  hasSecret: c.hasSecret,
  groupsLocation: c.groupsLocation,
});
