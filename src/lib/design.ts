/**
 * 디자인 원본(`API Gateway 관리자.dc.html`)의 순수 헬퍼를 그대로 옮긴 것.
 * JSON 탭이 보여주는 본문 모양, 메서드 목록, 레일 아이콘 path 등이 여기에 모여 있다.
 *
 * 주의: 여기서 만드는 JSON 은 **화면 표시/편집용 축약형**이다. 실제 저장은 Rust 가
 * 원본 리소스를 GET 해 앱이 관리하는 키만 덮어쓰는 머지 방식으로 처리하므로,
 * 이 JSON 에 없는 플러그인(limit-count 등)도 보존된다.
 */

import { rewriteModeOf } from "../types";
import type {
  ConsumerFormState,
  Contact,
  FormState,
  GroupsLocation,
  RouteFormState,
  Section,
  ServiceFormState,
  UpstreamFormState,
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

/**
 * on/off 스위치의 트랙 — 설정 화면의 토글과 Service 폼의 jwt-auth 토글이 같이 쓴다.
 *
 * `Settings.tsx` 안에 private 으로 있던 것을 옮겨 왔다. 스위치 모양이 두 곳으로 갈라지면
 * 같은 뜻의 컨트롤이 화면마다 달라 보인다 — `segStyle` · `railStyle` 이 여기 있는 것과 같은
 * 이유다.
 *
 * 키보드 어포던스는 없다(`<div onClick>` 으로 쓰인다). 앱 전체가 그러하므로 여기서만
 * `role="switch"` 를 붙이면 절반만 된 접근성이 된다 — 별건으로 둔다.
 */
export const switchStyle = (on: boolean): React.CSSProperties => ({
  width: 44,
  height: 24,
  borderRadius: 1000,
  padding: 3,
  cursor: "pointer",
  transition: "background 120ms",
  flex: "0 0 auto",
  display: "flex",
  justifyContent: on ? "flex-end" : "flex-start",
  background: on ? "var(--purple-600)" : "var(--gray-300)",
});

/** 스위치의 손잡이 — `switchStyle` 의 짝. */
export const switchKnobStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: "50%",
  background: "#fff",
  boxShadow: "var(--shadow-xs)",
};

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
 * 이고(`oas::name_prefix` · `oas::suggested_name_for`, 테스트가 붙어 있다), 이 함수는 접두사를
 * 입력하는 중에 "그래서 이름이 어떻게 되는가"를 미리 보여 주기 위한 것뿐이다.
 * 규칙이 바뀌면 Rust 쪽이 진실이다.
 *
 * service 의 name 접두어가 이기는 경우까지 합친 실효 접두사는 `routeNamePrefix` 다.
 */
export function nameFromPrefix(prefix: string): string {
  const core = prefix.trim().replace(/^\/+|\/+$/g, "");
  return core ? `${core.toUpperCase()}/` : "";
}

/**
 * 실효 route 명 접두사 — service 의 `labels.name_prefix` 가 있으면 그것이 이긴다.
 *
 * service 접두어는 **입력한 그대로** 쓴다. 경로 접두사와 달리 대문자로 바꾸지 않고 뒤에
 * 슬래시를 붙이지도 않는다 — 접두어가 자기 구분자(`/`·`_`)를 들고 있기 때문이다.
 *
 * `nameFromPrefix` 와 같은 **표시 전용**이다. 실제로 폼에 채워지는 값은 Rust 의
 * `oas::suggested_name_for` 가 계산해 `CompareRow.suggestedName` 으로 내려보낸다.
 */
export function routeNamePrefix(servicePrefix: string, pathPrefix: string): string {
  const svc = servicePrefix.trim();
  return svc || nameFromPrefix(pathPrefix);
}

// ── JSON 탭 본문 ─────────────────────────────────────────────

export function routeJson(f: RouteFormState): Record<string, unknown> {
  const plugins: Record<string, unknown> = {};
  // `uri` 와 `regex_uri` 중 **한쪽만** 내보낸다. APISIX 는 `uri` 가 있으면 `regex_uri` 를
  // 무시하므로(proxy-rewrite.lua), 둘을 함께 그리면 이 화면이 게이트웨이 동작과 다른 말을
  // 하게 된다. 저장 본문도 같은 규칙이다 (Rust `apply_route_form`).
  if (f.rewriteMode === "regex") {
    // 빈 항목을 **걸러 내지 않는다** — 걸러 내면 쌍이 밀려 엉뚱한 패턴·치환이 짝이 된다.
    // 반쯤 채운 상태는 아직 저장할 수 없는 값이라 아예 그리지 않는다 (Rust `validate` 가 막는다).
    const v = f.rewriteRegex.map((x) => x.trim());
    if (v.length >= 2 && v.length % 2 === 0 && v.every(Boolean)) {
      plugins["proxy-rewrite"] = { regex_uri: v };
    }
  } else if (f.rewrite) {
    plugins["proxy-rewrite"] = { uri: f.rewrite };
  }
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

// ── 담당자 (labels · name{n} / dept{n}) ──────────────────────
//
// 아래 두 함수는 Rust `models::set_contacts_at` · `contacts_of` 의 **표시 전용 사본**이다
// (`nameFromPrefix` 와 같은 위치 — 규칙이 바뀌면 Rust 쪽이 진실이다). 폼에서 담당자를
// 입력했는데 JSON 탭 텍스트가 한 글자도 바뀌지 않는 편이 더 나쁘다고 판단해서 두었다.
//
// 사본이니만큼 원본과 어긋나기 쉬운 두 지점을 그대로 옮겨 놓았다. 고칠 때 함께 보라:
//  · 번호는 **빈 행을 걸러낸 뒤** 붙인다. 배열 인덱스로 매기면 미리보기는 name1/name3,
//    저장 결과는 name1/name2 가 되어 화면이 거짓말을 한다.
//  · 앞자리 0(`name01`)·`name0`·맨 `name` 은 우리 키가 아니다. 인식하면 재번호 과정에서
//    `name1` 과 충돌해 한쪽이 조용히 사라진다.
// 게이트웨이의 다른 라벨(`spec_url` 등)은 여기 보이지 않지만 저장 때 보존된다 — JSON 탭이
// "앱이 관리하는 키만" 보여 준다는 계약 그대로다. 그래서 여기에 남의 라벨을 적어도 무시된다.

/** 담당자 목록 → `labels`. 빈 행을 걸러 1..N 으로 조밀하게 번호를 매긴다. */
export function contactLabels(contacts: Contact[]): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const c of contacts) {
    const name = c.name.trim();
    const dept = c.dept.trim();
    if (!name && !dept) continue;
    n += 1;
    // APISIX 의 label 값은 minLength = 1 이라 빈 값은 "" 가 아니라 키를 생략한다.
    if (name) out[`name${n}`] = name;
    if (dept) out[`dept${n}`] = dept;
  }
  return out;
}

/** `labels` → 담당자 목록. 숫자 순으로 모은다 (문자열 순이면 name10 이 name2 앞에 온다). */
export function contactsFromLabels(labels: unknown): Contact[] {
  if (!labels || typeof labels !== "object") return [];
  const acc = new Map<number, Contact>();

  for (const [k, v] of Object.entries(labels as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    const field = k.startsWith("name") ? "name" : k.startsWith("dept") ? "dept" : null;
    if (!field) continue;
    const rest = k.slice(4);
    const n = Number(rest);
    // `String(n) === rest` 가 앞자리 0 과 빈 문자열을 걸러 낸다 (Rust 의 label_index).
    if (!Number.isInteger(n) || n < 1 || String(n) !== rest) continue;
    const row = acc.get(n) ?? { name: "", dept: "" };
    row[field] = s;
    acc.set(n, row);
  }

  return [...acc.keys()].sort((a, b) => a - b).map((n) => acc.get(n)!);
}

/**
 * `labels` 는 담당자가 없어도 **항상** 내보낸다.
 *
 * 조건부로 생략하면 "이 컨슈머는 담당자가 없다" 와 "이 초안은 담당자를 언급하지 않는다" 를
 * 구별할 수 없어진다. `jsonToForm` 이 그 구별에 기대어 담당자를 지킨다 (그쪽 주석 참조).
 */
export function consumerJson(f: ConsumerFormState): Record<string, unknown> {
  const o: Record<string, any> = {
    username: f.username,
    desc: f.desc,
    plugins: { "jwt-auth": { key: f.key, secret: f.secret } },
    labels: contactLabels(f.contacts),
  };
  putGroups(o, f.groupsLocation, CONSUMER_LOC, f.groups);
  return o;
}

// ── 숫자 필드 (Upstream) ─────────────────────────────────────
//
// 폼은 port · weight · timeout 을 **문자열로** 들고 있다 (편집 중 빈 칸이 가능해야 한다 —
// types.ts 의 UpstreamNodeInput 주석). 그 문자열을 JSON 본문의 숫자로 옮기는 규칙이다.
//
// `api.ts::upstreamSave` 의 `Number()` 와 **일부러 다르다.** 저쪽은 와이어라서 Rust 의
// `NodeInput.port: i64` · `UpstreamTimeout: f64` (둘 다 non-Option) 에 맞춰야 하고, 빈 값은
// `store.save` 의 필수값 검사가 이미 막는다. 이쪽은 미리보기라서 편집 중인 빈 칸을 `0` 으로
// 보여 주면 거짓말이 된다.

/** 파싱되면 숫자, 아니면 `null` — "아직 값이 없다" 를 그대로 보여 준다. */
function numOut(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 되돌리기. 유한한 숫자만 받고 그 밖은 빈 칸으로 둔다 (폼이 경고를 띄운다). */
function numIn(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

/**
 * Upstream 의 앱 관리 키.
 *
 * `type` 은 넣지 않는다 — Rust 는 원본에 **없을 때만** 기본값을 채우고 이미 있으면 손대지
 * 않는다 (`apply_upstream_form`). 앱이 관리하는 값이 아니므로 여기서 보여 주면 편집할 수 있는
 * 것처럼 보이고, 실제로는 저장 때 무시된다. `checks` · `retries` 등도 같은 이유로 없다.
 *
 * `weight` 는 **넣는다.** 폼에는 없지만 요청 본문에는 항상 들어가는 값이라, 빼 두면 JSON 탭을
 * 한 번 왕복하는 것만으로 게이트웨이의 가중치가 1 로 덮인다 (types.ts 의 UpstreamNode 주석).
 */
export function upstreamJson(f: UpstreamFormState): Record<string, unknown> {
  return {
    name: f.name,
    desc: f.desc,
    nodes: f.nodes.map((n) => ({
      host: n.host,
      port: numOut(n.port),
      weight: numOut(n.weight),
    })),
    timeout: {
      connect: numOut(f.timeout.connect),
      send: numOut(f.timeout.send),
      read: numOut(f.timeout.read),
    },
  };
}

/**
 * Service 의 앱 관리 키.
 *
 * 어느 키가 **생기고 사라지는지**는 실제 저장(services.rs 의 `apply_service_form`)과 같다 —
 * jwt-auth 토글 · 빈 `log-key` · 빈 `plugins` 모두 여기서도 키가 없어진다. 미리보기가
 * `plugins: {}` 같은 빈 껍데기를 보여 주면 저장 결과와 어긋난다.
 *
 * 남은 차이는 **값을 보존하는 대목**이고, `routeJson` 이 `plugins` 를 통째로 보여 주는 것과
 * 같은 종류의 근사다 (JSON 탭 자체가 "앱이 관리하는 키만" 이라고 밝히고 있다):
 *  · `plugins."jwt-auth": {}` — 게이트웨이에 이미 설정이 있으면 그 값이 **유지**된다.
 *  · `plugins."shi-log"` — `key` 만 갈아 끼우고 `level` 같은 다른 필드는 보존된다.
 *  · `labels` — 앱이 관리하는 `spec_url` · `name_prefix` 만 보이지만 나머지 라벨(담당자 등)은
 *    그대로 보존된다.
 */
export function serviceJson(f: ServiceFormState): Record<string, unknown> {
  const o: Record<string, any> = {
    name: f.name,
    desc: f.desc,
    upstream_id: f.upstreamId,
  };
  // 두 플러그인 모두 조건부다. 하나도 없으면 `plugins` 키 자체를 만들지 않는다 — 아래
  // labels 와 같은 규칙이고, Rust 도 같은 판단을 한다 (빈 껍데기를 남기지 않는다).
  const plugins: Record<string, unknown> = {};
  if (f.jwtAuth) plugins["jwt-auth"] = {};
  if (f.logKey.trim()) plugins["shi-log"] = { key: f.logKey };
  if (Object.keys(plugins).length > 0) o.plugins = plugins;
  // 빈 값이면 그 라벨을 지우는 쪽이라(Rust 의 set_label) 키를 만들지 않는다. 둘 다 비면
  // labels 키 자체가 없다 — 저장 때 라벨이 하나도 남지 않는 경우와 같은 모양이다.
  const labels: Record<string, string> = {};
  if (f.specUrl.trim()) labels.spec_url = f.specUrl;
  if (f.namePrefix.trim()) labels.name_prefix = f.namePrefix;
  if (Object.keys(labels).length > 0) o.labels = labels;
  return o;
}

/** 형태별 요청 본문. 네 형태 모두 JSON 탭을 쓴다. */
export function formJson(f: FormState): Record<string, unknown> {
  switch (f.kind) {
    case "consumer":
      return consumerJson(f);
    case "route":
      return routeJson(f);
    case "upstream":
      return upstreamJson(f);
    case "service":
      return serviceJson(f);
    default: {
      // 형태가 하나 늘면 여기서 컴파일이 깨진다. 조용히 폼을 덤프하던 예전 폴백은
      // `applyJson` 이 아무 일도 안 하고도 "반영했습니다" 라고 말하게 만들었다.
      const exhaustive: never = f;
      return exhaustive;
    }
  }
}

export function jsonText(f: FormState): string {
  return JSON.stringify(formJson(f), null, 2);
}

/**
 * JSON 탭의 '폼에 적용' — 디자인의 applyJson()
 *
 * 모든 분기가 `...current` 를 펼친 뒤 아는 키만 덮는다. 폼에 있지만 JSON 에 없는 값
 * (`id` · `groupsLocation` · `isNew` …)이 왕복 한 번에 사라지지 않게 하기 위해서다.
 */
export function jsonToForm(raw: string, current: FormState): FormState {
  const o = JSON.parse(raw) as Record<string, any>;

  switch (current.kind) {
    case "consumer": {
      const j = (o.plugins && o.plugins["jwt-auth"]) || {};
      return {
        ...current,
        username: o.username || "",
        desc: o.desc || "",
        key: j.key || "",
        secret: j.secret || "",
        groups: pickGroups(o, current.groupsLocation, CONSUMER_LOC),
        // 담당자는 **키가 있을 때만** 덮는다. `{}` 로 비우는 것은 지우겠다는 뜻이지만,
        // labels 를 아예 언급하지 않은 본문(남의 컨슈머에서 복사해 온 것 등)은 "건드리지
        // 말라" 로 읽는다. 저장 시 `contacts: []` 는 게이트웨이 라벨을 실제로 지우므로
        // (api.ts 의 consumerSave 주석), 빠뜨렸을 때 유지되는 쪽으로 degrade 해야 한다.
        contacts: "labels" in o ? contactsFromLabels(o.labels) : current.contacts,
      };
    }

    case "route": {
      const p = o.plugins || {};
      const pr = p["proxy-rewrite"] || {};
      // 문자열 배열일 때만 받는다. 모드는 값에서 파생하므로 `routeJson` 이 낸 본문을 그대로
      // 되읽어도 같은 폼이 나온다 (JSON 탭 왕복이 무손실이어야 한다).
      const regex: string[] = Array.isArray(pr.regex_uri)
        ? pr.regex_uri.filter((x: unknown): x is string => typeof x === "string")
        : [];
      return {
        ...current,
        uri: o.uri || "",
        name: o.name || "",
        desc: o.desc || "",
        methods: Array.isArray(o.methods) ? o.methods : [],
        serviceId: o.service_id || "",
        rewrite: (typeof pr.uri === "string" && pr.uri) || "",
        rewriteMode: rewriteModeOf(regex),
        rewriteRegex: regex,
        groups: pickGroups(o, current.groupsLocation, ROUTE_LOC),
        status: typeof o.status === "number" ? o.status : current.status,
      };
    }

    case "upstream": {
      const rows: unknown[] = Array.isArray(o.nodes) ? o.nodes : [];
      const nodes = rows.map((n) => {
        const r = (n ?? {}) as Record<string, any>;
        // 행을 조용히 버리지 않는다 — 사용자가 센 노드 수가 적용 후에 달라지면 안 된다.
        return {
          host: typeof r.host === "string" ? r.host : "",
          port: numIn(r.port),
          weight: numIn(r.weight),
        };
      });
      const t = (o.timeout ?? {}) as Record<string, any>;
      return {
        ...current,
        name: o.name || "",
        desc: o.desc || "",
        // 노드가 하나도 없는 upstream 은 게이트웨이가 거부한다 — 빈 행 하나는 남긴다
        // (upstreamToForm · removeNode 가 지키는 것과 같은 불변식).
        nodes: nodes.length > 0 ? nodes : [{ host: "", port: "", weight: "1" }],
        // timeout 키가 아예 없으면 현재 값을 유지한다. DEFAULT_TIMEOUT 으로 폴백하면
        // 게이트웨이에 설정된 5/5/30 을 10/10/60 으로 조용히 덮어쓴다.
        timeout: o.timeout
          ? {
              connect: numIn(t.connect),
              send: numIn(t.send),
              read: numIn(t.read),
            }
          : current.timeout,
      };
    }

    case "service": {
      const p = o.plugins || {};
      const log = p["shi-log"] || {};
      return {
        ...current,
        name: o.name || "",
        desc: o.desc || "",
        upstreamId: o.upstream_id || "",
        specUrl: (o.labels && o.labels.spec_url) || "",
        namePrefix: (o.labels && o.labels.name_prefix) || "",
        logKey: log.key || "",
        // 컨슈머의 contacts (`"labels" in o ? … : current`) 처럼 "키가 없으면 건드리지
        // 말라" 로 읽지 **않는다.** 같은 분기의 logKey 가 이미 무조건 덮고 있고, 이제
        // "플러그인 없음"이 표현 가능한 정상 상태라 존재 여부에서 파생하는 쪽이 왕복
        // 무손실이다 — serviceJson 이 낸 본문을 되읽으면 같은 폼이 나온다.
        jwtAuth: "jwt-auth" in p,
      };
    }

    default: {
      const exhaustive: never = current;
      return exhaustive;
    }
  }
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
