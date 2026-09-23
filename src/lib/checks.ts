/**
 * Upstream 헬스체크(`checks`) — 폼 ⇄ JSON 변환 · 검사 · 표시 문구.
 *
 * 저장의 진실은 Rust 다 (`upstreams.rs` 의 `apply_checks` · `ChecksInput::validate`). 여기 있는
 * 것은 그 규칙의 **표시용 사본**이고, 어느 키가 생기고 사라지는지는 양쪽이 같아야 한다:
 *
 *   헬스체크 OFF         `checks` 키가 없다
 *   빈 칸               그 키가 없다 → APISIX 기본값 (`CHECK_DEFAULTS` 를 placeholder 로 보여 준다)
 *   type tcp            `http_path` · `host` · `https_verify_certificate` · `http_statuses` ·
 *                       `unhealthy.http_failures` 가 없다
 *   수동 검사 OFF        `checks.passive` 가 없다
 *   속이 빈 healthy 등   그 키가 없다
 *
 * 폼이 모르는 키(`req_headers` …)는 미리보기에 없지만 저장할 때 보존된다 — JSON 탭이 그렇게 밝혀 둔다.
 *
 * '기본값으로 자동설정' 이 채우는 값은 `CHECK_PRESET` 이다 (운영에서 쓰는 설정). host · port 만
 * upstream 마다 달라서 편집 중인 노드에서 가져온다 (`presetChecks`).
 */

import type { ChecksFormState, CheckType, HealthNode, UpstreamNodeInput } from "../types";

export const CHECK_TYPES: CheckType[] = ["http", "https", "tcp"];

/**
 * APISIX 기본값 (apisix/schema_def.lua 의 health_checker). 폼이 비워 둔 칸은 게이트웨이도 이
 * 값을 쓴다 — 그래서 placeholder 로 보여 준다. Rust 직접 점검의 `DEFAULT_*` 와 짝이다.
 */
export const CHECK_DEFAULTS = {
  httpPath: "/",
  timeout: "1",
  concurrency: "10",
  healthyInterval: "1",
  healthySuccesses: "2",
  healthyStatuses: "200, 302",
  unhealthyInterval: "1",
  unhealthyHttpFailures: "5",
  unhealthyTcpFailures: "2",
  unhealthyTimeouts: "3",
  unhealthyStatuses: "429, 404, 500, 501, 502, 503, 504, 505",
  passiveType: "http",
  passiveHealthySuccesses: "5",
  passiveHealthyStatuses: "2xx · 3xx 19개",
  passiveHttpFailures: "5",
  passiveTcpFailures: "2",
  passiveTimeouts: "7",
  passiveStatuses: "429, 500, 503",
} as const;

export const emptyChecks = (): ChecksFormState => ({
  enabled: false,
  type: "http",
  httpPath: "",
  host: "",
  port: "",
  timeout: "",
  concurrency: "",
  httpsVerify: "",
  healthyInterval: "",
  healthySuccesses: "",
  healthyStatuses: "",
  unhealthyInterval: "",
  unhealthyHttpFailures: "",
  unhealthyTcpFailures: "",
  unhealthyTimeouts: "",
  unhealthyStatuses: "",
  passive: false,
  passiveType: "",
  passiveHealthySuccesses: "",
  passiveHealthyStatuses: "",
  passiveHttpFailures: "",
  passiveTcpFailures: "",
  passiveTimeouts: "",
  passiveStatuses: "",
});

// ── JSON → 폼 ────────────────────────────────────────────────

type Obj = Record<string, unknown>;

const asObj = (v: unknown): Obj | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** 유한한 숫자만 받는다 — 그 밖은 빈 칸 (design.ts 의 `numIn` 과 같은 규칙). */
const numIn = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? String(v) : "";

const listIn = (v: unknown): string =>
  Array.isArray(v) ? v.filter((x) => typeof x === "number").join(", ") : "";

const boolIn = (v: unknown): "" | "true" | "false" =>
  v === true ? "true" : v === false ? "false" : "";

/**
 * 게이트웨이의 `checks` · JSON 탭의 본문 → 폼.
 *
 * `base` 는 본문이 **일부러 빼는** 칸을 채울 값이다 — tcp 검사의 HTTP 칸, 꺼진 수동 검사의
 * 칸, 꺼진 헬스체크 전체. `checksJson` 이 낸 본문을 되읽었을 때 그 값들이 사라지지 않아야
 * JSON 탭 왕복이 무손실이다 (Route 의 그룹 목록이 전체 허용 본문에서 남는 것과 같다).
 * 게이트웨이에서 처음 열 때는 기본값(빈 폼)이다.
 */
export function checksFromJson(v: unknown, base: ChecksFormState = emptyChecks()): ChecksFormState {
  const o = asObj(v);
  if (!o) return { ...base, enabled: false };

  const a = asObj(o.active) ?? {};
  const type = CHECK_TYPES.find((t) => t === a.type) ?? "http";
  const http = type !== "tcp";
  const h = asObj(a.healthy) ?? {};
  const u = asObj(a.unhealthy) ?? {};
  const p = asObj(o.passive);
  const ph = asObj(p?.healthy) ?? {};
  const pu = asObj(p?.unhealthy) ?? {};

  return {
    enabled: true,
    type,
    httpPath: http ? text(a.http_path) : base.httpPath,
    host: http ? text(a.host) : base.host,
    port: numIn(a.port),
    timeout: numIn(a.timeout),
    concurrency: numIn(a.concurrency),
    httpsVerify: http ? boolIn(a.https_verify_certificate) : base.httpsVerify,
    healthyInterval: numIn(h.interval),
    healthySuccesses: numIn(h.successes),
    healthyStatuses: http ? listIn(h.http_statuses) : base.healthyStatuses,
    unhealthyInterval: numIn(u.interval),
    unhealthyHttpFailures: http ? numIn(u.http_failures) : base.unhealthyHttpFailures,
    unhealthyTcpFailures: numIn(u.tcp_failures),
    unhealthyTimeouts: numIn(u.timeouts),
    unhealthyStatuses: http ? listIn(u.http_statuses) : base.unhealthyStatuses,
    passive: p !== null,
    passiveType: p ? (CHECK_TYPES.find((t) => t === p.type) ?? "") : base.passiveType,
    passiveHealthySuccesses: p ? numIn(ph.successes) : base.passiveHealthySuccesses,
    passiveHealthyStatuses: p ? listIn(ph.http_statuses) : base.passiveHealthyStatuses,
    passiveHttpFailures: p ? numIn(pu.http_failures) : base.passiveHttpFailures,
    passiveTcpFailures: p ? numIn(pu.tcp_failures) : base.passiveTcpFailures,
    passiveTimeouts: p ? numIn(pu.timeouts) : base.passiveTimeouts,
    passiveStatuses: p ? listIn(pu.http_statuses) : base.passiveStatuses,
  };
}

// ── 폼 → JSON (미리보기) ─────────────────────────────────────

/** 파싱되면 숫자, 아니면 null — 편집 중인 칸을 0 으로 보여 주지 않는다 (design.ts 의 `numOut`). */
function numOut(v: string): number | null {
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

/** 상태 코드 칸의 토큰들. 쉼표 · 공백 어느 쪽으로 나눠도 된다. */
const tokens = (v: string): string[] => v.split(/[\s,]+/).filter(Boolean);

function putNum(o: Obj, key: string, v: string): void {
  if (v.trim() !== "") o[key] = numOut(v);
}

function putText(o: Obj, key: string, v: string): void {
  if (v.trim() !== "") o[key] = v.trim();
}

function putList(o: Obj, key: string, v: string): void {
  const t = tokens(v);
  if (t.length > 0) o[key] = t.map(numOut);
}

function putObj(o: Obj, key: string, inner: Obj): void {
  if (Object.keys(inner).length > 0) o[key] = inner;
}

/** 저장 본문의 `checks`. 끈 상태면 undefined — 키 자체가 없다. */
export function checksJson(c: ChecksFormState): Obj | undefined {
  if (!c.enabled) return undefined;
  const http = c.type !== "tcp";

  const active: Obj = { type: c.type };
  if (http) {
    putText(active, "http_path", c.httpPath);
    putText(active, "host", c.host);
  }
  putNum(active, "port", c.port);
  putNum(active, "timeout", c.timeout);
  putNum(active, "concurrency", c.concurrency);
  if (http && c.httpsVerify !== "") active.https_verify_certificate = c.httpsVerify === "true";

  const healthy: Obj = {};
  putNum(healthy, "interval", c.healthyInterval);
  putNum(healthy, "successes", c.healthySuccesses);
  if (http) putList(healthy, "http_statuses", c.healthyStatuses);
  putObj(active, "healthy", healthy);

  const unhealthy: Obj = {};
  putNum(unhealthy, "interval", c.unhealthyInterval);
  if (http) putNum(unhealthy, "http_failures", c.unhealthyHttpFailures);
  putNum(unhealthy, "tcp_failures", c.unhealthyTcpFailures);
  putNum(unhealthy, "timeouts", c.unhealthyTimeouts);
  if (http) putList(unhealthy, "http_statuses", c.unhealthyStatuses);
  putObj(active, "unhealthy", unhealthy);

  const out: Obj = { active };
  if (c.passive) {
    // `passive: {}` 도 APISIX 가 받는다 — 모든 키에 기본값이 있다 (Rust 와 같은 모양).
    const passive: Obj = {};
    if (c.passiveType) passive.type = c.passiveType;
    const ph: Obj = {};
    putNum(ph, "successes", c.passiveHealthySuccesses);
    putList(ph, "http_statuses", c.passiveHealthyStatuses);
    putObj(passive, "healthy", ph);
    const pu: Obj = {};
    putNum(pu, "http_failures", c.passiveHttpFailures);
    putNum(pu, "tcp_failures", c.passiveTcpFailures);
    putNum(pu, "timeouts", c.passiveTimeouts);
    putList(pu, "http_statuses", c.passiveStatuses);
    putObj(passive, "unhealthy", pu);
    out.passive = passive;
  }
  return out;
}

// ── 폼 → 와이어 (Rust ChecksInput) ───────────────────────────

/** 빈 칸은 null. 숫자가 아닌 값은 `checksProblems` 가 저장 전에 막는다. */
const wireNum = (v: string): number | null => (v.trim() === "" ? null : Number(v.trim()));
const wireList = (v: string): number[] => tokens(v).map(Number);

/**
 * `api.upstreamSave` · `api.upstreamProbe` 가 보내는 모양. 숨은 칸(tcp 의 HTTP 칸 등)도
 * 그대로 싣는다 — 저장 본문에서 빼는 판단은 Rust 가 한다 (`apply_checks`).
 */
export function checksWire(c: ChecksFormState): Record<string, unknown> {
  return {
    enabled: c.enabled,
    type: c.type,
    httpPath: c.httpPath.trim(),
    host: c.host.trim(),
    port: wireNum(c.port),
    timeout: wireNum(c.timeout),
    concurrency: wireNum(c.concurrency),
    httpsVerifyCertificate: c.httpsVerify === "" ? null : c.httpsVerify === "true",
    healthy: {
      interval: wireNum(c.healthyInterval),
      successes: wireNum(c.healthySuccesses),
      httpStatuses: wireList(c.healthyStatuses),
    },
    unhealthy: {
      interval: wireNum(c.unhealthyInterval),
      httpFailures: wireNum(c.unhealthyHttpFailures),
      tcpFailures: wireNum(c.unhealthyTcpFailures),
      timeouts: wireNum(c.unhealthyTimeouts),
      httpStatuses: wireList(c.unhealthyStatuses),
    },
    passive: {
      enabled: c.passive,
      type: c.passiveType,
      healthy: {
        successes: wireNum(c.passiveHealthySuccesses),
        httpStatuses: wireList(c.passiveHealthyStatuses),
      },
      unhealthy: {
        httpFailures: wireNum(c.passiveHttpFailures),
        tcpFailures: wireNum(c.passiveTcpFailures),
        timeouts: wireNum(c.passiveTimeouts),
        httpStatuses: wireList(c.passiveStatuses),
      },
    },
  };
}

// ── 검사 ─────────────────────────────────────────────────────

/**
 * 저장 전에 짚어 줄 문제들. Rust `ChecksInput::validate` 와 같은 규칙이고, 여기에 하나라도
 * 있으면 `store.save` 가 저장을 막는다.
 *
 * 먼저 막는 이유는 형식 때문이다 — 정수 칸에 `1.5` 가 들어가면 Rust 가 `i64` 로 읽다가
 * 역직렬화 단계에서 죽고, 그 에러는 어느 칸이 틀렸는지 알려 주지 않는다 (노드 port 와 같다).
 * **저장되지 않는 칸은 보지 않는다** — 꺼 둔 헬스체크 · tcp 의 HTTP 칸 · 꺼 둔 수동 검사.
 */
export function checksProblems(c: ChecksFormState): string[] {
  if (!c.enabled) return [];
  const out: string[] = [];
  const http = c.type !== "tcp";

  const int = (label: string, v: string, min: number, max: number) => {
    const t = v.trim();
    if (t === "") return;
    const n = Number(t);
    if (!Number.isInteger(n) || n < min || n > max) {
      out.push(`${label} 은 ${min}~${max} 사이의 정수여야 합니다.`);
    }
  };
  const list = (label: string, v: string) => {
    const seen = new Set<number>();
    for (const tok of tokens(v)) {
      const n = Number(tok);
      if (!Number.isInteger(n) || n < 200 || n > 599) {
        out.push(`${label} 에 200~599 가 아닌 값이 있습니다 (${tok}).`);
        return;
      }
      if (seen.has(n)) {
        out.push(`${label} 에 ${n} 이 두 번 들어 있습니다.`);
        return;
      }
      seen.add(n);
    }
  };

  if (http) {
    const path = c.httpPath.trim();
    if (path !== "" && (!path.startsWith("/") || /\s/.test(path))) {
      out.push("http_path 는 / 로 시작하고 공백이 없어야 합니다.");
    }
    if (/\s/.test(c.host.trim())) out.push("host 에 공백을 쓸 수 없습니다.");
    list("정상 판정 http_statuses", c.healthyStatuses);
    list("장애 판정 http_statuses", c.unhealthyStatuses);
    int("장애 판정 http_failures", c.unhealthyHttpFailures, 1, 254);
  }
  int("port", c.port, 1, 65535);
  const t = c.timeout.trim();
  if (t !== "" && !(Number.isFinite(Number(t)) && Number(t) > 0)) {
    out.push("timeout 은 0 보다 큰 숫자여야 합니다.");
  }
  int("concurrency", c.concurrency, 1, Number.MAX_SAFE_INTEGER);
  int("정상 판정 interval", c.healthyInterval, 1, Number.MAX_SAFE_INTEGER);
  int("정상 판정 successes", c.healthySuccesses, 1, 254);
  int("장애 판정 interval", c.unhealthyInterval, 1, Number.MAX_SAFE_INTEGER);
  int("장애 판정 tcp_failures", c.unhealthyTcpFailures, 1, 254);
  int("장애 판정 timeouts", c.unhealthyTimeouts, 1, 254);

  if (c.passive) {
    list("수동 검사 정상 판정 http_statuses", c.passiveHealthyStatuses);
    int("수동 검사 정상 판정 successes", c.passiveHealthySuccesses, 1, 254);
    list("수동 검사 http_statuses", c.passiveStatuses);
    int("수동 검사 http_failures", c.passiveHttpFailures, 1, 254);
    int("수동 검사 tcp_failures", c.passiveTcpFailures, 1, 254);
    int("수동 검사 timeouts", c.passiveTimeouts, 1, 254);
  }
  return out;
}

// ── 기본값으로 자동설정 ──────────────────────────────────────

/**
 * 운영에서 쓰는 헬스체크 설정 — '기본값으로 자동설정' 버튼이 채우는 값이다.
 *
 * `host` · `port` 는 없다. upstream 마다 달라서 누를 때 편집 중인 노드에서 가져온다
 * (`presetChecks`). 이 값이 폼 칸만으로 그대로 저장되는지는 Rust 테스트
 * `preset_builds_the_reference_config_exactly` 가 운영 JSON 과 대조해 못 박아 둔다 —
 * 값을 바꾸면 그 테스트의 기준 JSON 도 함께 고친다.
 */
export const CHECK_PRESET: Omit<ChecksFormState, "host" | "port"> = {
  enabled: true,
  type: "http",
  httpPath: "/actuator/health",
  timeout: "2",
  concurrency: "10",
  httpsVerify: "false",
  healthyInterval: "5",
  healthySuccesses: "2",
  healthyStatuses: "200",
  unhealthyInterval: "2",
  unhealthyHttpFailures: "3",
  unhealthyTcpFailures: "3",
  unhealthyTimeouts: "3",
  unhealthyStatuses: "404, 500, 502, 503, 504",
  passive: true,
  passiveType: "http",
  passiveHealthySuccesses: "3",
  passiveHealthyStatuses: "200, 201, 204, 301, 302",
  passiveHttpFailures: "3",
  passiveTcpFailures: "3",
  passiveTimeouts: "3",
  passiveStatuses: "502, 503, 504",
};

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/**
 * `CHECK_PRESET` + 편집 중인 노드의 host · port.
 *
 * 노드가 여럿이고 값이 서로 다르면 그 칸은 **비운다.** `checks.active.port` 는 모든 노드의 검사
 * 포트를 한 값으로 바꾸므로 첫 노드의 포트를 채우면 다른 포트의 노드가 틀린 포트로 검사돼
 * 장애로 빠진다. 비워 두면 APISIX 가 각 노드를 자기 host · port 로 검사한다 — "upstream 의
 * host · port 를 그대로" 가 노드마다 성립하는 쪽이다. `host`(Host 헤더)도 같은 규칙이다.
 * 왜 비웠는지는 `notes` 로 돌려줘 화면이 알린다.
 */
export function presetChecks(nodes: UpstreamNodeInput[]): {
  checks: ChecksFormState;
  notes: string[];
} {
  const filled = nodes.filter((n) => n.host.trim() !== "");
  const hosts = uniq(filled.map((n) => n.host.trim()));
  const ports = uniq(filled.map((n) => n.port.trim()).filter(Boolean));
  const notes: string[] = [];

  if (filled.length === 0) {
    notes.push("노드가 비어 있어 host · port 를 채우지 못했습니다 — 노드를 입력한 뒤 다시 누르세요.");
  } else {
    if (hosts.length > 1) {
      notes.push(
        `노드마다 host 가 달라(${hosts.join(", ")}) host 는 비워 두었습니다 — 각 노드의 주소가 그대로 Host 헤더로 갑니다.`,
      );
    }
    if (ports.length > 1) {
      notes.push(
        `노드마다 port 가 달라(${ports.join(", ")}) port 는 비워 두었습니다 — 각 노드를 자기 port 로 검사합니다.`,
      );
    } else if (ports.length === 0) {
      notes.push("노드의 port 가 비어 있어 port 를 채우지 못했습니다.");
    }
  }

  return {
    checks: {
      ...CHECK_PRESET,
      host: hosts.length === 1 ? hosts[0] : "",
      port: ports.length === 1 ? ports[0] : "",
    },
    notes,
  };
}

/**
 * 검사 host · port 가 지금의 노드와 어긋나는지 — 노드를 고친 뒤 자동설정을 다시 누르지 않은
 * 경우를 잡는다. 저장은 막지 않는다 (일부러 다른 포트로 검사하는 upstream 도 있다).
 */
export function checksNodeWarnings(c: ChecksFormState, nodes: UpstreamNodeInput[]): string[] {
  if (!c.enabled) return [];
  const filled = nodes.filter((n) => n.host.trim() !== "");
  if (filled.length === 0) return [];
  const out: string[] = [];
  const port = c.port.trim();
  if (port !== "") {
    if (!filled.some((n) => n.port.trim() === port)) {
      out.push(`검사 port ${port} 가 어느 노드의 port 와도 다릅니다.`);
    } else if (uniq(filled.map((n) => n.port.trim())).length > 1) {
      out.push(`노드마다 port 가 다른데 검사 port 가 ${port} 로 고정돼 있어 다른 노드도 ${port} 로 검사합니다.`);
    }
  }
  const host = c.host.trim();
  if (c.type !== "tcp" && host !== "" && !filled.some((n) => n.host.trim() === host)) {
    out.push(`검사 host ${host} 가 어느 노드의 host 와도 다릅니다 (Host 헤더로만 쓰입니다).`);
  }
  return out;
}

/** 세부 설정을 접었을 때 보여 줄 한 줄 — 빈 칸은 기본값으로 읽는다. */
export function checksSummary(c: ChecksFormState): string {
  const v = (x: string, d: string) => (x.trim() === "" ? d : x.trim());
  const http = c.type !== "tcp";
  const parts = [
    `timeout ${v(c.timeout, CHECK_DEFAULTS.timeout)}초`,
    `정상 ${v(c.healthyInterval, CHECK_DEFAULTS.healthyInterval)}초마다 ${v(c.healthySuccesses, CHECK_DEFAULTS.healthySuccesses)}회 성공`,
    `장애 ${v(c.unhealthyInterval, CHECK_DEFAULTS.unhealthyInterval)}초마다 ` +
      [
        http ? `HTTP ${v(c.unhealthyHttpFailures, CHECK_DEFAULTS.unhealthyHttpFailures)}` : "",
        `TCP ${v(c.unhealthyTcpFailures, CHECK_DEFAULTS.unhealthyTcpFailures)}`,
        `시간 초과 ${v(c.unhealthyTimeouts, CHECK_DEFAULTS.unhealthyTimeouts)}회`,
      ]
        .filter(Boolean)
        .join(" · "),
    c.passive ? "수동 검사 사용" : "수동 검사 안 함",
  ];
  return parts.join("  /  ");
}

// ── 표시 ─────────────────────────────────────────────────────

/**
 * 게이트웨이의 `checks` 를 한 줄로 — 목록 열 · 상태 카드 제목. `http /health` · `tcp`,
 * 수동 검사가 있으면 `+ passive`. 헬스체크가 없으면 빈 문자열.
 */
export function checksLabel(v: unknown): string {
  const o = asObj(v);
  if (!o) return "";
  const a = asObj(o.active) ?? {};
  const type = text(a.type) || "http";
  const path = type !== "tcp" ? text(a.http_path) || "/" : "";
  return [type, path, o.passive ? "+ passive" : ""].filter(Boolean).join(" ");
}

/** 헬스체커 노드 상태 → 뱃지 톤 · 문구. */
export function healthTone(status: string): { tone: string; text: string } {
  switch (status) {
    case "healthy":
      return { tone: "success", text: "정상" };
    case "mostly_healthy":
      return { tone: "warning", text: "대체로 정상" };
    case "mostly_unhealthy":
      return { tone: "warning", text: "대체로 장애" };
    case "unhealthy":
      return { tone: "error", text: "장애" };
    default:
      return { tone: "neutral", text: status || "알 수 없음" };
  }
}

/**
 * 트래픽을 받는 노드인가. `mostly_healthy` 는 실패가 섞이기 시작했지만 아직 정상으로 판정된
 * 상태라 받는다 쪽이다 (lua-resty-healthcheck 의 네 상태 — 앞의 두 개가 healthy 쪽).
 */
export const isUp = (n: HealthNode): boolean =>
  n.status === "healthy" || n.status === "mostly_healthy";

/** 카운터 한 줄 — 2.x 처럼 카운터가 없으면 빈 문자열. */
export function counterText(n: HealthNode): string {
  const parts: Array<[string, number | null]> = [
    ["성공", n.success],
    ["HTTP 실패", n.httpFailure],
    ["TCP 실패", n.tcpFailure],
    ["시간 초과", n.timeoutFailure],
  ];
  return parts
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
}
