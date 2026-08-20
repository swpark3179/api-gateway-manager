/**
 * 앱 전역 상태.
 *
 * 디자인 원본의 `class Component extends DCLogic` 가 단일 상태 트리 + 메서드 구조라
 * zustand 스토어로 거의 1:1 대응된다. 필드 이름과 화면 전환 규칙은 원본을 따랐고,
 * 목업 데이터가 있던 자리는 Rust 커맨드 호출로 바뀌었다.
 *
 * # Route 목록은 내장 SQLite 를 거친다
 *
 * `routes` 는 "전체 목록"이 아니라 **현재 조회 결과**다. 검색어·chip 이 바뀌면 배열을
 * 다시 필터링하는 대신 `routes_query` 로 캐시를 다시 조회한다. 그래서 전체 건수는
 * `routesTotal` · `routeCounts` 를 따로 봐야 한다 (사이드 패널과 chip 라벨이 이걸 쓴다).
 * 캐시를 채우는 경로는 `routes_sync` 하나뿐이다 — 화면 진입과 리프레시 버튼.
 */

import { create } from "zustand";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import * as api from "./api";
import { jsonText, jsonToForm, sortMethods } from "./lib/design";
import {
  consumerToForm,
  emptyConsumerForm,
  emptyRouteForm,
  routeFormFromOas,
  routeToForm,
  type AppError,
  type CompareRow,
  type ConsumerView,
  type DashboardPayload,
  type EnvKey,
  type EnvPayload,
  type FormState,
  type ImportSource,
  type JwtResult,
  type Kind,
  type MatchState,
  type OasDoc,
  type RouteCounts,
  type RouteView,
  type Section,
  type ServiceOption,
  type SettingsView,
  type Tab,
  type TestResult,
  type View,
} from "./types";

const NO_COUNTS: RouteCounts = { all: 0, on: 0, off: 0 };

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
  /** 현재 조회 결과. 전체 목록이 아니다 — 위 모듈 주석 참조. */
  routes: RouteView[];
  /** 검색어·chip 을 적용한 건수 */
  routesTotal: number;
  /** chip 을 빼고 검색어만 적용한 상태별 건수 (chip 라벨·사이드 패널) */
  routeCounts: RouteCounts;
  consumers: ConsumerView[];
  services: ServiceOption[];
  dash: DashboardPayload | null;

  // ── OAS Import ──
  importDoc: OasDoc | null;
  importRows: CompareRow[];
  importService: string;
  importPrefix: string;
  /** 스펙 URL 은 사외 주소일 수 있어 게이트웨이와 별도로 정한다 */
  importNoProxy: boolean;
  importBusy: boolean;
  importError: AppError | null;
  importChip: MatchState | "all";
  importQ: string;
  /** 상세·신규 화면에서 '목록' 으로 돌아갈 때 비교 결과로 복귀할지 */
  importReturn: boolean;

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
  /** 캐시만 다시 조회한다 (게이트웨이 호출 없음) */
  queryRoutes: () => Promise<void>;
  /** 상단 리프레시 버튼 — 게이트웨이 전체 재조회 + 캐시 갱신 */
  hardRefresh: () => Promise<void>;

  openItem: (id: string) => void;
  /** 목록 배열에 없어도 캐시에서 찾아 상세를 연다 */
  openRouteById: (id: string) => Promise<void>;
  /** 비교 결과 → 기존 route 상세. 돌아올 때 비교 결과로 복귀한다 */
  openRouteFromImport: (id: string) => Promise<void>;
  newItem: () => void;
  /** 대시보드의 '신규 Route 등록' — Route 섹션으로 이동해 services 를 채운 뒤 폼을 연다 */
  newRouteFromDash: () => Promise<void>;
  backToList: () => void;
  setTab: (tab: Tab) => void;

  // ── Import ──
  openImport: () => void;
  loadOas: (source: ImportSource) => Promise<void>;
  runCompare: () => Promise<void>;
  setImportService: (id: string) => void;
  setImportPrefix: (prefix: string) => void;
  setImportNoProxy: (v: boolean) => void;
  setImportChip: (chip: MatchState | "all") => void;
  setImportQ: (q: string) => void;
  /** 비교 결과의 미등록 행 → 정보가 채워진 신규 Route 폼 */
  createRouteFromOas: (row: CompareRow) => void;

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
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let prefixTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 조회 응답이 뒤늦게 도착해 최신 결과를 덮어쓰는 것을 막는 토큰.
 * 타이핑 중에는 요청이 겹치므로 마지막으로 보낸 것만 반영한다.
 */
let queryToken = 0;

/** 검색어 입력의 디바운스 — 한 글자마다 IPC 를 왕복하지 않게 한다. */
const SEARCH_DEBOUNCE_MS = 150;

/** 현재 섹션이 다루는 리소스 종류 — 디자인의 kind() */
export const kindOf = (section: Section): Kind =>
  section === "consumers" ? "consumer" : "route";

/** Import 화면과 목록/편집 화면 사이를 오갈 때 초기화되는 상태 */
const IMPORT_RESET = {
  importDoc: null,
  importRows: [] as CompareRow[],
  importError: null,
  importBusy: false,
  importChip: "all" as MatchState | "all",
  importQ: "",
  importReturn: false,
};

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
  routesTotal: 0,
  routeCounts: NO_COUNTS,
  consumers: [],
  services: [],
  dash: null,

  importDoc: null,
  importRows: [],
  importService: "",
  importPrefix: "",
  importNoProxy: true,
  importBusy: false,
  importError: null,
  importChip: "all",
  importQ: "",
  importReturn: false,

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
      routesTotal: 0,
      routeCounts: NO_COUNTS,
      consumers: [],
      services: [],
      dash: null,
      error: null,
      importService: "",
      importPrefix: "",
      ...IMPORT_RESET,
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
      ...IMPORT_RESET,
    });
    void get().refresh();
  },

  setChip(chip) {
    set({ chip, view: "list", selId: null });
    // Route 는 캐시(SQLite)로 필터링한다. Consumer 는 배열 필터를 그대로 쓴다.
    if (get().section === "routes") void get().queryRoutes();
  },

  setQ(q) {
    set({ q });
    if (get().section !== "routes") return;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void get().queryRoutes(), SEARCH_DEBOUNCE_MS);
  },

  async refresh() {
    const { env, section, settings, chip, q } = get();

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
        const [page, services] = await Promise.all([
          api.routesSync(env, chip, q),
          api.servicesList(env).catch(() => [] as ServiceOption[]),
        ]);
        set({
          routes: page.items,
          routesTotal: page.total,
          routeCounts: page.counts,
          services,
          // Import 화면의 service 기본값 — 아직 고르지 않았다면 첫 항목.
          importService: get().importService || services[0]?.id || "",
        });
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

  async queryRoutes() {
    const { env, chip, q, settings } = get();
    if (!settings?.[env]?.hasToken) return;

    const token = ++queryToken;
    try {
      const page = await api.routesQuery(env, chip, q);
      // 더 최신 요청이 이미 나갔으면 이 응답은 버린다.
      if (token !== queryToken) return;
      set({ routes: page.items, routesTotal: page.total, routeCounts: page.counts, error: null });
    } catch (e) {
      if (token !== queryToken) return;
      set({ error: api.toAppError(e) });
    }
  },

  async hardRefresh() {
    const { env, section, settings } = get();
    if (section !== "routes") {
      await get().refresh();
      return;
    }
    if (!settings?.[env]?.hasToken) return;

    set({ loading: true, error: null });
    try {
      const { chip, q } = get();
      const page = await api.routesSync(env, chip, q);
      set({ routes: page.items, routesTotal: page.total, routeCounts: page.counts });
      get().flash(`Route 목록을 갱신했습니다. (${page.counts.all}건)`);
    } catch (e) {
      const err = api.toAppError(e);
      set({ error: err });
      get().flash(err.message);
    } finally {
      set({ loading: false });
    }
  },

  // ── 목록 → 상세 ───────────────────────────────────────────
  openItem(id) {
    const { section, routes, consumers } = get();

    if (kindOf(section) === "consumer") {
      const c: ConsumerView | undefined = consumers.find((x) => x.username === id);
      if (!c) return;
      const form = consumerToForm(c);
      set({
        view: "detail",
        selId: id,
        form,
        tab: "form",
        jsonDraft: jsonText(form),
        jsonErr: "",
        jsonOk: "",
        groupDraft: "",
        rawJson: c.raw ? JSON.stringify(c.raw, null, 2) : null,
        jwt: null,
      });
      void get().signJwt();
      return;
    }

    const r = routes.find((x) => x.id === id);
    if (r) {
      showRoute(set, r);
      return;
    }
    // 목록이 검색어·chip 으로 좁혀져 있으면 배열에 없을 수 있다 — 캐시에서 찾는다.
    void get().openRouteById(id);
  },

  async openRouteById(id) {
    const { env } = get();
    try {
      const r = await api.routeCached(env, id);
      if (!r) {
        get().flash("캐시에 없는 라우트입니다. 리프레시 후 다시 시도하세요.");
        return;
      }
      set({ section: "routes" });
      showRoute(set, r);
    } catch (e) {
      const err = api.toAppError(e);
      set({ error: err });
      get().flash(err.message);
    }
  },

  async openRouteFromImport(id) {
    set({ importReturn: true });
    await get().openRouteById(id);
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
      ...IMPORT_RESET,
    });
    // services 가 채워져야 service_id 셀렉트의 기본값을 정할 수 있다.
    await get().refresh();
    get().newItem();
  },

  backToList() {
    // Import 에서 넘어왔으면 비교 결과로 돌아간다 — 미등록 API 를 하나씩 처리하는 흐름이라
    // 매번 스펙을 다시 읽게 만들면 쓸 수 없다.
    const { importReturn, importDoc } = get();
    set({
      view: importReturn && importDoc ? "import" : "list",
      importReturn: false,
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

  // ── OAS Import ────────────────────────────────────────────
  openImport() {
    const { services, importService, settings, env } = get();
    set({
      section: "routes",
      view: "import",
      selId: null,
      form: null,
      jwt: null,
      error: null,
      ...IMPORT_RESET,
      importService: importService || services[0]?.id || "",
      importPrefix: "",
      // 게이트웨이 설정을 기본값으로 주되, 스펙 주소는 사외일 수 있어 화면에서 바꿀 수 있다.
      importNoProxy: settings?.[env]?.noProxy ?? true,
    });
  },

  async loadOas(source) {
    const { env } = get();
    set({ importBusy: true, importError: null, importDoc: null, importRows: [] });
    try {
      // 스펙을 먼저 읽는다 — 파일이 잘못됐으면 게이트웨이를 부를 이유가 없다.
      const doc = await api.oasLoad(env, source);

      // 판정의 근거가 캐시이므로 여기서 한 번 갱신한다. 게이트웨이에서 이미 지워진 라우트를
      // '등록' 으로 보여 주면 이 화면의 존재 이유가 없어지므로, 실패하면 비교하지 않는다.
      const { chip, q } = get();
      const page = await api.routesSync(env, chip, q);

      set({
        importDoc: doc,
        importPrefix: doc.serverPrefix,
        importChip: "all",
        importQ: "",
        routes: page.items,
        routesTotal: page.total,
        routeCounts: page.counts,
      });
    } catch (e) {
      set({ importError: api.toAppError(e) });
      return;
    } finally {
      set({ importBusy: false });
    }
    await get().runCompare();
  },

  async runCompare() {
    const { env, importDoc, importService, importPrefix } = get();
    if (!importDoc) return;
    if (!importService.trim()) {
      set({ importRows: [] });
      return;
    }

    set({ importBusy: true, importError: null });
    try {
      set({ importRows: await api.oasCompare(env, importService, importPrefix) });
    } catch (e) {
      set({ importError: api.toAppError(e), importRows: [] });
    } finally {
      set({ importBusy: false });
    }
  },

  setImportService(id) {
    set({ importService: id });
    void get().runCompare();
  },

  setImportPrefix(prefix) {
    set({ importPrefix: prefix });
    if (prefixTimer) clearTimeout(prefixTimer);
    prefixTimer = setTimeout(() => void get().runCompare(), SEARCH_DEBOUNCE_MS);
  },

  setImportNoProxy(v) {
    set({ importNoProxy: v });
  },

  setImportChip(chip) {
    set({ importChip: chip });
  },

  setImportQ(q) {
    set({ importQ: q });
  },

  createRouteFromOas(row) {
    const { importService, services } = get();
    const form = routeFormFromOas(row, importService || services[0]?.id || "");
    set({
      section: "routes",
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
      // 저장하거나 취소하면 비교 결과로 돌아간다.
      importReturn: true,
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
      const { importReturn, importDoc } = get();
      const backToImport = importReturn && !!importDoc;
      // 목록을 한 번 스치지 않도록 돌아갈 화면을 바로 지정한다.
      set({
        view: backToImport ? "import" : "list",
        selId: null,
        form: null,
        jwt: null,
        importReturn: false,
      });
      // 캐시를 갱신한 뒤 비교를 다시 돌리면 방금 만든 API 가 '등록' 으로 바뀐다.
      await get().refresh();
      if (backToImport) await get().runCompare();
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
      set({ view: "list", selId: null, form: null, jwt: null, importReturn: false });
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

/**
 * 라우트 하나를 상세 화면에 띄운다.
 *
 * 목록 클릭(`openItem`)과 Import 결과 클릭(`openRouteById`)이 같은 화면 상태를 만들어야
 * 하므로 한 곳에 모았다.
 */
function showRoute(set: (partial: Partial<AppState>) => void, r: RouteView): void {
  const form = routeToForm(r);
  set({
    view: "detail",
    selId: r.id,
    form,
    tab: "form",
    jsonDraft: jsonText(form),
    jsonErr: "",
    jsonOk: "",
    groupDraft: "",
    rawJson: r.raw ? JSON.stringify(r.raw, null, 2) : null,
    jwt: null,
  });
}

// ── 파생 셀렉터 (디자인의 renderVals() 에 해당) ───────────────

/** 현재 환경에 관리 토큰이 없으면 잠금 */
export const selectLocked = (s: AppState): boolean => {
  const cfg = s.settings?.[s.env];
  return !cfg?.hasToken;
};

/** 잠금 화면을 실제로 띄울지 — 설정 화면은 잠금 대상이 아니다 */
export const selectShowLock = (s: AppState): boolean =>
  selectLocked(s) && s.section !== "settings";

/** '그룹 없음' 버킷의 chip 키. 실제 그룹 이름과 겹치지 않도록 예약어를 쓴다. */
export const NO_GROUP = " none";

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

/**
 * Consumer 목록 필터 — chip + 검색어.
 *
 * Route 는 내장 SQLite 가 대신하므로 여기엔 Consumer 용만 남았다.
 *
 * 주의: 이건 zustand 셀렉터가 **아니다**. 매 호출마다 새 배열을 돌려주므로
 * `useStore(selector)` 로 쓰면 useSyncExternalStore 가 스냅샷이 계속 바뀐다고 보고
 * 무한 리렌더에 빠진다. 컴포넌트에서 원본 배열을 구독한 뒤 useMemo 로 감싸 쓴다.
 */
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

/** Import 비교 결과 필터 — 상태 chip + 검색어. 건수가 적어 클라이언트에서 처리한다. */
export function filterCompareRows(
  rows: CompareRow[],
  chip: MatchState | "all",
  q: string,
): CompareRow[] {
  let out = rows;
  if (chip !== "all") out = out.filter((r) => r.state === chip);
  const needle = q.trim().toLowerCase();
  if (needle) {
    out = out.filter((r) =>
      `${r.method} ${r.fullPath} ${r.operationId} ${r.summary} ${r.routeName}`
        .toLowerCase()
        .includes(needle),
    );
  }
  return out;
}

export type { AppState };
