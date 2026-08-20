/**
 * 디자인 원본(`API Gateway 관리자.dc.html`)의 순수 헬퍼를 그대로 옮긴 것.
 * JSON 탭이 보여주는 본문 모양, 메서드 목록, 레일 아이콘 path 등이 여기에 모여 있다.
 *
 * 주의: 여기서 만드는 JSON 은 **화면 표시/편집용 축약형**이다. 실제 저장은 Rust 가
 * 원본 리소스를 GET 해 앱이 관리하는 키만 덮어쓰는 머지 방식으로 처리하므로,
 * 이 JSON 에 없는 플러그인(limit-count 등)도 보존된다.
 */

import type { ConsumerFormState, FormState, RouteFormState, Section } from "../types";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** 아이콘 레일의 SVG path — 디자인의 railIcons 그대로 */
export const RAIL_ICONS: Record<Section, string> = {
  dash: "M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 13h6v6h-6z",
  routes: "M6 4v6a4 4 0 0 0 4 4h8M18 10l3 4-3 4",
  consumers: "M4 20a5 5 0 0 1 10 0M9 4a3.2 3.2 0 1 1 0 6.4A3.2 3.2 0 0 1 9 4M16 20a5 5 0 0 0-2-4",
  settings:
    "M12 15.2A3.2 3.2 0 1 0 12 8.8a3.2 3.2 0 0 0 0 6.4M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.4-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z",
};

export const RAIL: Array<{ key: Section; label: string }> = [
  { key: "dash", label: "대시보드" },
  { key: "routes", label: "Route" },
  { key: "consumers", label: "Consumer" },
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

// ── JSON 탭 본문 ─────────────────────────────────────────────

export function routeJson(f: RouteFormState): Record<string, unknown> {
  const plugins: Record<string, unknown> = {};
  if (f.rewrite) plugins["proxy-rewrite"] = { uri: f.rewrite };
  plugins["shi-auth"] = { allowed_groups: f.groups };
  return {
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
}

export function consumerJson(f: ConsumerFormState): Record<string, unknown> {
  return {
    username: f.username,
    desc: f.desc,
    plugins: {
      "jwt-auth": { key: f.key, secret: f.secret, "auth-groups": f.groups },
    },
  };
}

export function formJson(f: FormState): Record<string, unknown> {
  return f.kind === "consumer" ? consumerJson(f) : routeJson(f);
}

export function jsonText(f: FormState): string {
  return JSON.stringify(formJson(f), null, 2);
}

/** JSON 탭의 '폼에 적용' — 디자인의 applyJson() */
export function jsonToForm(raw: string, current: FormState): FormState {
  const o = JSON.parse(raw) as Record<string, any>;

  if (current.kind === "consumer") {
    const j = (o.plugins && o.plugins["jwt-auth"]) || {};
    return {
      ...current,
      username: o.username || "",
      desc: o.desc || "",
      key: j.key || "",
      secret: j.secret || "",
      groups: Array.isArray(j["auth-groups"]) ? j["auth-groups"] : [],
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
    groups: Array.isArray(p["shi-auth"]?.allowed_groups) ? p["shi-auth"].allowed_groups : [],
    status: typeof o.status === "number" ? o.status : current.status,
  };
}

/** 디자인의 methods 칩은 선택 순서와 무관하게 항상 표준 순서로 정렬된다. */
export function sortMethods(list: string[]): string[] {
  return METHODS.filter((m) => list.includes(m));
}

/** Consumer 목록의 secret 열 표기 — 디자인의 `secret.slice(0,8) + '••••••••'` */
export function maskSecret(secret: string): string {
  if (!secret) return "—";
  return secret.slice(0, 8) + "••••••••";
}
