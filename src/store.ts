/**
 * 앱 전역 상태.
 *
 * 디자인 원본의 `class Component extends DCLogic` 가 단일 상태 트리 + 메서드 구조라
 * zustand 스토어로 거의 1:1 대응된다. 필드 이름과 화면 전환 규칙은 원본을 따랐고,
 * 목업 데이터가 있던 자리는 Rust 커맨드 호출로 바뀌었다.
 */

import { create } from "zustand";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import * as api from "./api";
import { jsonText, jsonToForm, sortMethods } from "./lib/design";
import {
  consumerToForm,
  emptyConsumerForm,
  emptyRouteForm,
  routeToForm,
  type AppError,
  type ConsumerView,
  type DashboardPayload,
  type EnvKey,
  type EnvPayload,
  type FormState,
  type JwtResult,
  type Kind,
  type RouteView,
  type Section,
  type ServiceOption,
  type SettingsView,
  type Tab,
  type TestResult,
  type View,
} from "./types";

interface AppState {
  // ── 내비게이션 ──
  env: EnvKey;
  section: Section;
  view: View;
  selId: string | null;
  tab: Tab;
  chip: string;
  q: string;

  // ── 편집 ──
  form: FormState | null;
  groupDraft: string;
  jsonDraft: string;
  jsonErr: string;
  jsonOk: string;
  /** 선택한 항목의 게이트웨이 원본 JSON (JSON 탭의 '게이트웨이 원본' 보기용) */
  rawJson: string | null;
  jwt: JwtResult | null;

  // ── 데이터 ──
  settings: SettingsView | null;
  routes: RouteView[];
  consumers: ConsumerView[];
  services: ServiceOption[];
  dash: DashboardPayload | null;

  // ── UI ──
  toast: string | null;
  loading: boolean;
  saving: boolean;
  error: AppError | null;
  /** Win32 쪽에서 알려주는 최대화 버튼 hover 상태 (Snap Layouts) */
  maxHover: boolean;

  // ── 액션 ──
  init: () => Promise<void>;
  setEnv: (env: EnvKey) => void;
  go: (section: Section) => void;
  setChip: (chip: string) => void;
  setQ: (q: string) => void;
  refresh: () => Promise<void>;

  openItem: (id: string) => void;
  newItem: () => void;
  /** 대시보드의 '신규 Route 등록' — Route 섹션으로 이동해 services 를 채운 뒤 폼을 연다 */
  newRouteFromDash: () => Promise<void>;
  backToList: () => void;
  setTab: (tab: Tab) => void;

  patchForm: (patch: Partial<Record<string, unknown>>) => void;
  toggleMethod: (m: string) => void;
  setGroupDraft: (v: string) => void;
  addGroup: () => void;
  removeGroup: (i: number) => void;
  makeSecret: () => Promise<void>;

  setJsonDraft: (v: string) => void;
  applyJson: () => void;
  resetJson: () => void;

  save: () => Promise<void>;
  remove: () => Promise<void>;

  signJwt: () => Promise<void>;
  copyJwt: () => Promise<void>;

  saveSettings: (env: EnvKey, payload: EnvPayload) => Promise<boolean>;
  testSettings: (env: EnvKey, payload: EnvPayload) => Promise<TestResult>;

  flash: (msg: string) => void;
  setMaxHover: (v: boolean) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** 현재 섹션이 다루는 리소스 종류 — 디자인의 kind() */
export const kindOf = (section: Section): Kind =>
  section === "consumers" ? "consumer" : "route";

export const useStore = create<AppState>((set, get) => ({
  env: "dev",
  section: "dash",
  view: "list",
  selId: null,
  tab: "form",
  chip: "all",
  q: "",

  form: null,
  groupDraft: "",
  jsonDraft: "",
  jsonErr: "",
  jsonOk: "",
  rawJson: null,
  jwt: null,

  settings: null,
  routes: [],
  consumers: [],
  services: [],
  dash: null,

  toast: null,
  loading: false,
  saving: false,
  error: null,
  maxHover: false,

  // ── 초기화 ────────────────────────────────────────────────
  async init() {
    try {
      const settings = await api.settingsGet();
      set({ settings });
    } catch (e) {
      set({ error: api.toAppError(e) });
    }
    await get().refresh();
  },

  setEnv(env) {
    if (get().env === env) return;
    // 환경이 바뀌면 다른 게이트웨이이므로 캐시된 목록을 모두 버린다.
    set({
      env,
      view: "list",
      selId: null,
      chip: "all",
      q: "",
      form: null,
      jwt: null,
      routes: [],
      consumers: [],
      services: [],
      dash: null,
      error: null,
    });
    void get().refresh();
  },

  go(section) {
    set({
      section,
      view: "list",
      selId: null,
      tab: "form",
      chip: "all",
      q: "",
      jsonErr: "",
      jsonOk: "",
      form: null,
      jwt: null,
      error: null,
    });
    void get().refresh();
  },

  setChip(chip) {
    set({ chip, view: "list", selId: null });
  },

  setQ(q) {
    set({ q });
  },

  async refresh() {
    const { env, section, settings } = get();

    if (section === "settings") {
      try {
        set({ settings: await api.settingsGet() });
      } catch (e) {
        set({ error: api.toAppError(e) });
      }
      return;
    }

    // 토큰이 없는 환경은 잠금 화면이 뜨므로 호출하지 않는다.
    const cfg = settings?.[env];
    if (!cfg?.hasToken) return;

    set({ loading: true, error: null });
    try {
      if (section === "routes") {
        // service_id 셀렉트를 채우려면 services 도 필요하다.
        const [routes, services] = await Promise.all([
          api.routesList(env),
          api.servicesList(env).catch(() => [] as ServiceOption[]),
        ]);
        set({ routes, services });
      } else if (section === "consumers") {
        set({ consumers: await api.consumersList(env) });
      } else {
        set({ dash: await api.dashboard(env) });
      }
    } catch (e) {
      set({ error: api.toAppError(e) });
    } finally {
      set({ loading: false });
    }
  },

  // ── 목록 → 상세 ───────────────────────────────────────────
  openItem(id) {
    const { section, routes, consumers } = get();
    let form: FormState | null = null;
    let raw: unknown = null;

    if (kindOf(section) === "consumer") {
      const c: ConsumerView | undefined = consumers.find((x) => x.username === id);
      if (c) {
        form = consumerToForm(c);
        raw = c.raw;
      }
    } else {
      const r: RouteView | undefined = routes.find((x) => x.id === id);
      if (r) {
        form = routeToForm(r);
        raw = r.raw;
      }
    }
    if (!form) return;

    set({
      view: "detail",
      selId: id,
      form,
      tab: "form",
      jsonDraft: jsonText(form),
      jsonErr: "",
      jsonOk: "",
      groupDraft: "",
      rawJson: raw ? JSON.stringify(raw, null, 2) : null,
      jwt: null,
    });

    if (form.kind === "consumer") void get().signJwt();
  },

  newItem() {
    const { section, services } = get();
    const form: FormState =
      kindOf(section) === "consumer"
        ? emptyConsumerForm()
        : emptyRouteForm(services[0]?.id ?? "");

    set({
      view: "create",
      selId: null,
      form,
      tab: "form",
      jsonDraft: jsonText(form),
      jsonErr: "",
      jsonOk: "",
      groupDraft: "",
      rawJson: null,
      jwt: null,
    });
  },

  async newRouteFromDash() {
    set({
      section: "routes",
      view: "list",
      selId: null,
      tab: "form",
      chip: "all",
      q: "",
      form: null,
      jwt: null,
      error: null,
    });
    // services 가 채워져야 service_id 셀렉트의 기본값을 정할 수 있다.
    await get().refresh();
    get().newItem();
  },

  backToList() {
    set({
      view: "list",
      selId: null,
      form: null,
      jwt: null,
      rawJson: null,
      jsonErr: "",
      jsonOk: "",
    });
  },

  setTab(tab) {
    const { form, jsonDraft } = get();
    set({
      tab,
      jsonDraft: tab === "json" && form ? jsonText(form) : jsonDraft,
      jsonErr: "",
      jsonOk: "",
    });
  },

  // ── 폼 편집 ───────────────────────────────────────────────
  patchForm(patch) {
    const { form, tab } = get();
    if (!form) return;
    const next = { ...form, ...patch } as FormState;
    // JSON 탭에서 직접 편집 중일 때는 draft 를 덮어쓰지 않는다 (디자인의 set() 동작)
    set({ form: next, jsonDraft: tab === "json" ? get().jsonDraft : jsonText(next) });
  },

  toggleMethod(m) {
    const { form } = get();
    if (!form || form.kind !== "route") return;
    const has = form.methods.includes(m);
    const next = has ? form.methods.filter((x) => x !== m) : [...form.methods, m];
    get().patchForm({ methods: sortMethods(next) });
  },

  setGroupDraft(v) {
    set({ groupDraft: v });
  },

  addGroup() {
    const { form, groupDraft } = get();
    if (!form) return;
    const v = groupDraft.trim();
    if (!v) return;
    if (form.groups.includes(v)) {
      set({ groupDraft: "" });
      return;
    }
    get().patchForm({ groups: [...form.groups, v] });
    set({ groupDraft: "" });
  },

  removeGroup(i) {
    const { form } = get();
    if (!form) return;
    get().patchForm({ groups: form.groups.filter((_, j) => j !== i) });
  },

  async makeSecret() {
    try {
      get().patchForm({ secret: await api.genSecret(), hasSecret: true });
    } catch (e) {
      set({ error: api.toAppError(e) });
    }
  },

  // ── JSON 탭 ───────────────────────────────────────────────
  setJsonDraft(v) {
    set({ jsonDraft: v, jsonErr: "", jsonOk: "" });
  },

  applyJson() {
    const { form, jsonDraft } = get();
    if (!form) return;
    try {
      const next = jsonToForm(jsonDraft, form);
      set({
        form: next,
        jsonErr: "",
        jsonOk: "JSON을 폼에 반영했습니다. 저장 버튼으로 확정하세요.",
      });
      if (next.kind === "consumer") void get().signJwt();
    } catch (e) {
      set({ jsonErr: "JSON 파싱 오류: " + (e as Error).message, jsonOk: "" });
    }
  },

  resetJson() {
    const { form } = get();
    if (!form) return;
    set({ jsonDraft: jsonText(form), jsonErr: "", jsonOk: "" });
  },

  // ── 저장 / 삭제 ───────────────────────────────────────────
  async save() {
    const { form, env } = get();
    if (!form) return;

    // 디자인과 동일한 필수값 검사 (서버 왕복 전에 즉시 알려준다)
    const missing =
      form.kind === "consumer"
        ? !form.username.trim() || !form.key.trim() || !form.secret.trim()
        : !form.name.trim() || !form.uri.trim() || !form.serviceId.trim();
    if (missing) {
      get().flash("필수 항목을 입력하세요.");
      return;
    }

    set({ saving: true, error: null });
    try {
      if (form.kind === "consumer") {
        await api.consumerSave(env, form);
        get().flash("Consumer가 저장되었습니다.");
      } else {
        const isNew = !form.id;
        await api.routeSave(env, form);
        get().flash(
          isNew ? "Route가 저장되었습니다. (status: 1)" : "Route가 저장되었습니다.",
        );
      }
      set({ view: "list", selId: null, form: null, jwt: null });
      await get().refresh();
    } catch (e) {
      const err = api.toAppError(e);
      set({ error: err });
      get().flash(err.message);
    } finally {
      set({ saving: false });
    }
  },

  async remove() {
    const { form, env } = get();
    if (!form) return;

    set({ saving: true, error: null });
    try {
      if (form.kind === "consumer") {
        await api.consumerDelete(env, form.username);
      } else {
        await api.routeDelete(env, form.id ?? "", form.name);
      }
      get().flash("삭제되었습니다.");
      set({ view: "list", selId: null, form: null, jwt: null });
      await get().refresh();
    } catch (e) {
      const err = api.toAppError(e);
      set({ error: err });
      get().flash(err.message);
    } finally {
      set({ saving: false });
    }
  },

  // ── JWT ───────────────────────────────────────────────────
  async signJwt() {
    const { form } = get();
    if (!form || form.kind !== "consumer") return;
    if (!form.key.trim() || !form.secret.trim()) {
      set({ jwt: null });
      return;
    }
    try {
      set({ jwt: await api.jwtSign(form.key, form.secret) });
    } catch (e) {
      set({ jwt: null, error: api.toAppError(e) });
    }
  },

  async copyJwt() {
    const { jwt } = get();
    if (!jwt?.token) return;
    try {
      await writeText(jwt.token);
      get().flash("JWT 토큰을 클립보드에 복사했습니다.");
    } catch {
      get().flash("클립보드 복사에 실패했습니다.");
    }
  },

  // ── 설정 ──────────────────────────────────────────────────
  async saveSettings(env, payload) {
    try {
      const settings = await api.settingsSave(env, payload);
      set({ settings, error: null });
      get().flash(`${env === "dev" ? "개발" : "운영"} 서버 설정이 저장되었습니다.`);
      return true;
    } catch (e) {
      const err = api.toAppError(e);
      set({ error: err });
      get().flash(err.message);
      return false;
    }
  },

  async testSettings(env, payload) {
    try {
      return await api.settingsTest(env, payload);
    } catch (e) {
      return { ok: false, text: api.toAppError(e).message };
    }
  },

  // ── 기타 ──────────────────────────────────────────────────
  flash(msg) {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: msg });
    toastTimer = setTimeout(() => set({ toast: null }), 2200);
  },

  setMaxHover(v) {
    if (get().maxHover !== v) set({ maxHover: v });
  },
}));

// ── 파생 셀렉터 (디자인의 renderVals() 에 해당) ───────────────

/** 현재 환경에 관리 토큰이 없으면 잠금 */
export const selectLocked = (s: AppState): boolean => {
  const cfg = s.settings?.[s.env];
  return !cfg?.hasToken;
};

/** 잠금 화면을 실제로 띄울지 — 설정 화면은 잠금 대상이 아니다 */
export const selectShowLock = (s: AppState): boolean =>
  selectLocked(s) && s.section !== "settings";

/**
 * 목록 필터 — chip + 검색어.
 *
 * 주의: 이건 zustand 셀렉터가 **아니다**. 매 호출마다 새 배열을 돌려주므로
 * `useStore(selector)` 로 쓰면 useSyncExternalStore 가 스냅샷이 계속 바뀐다고 보고
 * 무한 리렌더에 빠진다. 컴포넌트에서 원본 배열을 구독한 뒤 useMemo 로 감싸 쓴다.
 */
export function filterRoutes(items: RouteView[], chip: string, q: string): RouteView[] {
  let out = items;
  if (chip === "on") out = out.filter((r) => r.status === 1);
  if (chip === "off") out = out.filter((r) => r.status !== 1);
  const needle = q.trim().toLowerCase();
  if (needle) out = out.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
  return out;
}

/** '그룹 없음' 버킷의 chip 키. 실제 그룹 이름과 겹치지 않도록 예약어를 쓴다. */
export const NO_GROUP = " none";

export interface GroupBucket {
  /** chip 값 */
  key: string;
  label: string;
  count: number;
}

/**
 * Consumer 목록에서 실제로 쓰이고 있는 auth-groups 값을 모아 버킷으로 만든다.
 *
 * 디자인의 고정 구분(제휴사/내부 시스템)은 'partner'·'internal' 이라는 특정 문자열이
 * 있다고 가정하는데, 실제 게이트웨이의 그룹 이름은 조직마다 다르다.
 * 그래서 데이터에 존재하는 그룹만 보여 준다.
 */
export function consumerGroupBuckets(items: ConsumerView[]): GroupBucket[] {
  const counts = new Map<string, number>();
  let ungrouped = 0;

  for (const c of items) {
    if (c.groups.length === 0) {
      ungrouped += 1;
      continue;
    }
    for (const g of c.groups) counts.set(g, (counts.get(g) ?? 0) + 1);
  }

  const out: GroupBucket[] = [...counts.entries()]
    .map(([key, count]) => ({ key, label: key, count }))
    // 많이 쓰이는 그룹을 위로, 같으면 이름순
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  if (ungrouped > 0) {
    out.push({ key: NO_GROUP, label: "(그룹 없음)", count: ungrouped });
  }
  return out;
}

export function filterConsumers(items: ConsumerView[], chip: string, q: string): ConsumerView[] {
  let out = items;
  if (chip === NO_GROUP) {
    out = out.filter((c) => c.groups.length === 0);
  } else if (chip !== "all") {
    out = out.filter((c) => c.groups.includes(chip));
  }
  const needle = q.trim().toLowerCase();
  if (needle) out = out.filter((c) => JSON.stringify(c).toLowerCase().includes(needle));
  return out;
}

export type { AppState };
