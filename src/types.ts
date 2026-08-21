/** Rust DTO(`src-tauri/src/**`)와 1:1 대응하는 타입. serde 가 camelCase 로 직렬화한다. */

export type EnvKey = "dev" | "prod";
export type Section = "dash" | "routes" | "consumers" | "settings";
/** `import` 는 Route 섹션 전용 — OAS 스펙 비교 화면 (ImportScreen). */
export type View = "list" | "detail" | "create" | "import";
export type Tab = "form" | "json" | "jwt";
export type Kind = "route" | "consumer";

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
 * 번호 규칙(재번호 · 앞자리 0 배제 · 빈 값은 키 생략)은 Rust 한 곳에만 있다
 * (`models::contacts_of` · `set_contacts_at`). 여기서 다시 구현하지 않는다.
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

export interface ServiceOption {
  id: string;
  label: string;
  name: string;
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
  /** `text` = 드래그&드롭, `path` = 파일 다이얼로그, `url` = 주소 입력 */
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

export type MatchState = "registered" | "methodMismatch" | "unregistered";

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
  routeName: string;
  routeUri: string;
  routeStatus: number;
  /** 정확 일치가 아니라 와일드카드(`/a/*`)로 걸렸는가 */
  wildcard: boolean;
  /** 미등록 건을 신규 생성할 때 채울 uri 후보 (Rust 가 계산한다) */
  suggestedUri: string;
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

export type FormState = RouteFormState | ConsumerFormState;

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

/** APISIX name 제약에 맞춘 식별자 — 허용 문자만 남기고 길이를 자른다. */
const slugify = (v: string): string =>
  v
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);

/**
 * Import 의 미등록 행 → 신규 Route 폼.
 *
 * `uri` 는 Rust 가 계산한 `suggestedUri` 를 그대로 쓴다 — 경로 파라미터 변환 규칙이
 * 두 곳에 있으면 반드시 어긋난다 (oas::to_apisix_uri 에 테스트가 붙어 있다).
 * `groupsLocation` 은 null 로 둬서 기존 기본 위치 규칙(shi-auth.allowed_groups)에 맡긴다.
 */
export const routeFormFromOas = (row: CompareRow, serviceId: string): RouteFormState => ({
  ...emptyRouteForm(serviceId),
  name: slugify(row.operationId) || slugify(`${row.method}-${row.fullPath}`),
  uri: row.suggestedUri,
  // APISIX 의 desc 는 길이 제한이 있어 요약을 잘라 넣는다.
  desc: row.summary.trim().slice(0, 255),
  methods: [row.method],
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
