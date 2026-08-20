/** Rust DTO(`src-tauri/src/**`)와 1:1 대응하는 타입. serde 가 camelCase 로 직렬화한다. */

export type EnvKey = "dev" | "prod";
export type Section = "dash" | "routes" | "consumers" | "settings";
export type View = "list" | "detail" | "create";
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

export interface ConsumerView {
  username: string;
  desc: string;
  key: string;
  secret: string;
  hasSecret: boolean;
  groups: string[];
  groupsLocation: GroupsLocation;
  hasJwtAuth: boolean;
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

export const consumerToForm = (c: ConsumerView): ConsumerFormState => ({
  kind: "consumer",
  username: c.username,
  desc: c.desc,
  key: c.key,
  secret: c.secret,
  groups: [...c.groups],
  isNew: false,
  hasSecret: c.hasSecret,
  groupsLocation: c.groupsLocation,
});
