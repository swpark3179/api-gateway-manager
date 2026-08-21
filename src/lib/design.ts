/**
 * 디자인 원본(`API Gateway 관리자.dc.html`)의 순수 헬퍼를 그대로 옮긴 것.
 * JSON 탭이 보여주는 본문 모양, 메서드 목록, 레일 아이콘 path 등이 여기에 모여 있다.
 *
 * 주의: 여기서 만드는 JSON 은 **화면 표시/편집용 축약형**이다. 실제 저장은 Rust 가
 * 원본 리소스를 GET 해 앱이 관리하는 키만 덮어쓰는 머지 방식으로 처리하므로,
 * 이 JSON 에 없는 플러그인(limit-count 등)도 보존된다.
 */

import type {
  ConsumerFormState,
  FormState,
  GroupsLocation,
  RouteFormState,
  Section,
} from "../types";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** 아이콘 레일의 SVG path — 디자인의 railIcons 그대로 */
export const RAIL_ICONS: Record<Section, string> = {
  dash: "M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 13h6v6h-6z",
  routes: "M6 4v6a4 4 0 0 0 4 4h8M18 10l3 4-3 4",
  consumers: "M4 20a5 5 0 0 1 10 0M9 4a3.2 3.2 0 1 1 0 6.4A3.2 3.2 0 0 1 9 4M16 20a5 5 0 0 0-2-4",
  // 서버 스택 — upstream 의 노드 묶음
  upstreams: "M4 6h16v4H4zM4 14h16v4H4M7 8h.01M7 16h.01",
  // 분기 — service 가 여러 route 를 묶는 모양
  services: "M5 4v4a3 3 0 0 0 3 3h11M5 20v-4a3 3 0 0 1 3-3h11M16 8l3 3-3 3M16 10l3 3-3 3",
  settings:
    "M12 15.2A3.2 3.2 0 1 0 12 8.8a3.2 3.2 0 0 0 0 6.4M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.4-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z",
};

export const RAIL: Array<{ key: Section; label: string }> = [
  { key: "dash", label: "대시보드" },
  { key: "routes", label: "Route" },
  { key: "consumers", label: "Consumer" },
  { key: "upstreams", label: "Upstream" },
  { key: "services", label: "Service" },
  { key: "settings", label: "설정" },
];

/** 개발/운영 세그먼트 토글 스타일 — 디자인의 seg() */
export const segStyle = (on: boolean): React.CSSProperties => ({
  padding: "3px 14px",
  borderRadius: 4,
  font: "600 11px/16px var(--font-sans)",
  cursor: "pointer",
  transition: "all 120ms",
  ...(on ? { background: "var(--purple-500)", color: "#fff" } : { color: "var(--gray-400)" }),
});

/** 레일 항목 스타일 — 디자인의 rail[].style */
export const railStyle = (on: boolean): React.CSSProperties => ({
  width: 48,
  height: 50,
  borderRadius: 8,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 3,
  cursor: "pointer",
  transition: "all 120ms",
  ...(on
    ? { background: "var(--purple-50)", color: "var(--purple-700)" }
    : { color: "var(--gray-500)" }),
});

// ── 권한그룹 위치 (Rust 의 find_groups / set_groups_at 대응) ──
//
// Rust 는 여섯 가지 표기를 모든 플러그인과 최상위에서 훑어 값을 찾고(find_groups),
// **찾은 자리에 그대로** 되쓴다(set_groups_at). 이 파일이 그걸 무시하고 표준 표기만
// 읽고 쓰면, 값이 `auth_groups` 에 있던 컨슈머는 '폼에 적용' 한 번으로 groups 가 비고
// 그대로 저장하면 게이트웨이의 권한이 조용히 사라진다. 그래서 위치를 따라간다.

/** Rust 의 GroupsLocation::default() 와 같아야 한다 (models.rs). */
const CONSUMER_LOC: GroupsLocation = { plugin: "jwt-auth", key: "auth-groups", asCsv: false };
/** RouteView::from_value 가 쓰는 기본 위치 (models.rs 의 find_groups 호출부). */
const ROUTE_LOC: GroupsLocation = { plugin: "shi-auth", key: "allowed_groups", asCsv: false };

/** 그룹 목록을 `loc` 가 가리키는 자리에, 읽은 형태(배열/CSV) 그대로 써 넣는다. */
function putGroups(
  o: Record<string, any>,
  loc: GroupsLocation | null,
  fallback: GroupsLocation,
  groups: string[],
): void {
  const l = loc ?? fallback;
  const v: unknown = l.asCsv ? groups.join(",") : groups;
  if (!l.plugin) {
    o[l.key] = v;
    return;
  }
  o.plugins = o.plugins ?? {};
  o.plugins[l.plugin] = { ...(o.plugins[l.plugin] ?? {}), [l.key]: v };
}

/** 같은 자리에서 읽는다. 배열과 CSV 문자열을 모두 받아들인다 (Rust 의 to_string_list 대응). */
function pickGroups(
  o: Record<string, any>,
  loc: GroupsLocation | null,
  fallback: GroupsLocation,
): string[] {
  const l = loc ?? fallback;
  const raw = l.plugin ? o?.plugins?.[l.plugin]?.[l.key] : o?.[l.key];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * 경로 접두사 → route 명 접두사. `/v1` → `V1/`
 *
 * **표시 전용이다.** 실제로 폼에 채워지는 값은 Rust 가 계산한 `CompareRow.suggestedName`
 * 이고(`oas::name_prefix` · `oas::suggested_name`, 테스트가 붙어 있다), 이 함수는 접두사를
 * 입력하는 중에 "그래서 이름이 어떻게 되는가"를 미리 보여 주기 위한 것뿐이다.
 * 규칙이 바뀌면 Rust 쪽이 진실이다.
 */
export function nameFromPrefix(prefix: string): string {
  const core = prefix.trim().replace(/^\/+|\/+$/g, "");
  return core ? `${core.toUpperCase()}/` : "";
}

// ── JSON 탭 본문 ─────────────────────────────────────────────

export function routeJson(f: RouteFormState): Record<string, unknown> {
  const plugins: Record<string, unknown> = {};
  if (f.rewrite) plugins["proxy-rewrite"] = { uri: f.rewrite };
  const o: Record<string, any> = {
    uri: f.uri,
    name: f.name,
    desc: f.desc,
    methods: f.methods,
    // 디자인은 1 로 고정해 두었지만, 기존 라우트의 실제 status 를 보여주는 편이 정확하다.
    // (저장 시에도 이 값이 유지된다 — 신규는 항상 1)
    status: f.status,
    service_id: f.serviceId,
    plugins,
  };
  putGroups(o, f.groupsLocation, ROUTE_LOC, f.groups);
  return o;
}

/**
 * `labels`(담당자)는 여기 넣지 않는다.
 *
 * 넣으면 `name{n}` 번호 규칙(재번호 · 앞자리 0 배제 · 빈 값 생략)을 TS 에도 구현해야 하고,
 * 그 규칙이 두 곳에 있으면 반드시 어긋난다 (types.ts 의 suggestedUri 주석과 같은 이유).
 * `jsonToForm` 이 `...current` 를 펼치므로 `contacts` 는 JSON 탭을 왕복해도 그대로 살아남는다.
 */
export function consumerJson(f: ConsumerFormState): Record<string, unknown> {
  const o: Record<string, any> = {
    username: f.username,
    desc: f.desc,
    plugins: { "jwt-auth": { key: f.key, secret: f.secret } },
  };
  putGroups(o, f.groupsLocation, CONSUMER_LOC, f.groups);
  return o;
}

/**
 * JSON 탭이 다루는 것은 route · consumer 뿐이다.
 *
 * Service · Upstream 은 폼 탭만 두었다 (EditScreen 의 탭 목록 참조). 두 리소스의 JSON 을
 * 내보내려면 `labels.spec_url` 과 nodes 표기 규칙을 TS 에도 구현해야 하고, 그 규칙이 두 곳에
 * 있으면 반드시 어긋난다 — `consumerJson` 이 labels 를 내보내지 않는 것과 같은 판단이다.
 * 그래서 그 두 형태는 폼을 그대로 직렬화해 미리보기만 성립하게 한다.
 */
export function formJson(f: FormState): Record<string, unknown> {
  if (f.kind === "consumer") return consumerJson(f);
  if (f.kind === "route") return routeJson(f);
  const { kind: _kind, ...rest } = f;
  return rest;
}

export function jsonText(f: FormState): string {
  return JSON.stringify(formJson(f), null, 2);
}

/** JSON 탭의 '폼에 적용' — 디자인의 applyJson() */
export function jsonToForm(raw: string, current: FormState): FormState {
  const o = JSON.parse(raw) as Record<string, any>;

  // JSON 탭이 없는 형태는 그대로 돌려준다 (formJson 주석 참조).
  if (current.kind === "service" || current.kind === "upstream") return current;

  if (current.kind === "consumer") {
    const j = (o.plugins && o.plugins["jwt-auth"]) || {};
    return {
      // contacts 는 여기서 덮어쓰지 않는다 — consumerJson 이 labels 를 내보내지 않으므로
      // 펼쳐진 current 값이 그대로 유지되는 것이 맞다.
      ...current,
      username: o.username || "",
      desc: o.desc || "",
      key: j.key || "",
      secret: j.secret || "",
      groups: pickGroups(o, current.groupsLocation, CONSUMER_LOC),
    };
  }

  const p = o.plugins || {};
  return {
    ...current,
    uri: o.uri || "",
    name: o.name || "",
    desc: o.desc || "",
    methods: Array.isArray(o.methods) ? o.methods : [],
    serviceId: o.service_id || "",
    rewrite: (p["proxy-rewrite"] && p["proxy-rewrite"].uri) || "",
    groups: pickGroups(o, current.groupsLocation, ROUTE_LOC),
    status: typeof o.status === "number" ? o.status : current.status,
  };
}

/**
 * 디자인의 methods 칩은 선택 순서와 무관하게 항상 표준 순서로 정렬된다.
 *
 * 표준 목록(METHODS)에 없는 메서드는 **버리지 않고 뒤에 붙인다.** 이 앱 밖에서 등록된
 * 라우트나 OAS 스펙은 CONNECT · TRACE · PURGE 를 쓸 수 있고, 조용히 떨어뜨리면 칩 하나만
 * 눌러도 게이트웨이의 methods 가 바뀌어 저장된다.
 */
export function sortMethods(list: string[]): string[] {
  const known = METHODS.filter((m) => list.includes(m));
  const extra = [...new Set(list.filter((m) => m && !METHODS.includes(m)))].sort();
  return [...known, ...extra];
}

/** 폼에 실제로 들어 있는 값까지 포함한 칩 목록 — 표준 외 메서드가 화면에서 사라지지 않게 한다. */
export function methodChips(selected: string[]): string[] {
  return sortMethods([...METHODS, ...selected]);
}

/** Consumer 목록의 secret 열 표기 — 디자인의 `secret.slice(0,8) + '••••••••'` */
export function maskSecret(secret: string): string {
  if (!secret) return "—";
  return secret.slice(0, 8) + "••••••••";
}

/**
 * 목록 상단의 마지막 동기화 시각 — `동기화 14:22`.
 *
 * 상대 표기("5분 전")를 쓰지 않는 이유: 타이머를 걸고 12px 라벨 하나 때문에 헤더를 매분
 * 재렌더해야 하고, 바로 옆 '수정일시' 열이 이미 절대 표기다.
 */
export function syncLabel(ts: number | null): string {
  if (ts == null) return "동기화 안 됨";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `동기화 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
