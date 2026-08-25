/**
 * 앱 전역 상태.
 *
 * 디자인 원본의 `class Component extends DCLogic` 가 단일 상태 트리 + 메서드 구조라
 * zustand 스토어로 거의 1:1 대응된다. 필드 이름과 화면 전환 규칙은 원본을 따랐고,
 * 목업 데이터가 있던 자리는 Rust 커맨드 호출로 바뀌었다.
 *
 * # 목록은 전부 내장 SQLite 캐시를 거친다
 *
 * 게이트웨이 전체 조회는 **부트스트랩**(기동 · 환경 전환 · 상단 새로고침 버튼)과 저장·삭제
 * 직후의 재동기화에서만 일어난다. 섹션을 오가는 것만으로는 게이트웨이를 부르지 않는다
 * (대시보드는 예외 — version·latency 가 라이브 값이라야 의미가 있다).
 *
 * `routes` 는 "전체 목록"이 아니라 **현재 조회 결과**다. 그래서 건수는 세 종류를 따로 본다:
 *
 *   - `routesTotal`  — chip · 검색어 · 컨슈머를 모두 적용 → 하단 '총 N건'
 *   - `routeCounts`  — chip 만 뺀 건수                    → 상단 chip 라벨
 *   - `access`       — 아무것도 적용하지 않은 고정값       → 좌측 패널
 *
 * 좌측 패널이 `routeCounts` 를 쓰면 순환한다 — 컨슈머를 고른 순간 '전체' 행이 그 컨슈머의
 * 건수를 표시하게 된다. 그래서 패널은 `access` 를 본다.
 */

import { create } from "zustand";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import * as api from "./api";
import { jsonText, jsonToForm, sortMethods } from "./lib/design";
import {
  NO_SELECTION,
  allChanges,
  applySelection,
  diffFields,
  hasDiff,
  rowVerdict,
  type DiffSelection,
  type RowVerdict,
} from "./lib/importDiff";
import {
  ALL_ROUTES,
  consumerToForm,
  emptyConsumerForm,
  emptyRouteForm,
  emptyServiceForm,
  emptyUpstreamForm,
  routeFormFromOas,
  routeToForm,
  scopeKey,
  serviceToForm,
  upstreamToForm,
  type AccessCounts,
  type AppError,
  type CompareRow,
  type Contact,
  type ConsumerView,
  type DashboardPayload,
  type EnvKey,
  type EnvPayload,
  type FormState,
  type ImportSource,
  type JwtResult,
  type Kind,
  type OasDoc,
  type RouteCounts,
  type RouteFormState,
  type RouteScope,
  type RouteView,
  type Section,
  type ServiceView,
  type SettingsView,
  type Tab,
  type TestResult,
  type UpstreamFormState,
  type UpstreamNodeInput,
  type UpstreamView,
  type View,
} from "./types";

const NO_COUNTS: RouteCounts = { all: 0, on: 0, off: 0 };

export type BootVariant = "overlay" | "bar";

interface AppState {
  // ── 내비게이션 ──
  env: EnvKey;
  section: Section;
  view: View;
  selId: string | null;
  tab: Tab;
  /** 상단 status chip 축 (all / on / off). 좌측 패널의 조회 범위 축과 독립이다. */
  chip: string;
  /**
   * 좌측 패널이 고르는 조회 범위 (전체 · 컨슈머 한 명 · 그룹 제한 없음).
   *
   * `chip` 과 한 슬롯을 공유할 수 없다 — 두 조건은 AND 로 **동시에** 켜져야 한다.
   */
  routeScope: RouteScope;
  q: string;
  /**
   * Route 목록의 name 접두사 축.
   *
   * `q` 와 **다른 축**이라 필드를 따로 둔다. `q` 는 `search` 블롭 어디에나 걸리는 '포함'
   * 이고, 이쪽은 `name` 이 그 문자열로 **시작**하는가만 본다 (`db::NAME_PREFIX_CLAUSE`).
   * 사내 route 명 규약(`EP_…`)으로 한 덩어리를 골라내는 용도다.
   */
  namePrefix: string;

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
  /** chip · 검색어 · 컨슈머를 모두 적용한 건수 */
  routesTotal: number;
  /** chip 만 뺀 상태별 건수 (상단 chip 라벨) */
  routeCounts: RouteCounts;
  /** 좌측 패널용 고정 집계. 필터를 아무것도 반영하지 않는다. */
  access: AccessCounts | null;
  consumers: ConsumerView[];
  /** 캐시(SQLite)에서 읽은 Service 전체 목록. service_id 셀렉트와 Import 의 spec_url 원천 */
  services: ServiceView[];
  /** 캐시에서 읽은 Upstream 전체 목록. Service 폼의 upstream 콤보 원천 */
  upstreams: UpstreamView[];
  dash: DashboardPayload | null;

  // ── OAS Import ──
  importDoc: OasDoc | null;
  importRows: CompareRow[];
  importService: string;
  importPrefix: string;
  /** service 의 spec_url 은 사외 주소일 수 있어 게이트웨이와 별도로 정한다 */
  importNoProxy: boolean;
  importBusy: boolean;
  importError: AppError | null;
  importChip: RowVerdict | "all";
  importQ: string;
  /**
   * 첨부한 스펙 파일 이름. **빈 문자열이면 "파일 미첨부" 모드**다.
   *
   * 로컬 useState 가 아니라 스토어에 있는 이유: `×` 초기화와 service 변경 로직이 같은 값을
   * 봐야 "첨부됐으면 그 파일로, 아니면 service 의 spec_url 로" 라는 분기가 성립한다.
   */
  importFileName: string;
  /** 상세·신규 화면에서 '목록' 으로 돌아갈 때 비교 결과로 복귀할지 */
  importReturn: boolean;

  // ── Import diff (등록된 API 를 눌렀을 때의 중간 단계) ──
  //
  // `form` 은 **선택을 반영한 결과**를 들고 있다. 그래야 저장이 `store.save()` 를 그대로
  // 탈 수 있다 (Import 전용 저장 경로를 만들지 않는다는 규칙 — README 참조).
  /** 클릭한 스펙 API 한 건 (path, method) */
  diffRow: CompareRow | null;
  /** 게이트웨이에 저장돼 있는 쪽. 비교 기준이라 선택을 바꿔도 변하지 않는다 */
  diffBase: RouteFormState | null;
  /** '적용 없이 상세로 이동' 이 쓸 원본 */
  diffRoute: RouteView | null;
  diffSel: DiffSelection;

  // ── UI ──
  toast: string | null;
  loading: boolean;
  saving: boolean;
  error: AppError | null;
  /** Win32 쪽에서 알려주는 최대화 버튼 hover 상태 (Snap Layouts) */
  maxHover: boolean;

  // ── 부트스트랩 ──
  booting: boolean;
  /** `overlay` = 기동·환경 전환(가릴 것이 없다), `bar` = 새로고침 버튼(목록을 가리면 안 된다) */
  bootVariant: BootVariant;
  bootStep: number;
  bootTotal: number;
  bootLabel: string;
  /** 환경별 마지막 동기화 시각. route·consumer 단계가 **모두** 성공했을 때만 찍는다. */
  syncedAt: Record<EnvKey, number | null>;

  // ── 액션 ──
  /** 로컬 설정만 읽는다 (네트워크 없음). 잠금 여부가 정해져야 첫 화면이 정확하다. */
  loadSettings: () => Promise<void>;
  /** 게이트웨이 전체 조회 → 캐시 갱신. 기동 · 환경 전환 · 새로고침 버튼이 부른다. */
  bootstrap: (variant?: BootVariant) => Promise<void>;
  setEnv: (env: EnvKey) => void;
  go: (section: Section) => void;
  setChip: (chip: string) => void;
  /** 좌측 패널 클릭. 같은 범위를 다시 고르면 전체로 되돌린다. */
  setRouteScope: (scope: RouteScope) => void;
  setQ: (q: string) => void;
  /** Route 목록의 name 접두사 필터. `setQ` 와 같은 디바운스로 캐시를 다시 조회한다. */
  setNamePrefix: (v: string) => void;
  /** 대시보드·설정 화면만 게이트웨이를 다시 본다 (목록은 캐시가 진실의 사본이다) */
  refresh: () => Promise<void>;
  /** 캐시만 다시 조회한다 (게이트웨이 호출 없음) */
  queryRoutes: () => Promise<void>;
  /** Consumer 목록을 캐시에서 읽는다 (게이트웨이 호출 없음) */
  loadConsumers: () => Promise<void>;
  /** Upstream 목록을 캐시에서 읽는다 (게이트웨이 호출 없음) */
  loadUpstreams: () => Promise<void>;
  /** Service 목록을 캐시에서 읽는다 (게이트웨이 호출 없음) */
  loadServices: () => Promise<void>;
  /** Upstream 화면의 동기화 버튼 — 게이트웨이 전체 조회 → 캐시 갱신 */
  syncUpstreams: () => Promise<void>;
  /** Service 화면의 동기화 버튼 — 게이트웨이 전체 조회 → 캐시 갱신 */
  syncServices: () => Promise<void>;
  /** 좌측 패널 집계만 다시 센다 (게이트웨이 호출 없음) */
  refreshAccess: () => Promise<void>;
  /** 상단 리프레시 버튼 — `bootstrap("bar")` */
  hardRefresh: () => Promise<void>;

  openItem: (id: string) => void;
  /** 목록 배열에 없어도 캐시에서 찾아 상세를 연다 */
  openRouteById: (id: string) => Promise<void>;
  /**
   * 비교 결과 → 기존 route.
   *
   * 스펙 적용본과 저장분이 **같으면** 지금까지처럼 곧바로 상세로 가고, **다르면** diff 화면을
   * 한 단계 끼운다. 어느 쪽이든 돌아올 때 비교 결과로 복귀한다.
   */
  openRouteFromImport: (row: CompareRow) => Promise<void>;
  newItem: () => void;
  /** 대시보드의 '신규 Route 등록' — Route 섹션으로 이동해 services 를 채운 뒤 폼을 연다 */
  newRouteFromDash: () => Promise<void>;
  backToList: () => void;
  setTab: (tab: Tab) => void;

  // ── Import ──
  openImport: () => void;
  /**
   * 스펙을 읽어 파싱·적재하고 비교까지 돌린다.
   *
   * `fileName` 은 첨부 칩에 표시할 이름이다. **넘기면 "파일 첨부 모드"가 되고**, 넘기지
   * 않으면(= service 의 spec_url 로 읽는 경로) 미첨부 상태가 유지된다.
   */
  loadOas: (source: ImportSource, fileName?: string) => Promise<void>;
  runCompare: () => Promise<void>;
  setImportService: (id: string) => void;
  setImportPrefix: (prefix: string) => void;
  setImportNoProxy: (v: boolean) => void;
  setImportChip: (chip: RowVerdict | "all") => void;
  setImportQ: (q: string) => void;
  /** 첨부 파일 초기화(`×`). 선택된 service 가 있으면 그 spec_url 로 되돌아간다 */
  clearImportFile: () => Promise<void>;
  /** 선택한 service 의 `labels.spec_url` 을 읽어 비교한다 (파일 미첨부 모드) */
  loadSpecForService: (id: string) => Promise<void>;
  /** 비교 결과의 미등록 행 → 정보가 채워진 신규 Route 폼 */
  createRouteFromOas: (row: CompareRow) => void;

  // ── Import diff ──
  /** 적용할 항목 선택. 바뀔 때마다 `form` 을 다시 만든다 (= 저장될 본문) */
  setDiffSel: (patch: Partial<DiffSelection>) => void;
  /** '차이 전부 선택' · '전부 해제' */
  setDiffAll: (on: boolean) => void;
  /** 아무것도 적용하지 않고 원래 목적지(상세)로 간다 */
  skipDiffToDetail: () => void;

  patchForm: (patch: Partial<Record<string, unknown>>) => void;
  toggleMethod: (m: string) => void;
  setGroupDraft: (v: string) => void;
  /** 값을 넘기지 않으면 `groupDraft` 를 쓴다 (콤보박스에서 마우스로 고른 경우는 값을 넘긴다) */
  addGroup: (value?: string) => void;
  removeGroup: (i: number) => void;
  makeSecret: () => Promise<void>;

  addContact: () => void;
  patchContact: (i: number, patch: Partial<Contact>) => void;
  removeContact: (i: number) => void;

  addNode: () => void;
  patchNode: (i: number, patch: Partial<UpstreamNodeInput>) => void;
  removeNode: (i: number) => void;
  patchTimeout: (patch: Partial<UpstreamFormState["timeout"]>) => void;

  setJsonDraft: (v: string) => void;
  applyJson: () => void;
  resetJson: () => void;

  save: () => Promise<void>;
  remove: () => Promise<void>;
  /** 저장·삭제 직후 건드린 리소스만 게이트웨이에서 다시 받아 캐시를 맞춘다 */
  syncTouched: (kind: Kind) => Promise<void>;

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
/** 목록의 name 접두사 입력. 검색어와 **다른 축**이라 타이머도 따로 둔다 —
 *  한쪽을 고치는 중에 다른 쪽의 대기 중인 조회가 취소되면 안 된다. */
let namePrefixTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 조회 응답이 뒤늦게 도착해 최신 결과를 덮어쓰는 것을 막는 토큰.
 * 타이핑 중에는 요청이 겹치므로 마지막으로 보낸 것만 반영한다.
 */
let queryToken = 0;

/**
 * 같은 이유의 부트스트랩용 토큰. 개발/운영 세그먼트를 빠르게 두 번 누르면 4단계가 겹쳐
 * dev 의 결과가 prod 상태에 얹힌다.
 */
let bootToken = 0;

/** 검색어 입력의 디바운스 — 한 글자마다 IPC 를 왕복하지 않게 한다. */
const SEARCH_DEBOUNCE_MS = 150;

/**
 * 현재 섹션이 다루는 리소스 종류.
 *
 * 예전에는 `consumers` 가 아니면 전부 `"route"` 였다. 섹션이 넷으로 늘어난 지금 그 폴백은
 * Upstream 화면에서 Route 를 저장하려 드는 조용한 버그가 되므로, 매핑에 없는 섹션은
 * `null` 을 준다. 저장·삭제는 이것 대신 `form.kind`(판별 유니온)로 분기한다.
 */
const SECTION_KIND: Partial<Record<Section, Kind>> = {
  routes: "route",
  consumers: "consumer",
  services: "service",
  upstreams: "upstream",
};

export const kindOf = (section: Section): Kind | null => SECTION_KIND[section] ?? null;

/**
 * diff 단계에서 빠져나올 때 초기화되는 상태.
 *
 * `IMPORT_RESET` 과 따로 두는 이유: 저장·취소로 **비교 결과로 돌아갈 때는** diff 만 지우고
 * 스펙(`importDoc`)은 남겨야 한다. 스펙까지 지우면 API 를 하나 처리할 때마다 파일을 다시
 * 첨부해야 한다.
 */
const DIFF_RESET = {
  diffRow: null,
  diffBase: null,
  diffRoute: null,
  diffSel: NO_SELECTION,
};

/** Import 화면과 목록/편집 화면 사이를 오갈 때 초기화되는 상태 */
const IMPORT_RESET = {
  importDoc: null,
  importRows: [] as CompareRow[],
  importError: null,
  importBusy: false,
  importChip: "all" as RowVerdict | "all",
  importQ: "",
  importFileName: "",
  importReturn: false,
  ...DIFF_RESET,
};

/**
 * 목록 화면으로 되돌릴 때의 공통 초기화.
 *
 * `go` 와 `newRouteFromDash` 에 같은 블록이 복붙돼 있었다. 축이 하나 늘 때마다 두 곳 중
 * 한 곳만 고치는 사고가 나므로 묶어 둔다. (`setEnv` 는 이것의 상위집합이다.)
 */
const LIST_RESET = {
  view: "list" as View,
  selId: null,
  tab: "form" as Tab,
  chip: "all",
  routeScope: ALL_ROUTES,
  q: "",
  namePrefix: "",
  jsonErr: "",
  jsonOk: "",
  form: null,
  jwt: null,
  error: null,
  ...IMPORT_RESET,
};

/** 정수 문자열인가 — Upstream 폼의 숫자 칸은 문자열로 들고 있다 (types.ts 주석 참조). */
function intText(v: string): boolean {
  const t = v.trim();
  return t !== "" && Number.isInteger(Number(t));
}

/**
 * 라우트 조회의 **네 축**을 한 곳에서 만든다 (상태 chip · 검색어 · name 접두사 · 조회 범위).
 *
 * 조회하는 곳이 여럿(`queryRoutes` · `syncTouched` · `loadOas`)인데 각자 `get()` 에서 필드를
 * 꺼내면 축이 하나 늘 때 어긋난다. 컨슈머는 username 을 그대로 넘긴다 — 캐시에 없는
 * username 이면 SQL 이 0건으로 답하므로, "필터가 조용히 풀려 전체가 보이는" 쪽보다
 * 안전한 방향으로 실패한다.
 */
function routeFilter(
  s: AppState,
): { chip: string; q: string; namePrefix: string; scope: RouteScope } {
  return { chip: s.chip, q: s.q, namePrefix: s.namePrefix, scope: s.routeScope };
}

export const useStore = create<AppState>((set, get) => ({
  env: "dev",
  section: "dash",
  view: "list",
  selId: null,
  tab: "form",
  chip: "all",
  routeScope: ALL_ROUTES,
  q: "",
  namePrefix: "",

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
  access: null,
  consumers: [],
  services: [],
  upstreams: [],
  dash: null,

  importDoc: null,
  importRows: [],
  importService: "",
  importPrefix: "",
  importNoProxy: true,
  importFileName: "",
  importBusy: false,
  importError: null,
  importChip: "all",
  importQ: "",
  importReturn: false,

  ...DIFF_RESET,

  toast: null,
  loading: false,
  saving: false,
  error: null,
  maxHover: false,

  booting: false,
  bootVariant: "overlay",
  bootStep: 0,
  bootTotal: 0,
  bootLabel: "",
  syncedAt: { dev: null, prod: null },

  // ── 초기화 ────────────────────────────────────────────────
  async loadSettings() {
    try {
      set({ settings: await api.settingsGet() });
    } catch (e) {
      // 여기서 throw 하면 App.tsx 가 창을 띄우지도, 부트스트랩을 돌리지도 못한다.
      set({ error: api.toAppError(e) });
    }
  },

  /**
   * 게이트웨이 전체 조회 → 캐시 갱신. 단계별로 진행률을 갱신한다.
   *
   * 단계를 배열로 두는 이유: `bootTotal` 을 손으로 관리하면 단계가 하나 늘 때 반드시 어긋난다.
   * 단계별 실패는 흡수하고 계속 간다(첫 에러만 남긴다) — services 를 못 받았다고 목록까지
   * 못 볼 이유는 없다. 다만 `syncedAt` 은 route·consumer 가 **모두** 성공했을 때만 찍는다.
   */
  async bootstrap(variant = "overlay") {
    const { env, settings } = get();
    // 토큰이 없는 환경은 잠금 화면이 뜨므로 호출하지 않는다. 에러도 세우지 않는다.
    if (!settings?.[env]?.hasToken) return;

    const token = ++bootToken;
    let firstError: AppError | null = null;
    let routesOk = false;
    let consumersOk = false;

    const steps: Array<[string, () => Promise<void>]> = [
      [
        "Route 목록 조회",
        async () => {
          await api.routesSync(env);
          routesOk = true;
        },
      ],
      [
        "Consumer 목록 조회",
        async () => {
          set({ consumers: await api.consumersSync(env) });
          consumersOk = true;
        },
      ],
      // Upstream 이 Service 보다 먼저다 — service 라벨의 (host:port) 를 캐시된 upstream 에서
      // 찾아 오므로 순서가 뒤바뀌면 라벨의 그 조각이 빈다 (commands::services_sync 주석).
      [
        "Upstream 목록 조회",
        async () => {
          set({ upstreams: await api.upstreamsSync(env) });
        },
      ],
      [
        "Service 목록 조회",
        async () => {
          set({ services: await api.servicesSync(env) });
        },
      ],
      [
        "접근 권한 집계",
        async () => {
          set({ access: await api.consumerAccessCounts(env) });
        },
      ],
    ];

    set({
      booting: true,
      bootVariant: variant,
      bootStep: 0,
      bootTotal: steps.length,
      bootLabel: steps[0][0],
      error: null,
    });

    try {
      for (let i = 0; i < steps.length; i += 1) {
        const [label, run] = steps[i];
        if (token !== bootToken) return; // 더 최신 부트스트랩이 시작됐다 — 이 결과는 버린다
        set({ bootStep: i, bootLabel: label });
        try {
          await run();
        } catch (e) {
          firstError = firstError ?? api.toAppError(e);
        }
      }
      if (token !== bootToken) return;

      set({
        bootStep: steps.length,
        ...(routesOk && consumersOk
          ? { syncedAt: { ...get().syncedAt, [env]: Date.now() } }
          : {}),
      });

      // 좌측 패널에서 사라진 범위가 걸려 있으면 풀어 준다. 안 풀면 고를 수 있는 행이
      // 하나도 없는데 목록은 0건인 상태에 갇힌다.
      //  · 게이트웨이에서 지워진 컨슈머
      //  · '그룹 제한 없음' 인데 그런 라우트가 더는 없는 경우 (그 행은 건수가 0이면
      //    아예 렌더되지 않는다 — SidePanel 참조)
      const { routeScope, consumers, access } = get();
      const gone =
        routeScope.kind === "consumer"
          ? !consumers.some((c) => c.username === routeScope.username)
          : routeScope.kind === "ungrouped"
            ? (access?.ungrouped ?? 0) === 0
            : false;
      if (gone) set({ routeScope: ALL_ROUTES });
      // 서비스 기본값 — 아직 고르지 않았다면 첫 항목.
      set({ importService: get().importService || get().services[0]?.id || "" });

      // queryRoutes 가 성공하면 error 를 null 로 밀어 버리므로, 단계 에러는 그 **뒤에** 세운다.
      // (Consumer 조회만 실패했을 때 빈 패널이 아무 설명 없이 남는 것을 막는다.)
      await get().queryRoutes();
      if (token === bootToken && firstError) set({ error: firstError });
    } finally {
      if (token === bootToken) set({ booting: false });
    }
  },

  setEnv(env) {
    if (get().env === env) return;
    // 환경이 바뀌면 다른 게이트웨이다 — 캐시에서 읽어 온 것을 모두 버린다.
    // username 은 환경 스코프라 routeScope 도 같이 지운다 (LIST_RESET 이 처리한다).
    set({
      env,
      ...LIST_RESET,
      routes: [],
      routesTotal: 0,
      routeCounts: NO_COUNTS,
      access: null,
      consumers: [],
      services: [],
      upstreams: [],
      dash: null,
      importService: "",
      importPrefix: "",
    });
    void (async () => {
      await get().bootstrap();
      if (get().section === "dash") await get().refresh();
    })();
  },

  go(section) {
    set({ section, ...LIST_RESET });
    // 목록은 캐시만 본다. 대시보드는 version·latency 가 라이브라야 의미가 있어 예외다.
    if (section === "routes") {
      void get().queryRoutes();
    } else if (section === "consumers") {
      void get().loadConsumers();
    } else if (section === "upstreams") {
      void get().loadUpstreams();
    } else if (section === "services") {
      void get().loadServices();
    } else {
      void get().refresh();
    }
  },

  setChip(chip) {
    set({ chip, view: "list", selId: null });
    // Route 는 캐시(SQLite)로 필터링한다. Consumer 는 배열 필터를 그대로 쓴다.
    if (get().section === "routes") void get().queryRoutes();
  },

  setRouteScope(scope) {
    // 같은 행을 다시 누르면 해제 — 패널에 별도 '해제' 버튼을 두지 않기 위해서다.
    // 객체가 아니라 scopeKey 로 비교한다 (types.ts 의 scopeKey 주석 참조).
    const next = scopeKey(get().routeScope) === scopeKey(scope) ? ALL_ROUTES : scope;
    set({ routeScope: next, view: "list", selId: null });
    void get().queryRoutes();
  },

  setQ(q) {
    set({ q });
    if (get().section !== "routes") return;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void get().queryRoutes(), SEARCH_DEBOUNCE_MS);
  },

  setNamePrefix(v) {
    // 목록 화면으로 되돌린다 — 상세를 열어 둔 채 필터를 바꾸면 결과가 보이지 않는다
    // (`setChip` · `setRouteScope` 와 같은 이유).
    set({ namePrefix: v, view: "list", selId: null });
    if (get().section !== "routes") return;
    if (namePrefixTimer) clearTimeout(namePrefixTimer);
    namePrefixTimer = setTimeout(() => void get().queryRoutes(), SEARCH_DEBOUNCE_MS);
  },

  /**
   * 게이트웨이를 다시 보는 화면만 여기서 처리한다.
   *
   * 목록(routes · consumers)은 캐시가 진실의 사본이므로 섹션 진입만으로 게이트웨이를 부르지
   * 않는다. 대시보드는 version·latency 가 라이브라야 의미가 있어 예외다 — 다만 route·consumer
   * 건수는 Rust 쪽에서 캐시로 세므로 전체 목록을 다시 받지는 않는다.
   */
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
    if (section !== "dash") return;

    // 토큰이 없는 환경은 잠금 화면이 뜨므로 호출하지 않는다.
    if (!settings?.[env]?.hasToken) return;

    set({ loading: true, error: null });
    try {
      set({ dash: await api.dashboard(env) });
    } catch (e) {
      set({ error: api.toAppError(e) });
    } finally {
      set({ loading: false });
    }
  },

  async queryRoutes() {
    const { env, settings } = get();
    if (!settings?.[env]?.hasToken) return;
    const { chip, q, namePrefix, scope } = routeFilter(get());

    const token = ++queryToken;
    try {
      const page = await api.routesQuery(env, chip, q, namePrefix, scope);
      // 더 최신 요청이 이미 나갔으면 이 응답은 버린다.
      if (token !== queryToken) return;
      set({ routes: page.items, routesTotal: page.total, routeCounts: page.counts, error: null });
    } catch (e) {
      if (token !== queryToken) return;
      set({ error: api.toAppError(e) });
    }
  },

  async loadConsumers() {
    const { env, settings } = get();
    if (!settings?.[env]?.hasToken) return;
    try {
      set({ consumers: await api.consumersCached(env), error: null });
    } catch (e) {
      set({ error: api.toAppError(e) });
    }
  },

  async loadUpstreams() {
    const { env, settings } = get();
    if (!settings?.[env]?.hasToken) return;
    try {
      set({ upstreams: await api.upstreamsCached(env), error: null });
    } catch (e) {
      set({ error: api.toAppError(e) });
    }
  },

  async loadServices() {
    const { env, settings } = get();
    if (!settings?.[env]?.hasToken) return;
    try {
      set({ services: await api.servicesCached(env), error: null });
    } catch (e) {
      set({ error: api.toAppError(e) });
    }
  },

  /**
   * Upstream 화면의 동기화 버튼.
   *
   * Service 목록까지 같이 다시 받는 이유: service 셀렉트 라벨의 `(host:port)` 는 upstream
   * 노드에서 온다. 노드를 고치고 Upstream 만 갱신하면 Service 화면의 라벨이 낡은 채로 남는다.
   */
  async syncUpstreams() {
    const { env, settings } = get();
    if (!settings?.[env]?.hasToken) return;

    set({ loading: true, error: null });
    try {
      set({ upstreams: await api.upstreamsSync(env) });
      set({ services: await api.servicesSync(env) });
    } catch (e) {
      const err = api.toAppError(e);
      set({ error: err });
      get().flash(err.message);
    } finally {
      set({ loading: false });
    }
  },

  async syncServices() {
    const { env, settings } = get();
    if (!settings?.[env]?.hasToken) return;

    set({ loading: true, error: null });
    try {
      set({ services: await api.servicesSync(env) });
    } catch (e) {
      const err = api.toAppError(e);
      set({ error: err });
      get().flash(err.message);
    } finally {
      set({ loading: false });
    }
  },

  /**
   * Route 를 고쳐도 패널 숫자가 바뀌므로 저장·삭제 양쪽에서 부른다.
   *
   * 실패해도 목록 자체는 멀쩡하니 에러를 세우지 않는다 — 패널 숫자가 잠시 낡을 뿐이다.
   */
  async refreshAccess() {
    const { env, settings } = get();
    if (!settings?.[env]?.hasToken) return;
    try {
      set({ access: await api.consumerAccessCounts(env) });
    } catch {
      /* 무시 */
    }
  },

  async hardRefresh() {
    const before = get().syncedAt[get().env];
    await get().bootstrap("bar");

    const { env, error, syncedAt, access, consumers } = get();
    if (error) {
      get().flash(error.message);
      return;
    }
    // 토큰이 없어 bootstrap 이 조용히 반환한 경우는 토스트도 띄우지 않는다.
    if (syncedAt[env] === before) return;
    get().flash(
      `게이트웨이와 동기화했습니다. (Route ${access?.all ?? 0}건 · Consumer ${consumers.length}건)`,
    );
    if (get().section === "dash") await get().refresh();
  },

  // ── 목록 → 상세 ───────────────────────────────────────────
  openItem(id) {
    const { section, routes, consumers } = get();
    const kind = kindOf(section);

    if (kind === "consumer") {
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

    // Service · Upstream 은 목록 전체가 캐시에서 배열로 와 있다 (Route 처럼 서버측
    // 필터링을 하지 않으므로 배열에 없으면 정말 없는 것이다).
    if (kind === "service" || kind === "upstream") {
      const { services, upstreams } = get();
      const found =
        kind === "service"
          ? services.find((x) => x.id === id)
          : upstreams.find((x) => x.id === id);
      if (!found) {
        get().flash("캐시에 없는 항목입니다. 동기화 후 다시 시도하세요.");
        return;
      }
      const form: FormState =
        kind === "service"
          ? serviceToForm(found as ServiceView)
          : upstreamToForm(found as UpstreamView);
      showMeta(set, id, form, found.raw);
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

  /**
   * 비교 결과의 등록된 행 클릭 (`일치` · `속성 차이`).
   *
   * 상세로 곧장 보내지 않고 **스펙 적용본과 저장분을 먼저 비교한다.** 차이가 없으면 그 단계를
   * 보여 줄 이유가 없으므로 지금까지와 똑같이 상세를 연다 (표의 `일치` 판정과 같은 갈림길이다 —
   * 양쪽 모두 `lib/importDiff` 의 같은 비교를 본다).
   */
  async openRouteFromImport(row) {
    const { env, importRows } = get();
    set({ importReturn: true });

    let route: RouteView | null;
    try {
      route = await api.routeCached(env, row.routeId);
    } catch (e) {
      const err = api.toAppError(e);
      set({ error: err });
      get().flash(err.message);
      return;
    }
    if (!route) {
      get().flash("캐시에 없는 라우트입니다. 리프레시 후 다시 시도하세요.");
      return;
    }

    const base = routeToForm(route);
    const fields = diffFields(row, base, importRows);
    if (!hasDiff(fields)) {
      set({ section: "routes", ...DIFF_RESET });
      showRoute(set, route);
      get().flash("스펙과 동일합니다.");
      return;
    }

    // **차이가 있는 항목은 처음부터 모두 선택해 둔다.** 이 화면까지 온 이유가 "스펙대로
    // 맞추겠다" 라서, 빼고 싶은 것만 해제하는 편이 짧다. 그래서 `form` 은 처음부터 적용본이고
    // 화면의 '적용 후' 미리보기도 처음부터 그것을 보여 준다.
    const sel = allChanges(fields);
    const form = applySelection(base, row, sel);
    set({
      section: "routes",
      view: "diff",
      selId: route.id,
      tab: "form",
      form,
      jsonDraft: jsonText(form),
      jsonErr: "",
      jsonOk: "",
      groupDraft: "",
      rawJson: route.raw ? JSON.stringify(route.raw, null, 2) : null,
      jwt: null,
      error: null,
      diffRow: row,
      diffBase: base,
      diffRoute: route,
      diffSel: sel,
    });
  },

  newItem() {
    const { section, services, upstreams } = get();
    const kind = kindOf(section);
    const form: FormState =
      kind === "consumer"
        ? emptyConsumerForm()
        : kind === "service"
          ? emptyServiceForm(upstreams[0]?.id ?? "")
          : kind === "upstream"
            ? emptyUpstreamForm()
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
    set({ section: "routes", ...LIST_RESET });
    // services 가 채워져야 service_id 셀렉트의 기본값을 정할 수 있다.
    // 부트스트랩이 이미 채웠으면 다시 부르지 않는다 (실패했을 때만 한 번 더 시도한다).
    if (get().services.length === 0) {
      const { env } = get();
      set({ services: await api.servicesCached(env).catch(() => [] as ServiceView[]) });
    }
    void get().queryRoutes();
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
      ...DIFF_RESET,
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

    // 파일 첨부 없이 들어온 상태다 — 고른 service 에 spec_url 이 있으면 바로 읽어 준다.
    const id = get().importService;
    if (id) void get().loadSpecForService(id);
  },

  async loadOas(source, fileName) {
    const { env } = get();
    set({
      importBusy: true,
      importError: null,
      importDoc: null,
      importRows: [],
      // 파일에서 읽은 경우에만 칩을 세운다. spec_url 경로는 미첨부 상태를 유지해야
      // service 를 바꿀 때 다시 spec_url 을 타고 들어간다 (setImportService 참조).
      ...(fileName !== undefined ? { importFileName: fileName } : {}),
    });
    try {
      // 스펙을 먼저 읽는다 — 파일이 잘못됐으면 게이트웨이를 부를 이유가 없다.
      const doc = await api.oasLoad(env, source);

      // 판정의 근거가 캐시이므로 여기서 한 번 갱신한다. 게이트웨이에서 이미 지워진 라우트를
      // '등록' 으로 보여 주면 이 화면의 존재 이유가 없어지므로, 실패하면 비교하지 않는다.
      await api.routesSync(env);

      set({
        importDoc: doc,
        importPrefix: doc.serverPrefix,
        importChip: "all",
        importQ: "",
      });
    } catch (e) {
      set({ importError: api.toAppError(e) });
      return;
    } finally {
      set({ importBusy: false });
    }
    // 캐시가 바뀌었으니 목록과 패널 숫자도 맞춰 둔다.
    await get().queryRoutes();
    await get().refreshAccess();
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

  /**
   * service 선택 — 첨부 파일이 있으면 그 스펙으로, 없으면 service 의 spec_url 로 비교한다.
   *
   * 이 갈림길이 Import 화면의 두 모드다. 첨부된 스펙은 이미 캐시(`oas_ops`)에 적재돼 있으니
   * 비교만 다시 돌리면 되고, 미첨부면 읽을 스펙 자체를 service 에서 찾아야 한다.
   */
  setImportService(id) {
    set({ importService: id });
    if (get().importFileName) {
      void get().runCompare();
    } else {
      void get().loadSpecForService(id);
    }
  },

  async loadSpecForService(id) {
    if (!id) {
      set({ importDoc: null, importRows: [], importError: null });
      return;
    }

    const svc = get().services.find((x) => x.id === id);
    const url = svc?.specUrl?.trim() ?? "";
    if (!url) {
      // 파일도 없고 주소도 없으면 비교할 근거가 없다. 어디서 채우면 되는지 알려 준다.
      set({
        importDoc: null,
        importRows: [],
        importError: {
          kind: "config",
          message: "이 service 에는 spec_url 이 없습니다.",
          hint: "Service 화면에서 spec_url 을 등록하거나, 위에 스펙 파일을 첨부하세요.",
        },
      });
      return;
    }

    await get().loadOas({ kind: "url", value: url, noProxy: get().importNoProxy });
  },

  /**
   * 첨부 초기화(`×`).
   *
   * 그냥 비우고 끝내지 않고 service 의 spec_url 로 되돌아간다 — 파일을 떼어 낸 사용자가
   * 보고 싶은 것은 빈 화면이 아니라 "게이트웨이에 등록된 스펙" 쪽 비교 결과다.
   */
  async clearImportFile() {
    set({ importFileName: "", importDoc: null, importRows: [], importError: null });
    const id = get().importService;
    if (id) await get().loadSpecForService(id);
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
      ...DIFF_RESET,
    });
  },

  // ── Import diff ───────────────────────────────────────────
  //
  // 선택이 바뀔 때마다 `form` 을 다시 만든다. 그래야 화면의 '적용 후' 미리보기와 저장 버튼이
  // **같은 값**을 보고, 저장이 기존 `save()` 경로를 손대지 않고 그대로 탈 수 있다.
  setDiffSel(patch) {
    const { diffBase, diffRow, diffSel } = get();
    if (!diffBase || !diffRow) return;
    const next = { ...diffSel, ...patch };
    const form = applySelection(diffBase, diffRow, next);
    set({ diffSel: next, form, jsonDraft: jsonText(form) });
  },

  setDiffAll(on) {
    const { diffBase, diffRow, importRows } = get();
    if (!diffBase || !diffRow) return;
    const next = on ? allChanges(diffFields(diffRow, diffBase, importRows)) : NO_SELECTION;
    const form = applySelection(diffBase, diffRow, next);
    set({ diffSel: next, form, jsonDraft: jsonText(form) });
  },

  skipDiffToDetail() {
    const { diffRoute } = get();
    if (!diffRoute) return;
    // 고르던 것은 버린다 — '적용 없이' 이므로 상세는 게이트웨이 값 그대로여야 한다.
    set(DIFF_RESET);
    showRoute(set, diffRoute);
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

  addGroup(value) {
    const { form, groupDraft } = get();
    // allowed_groups 는 route·consumer 에만 있다 (Service·Upstream 폼에는 이 카드가 없다).
    if (!form || (form.kind !== "route" && form.kind !== "consumer")) return;
    // 콤보박스에서 마우스로 고른 값은 입력칸을 거치지 않으므로 인자로 받는다.
    const v = (value ?? groupDraft).trim();
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
    if (!form || (form.kind !== "route" && form.kind !== "consumer")) return;
    get().patchForm({ groups: form.groups.filter((_, j) => j !== i) });
  },

  // ── 담당자 (labels · name{n}/dept{n}) ─────────────────────
  //
  // 세 액션 모두 patchForm 을 거친다. set({ form }) 으로 우회하면 JSON 탭의 jsonDraft 가
  // 조용히 어긋난다 (patchForm 주석 참조).

  addContact() {
    const { form } = get();
    if (!form || form.kind !== "consumer") return;
    get().patchForm({ contacts: [...form.contacts, { name: "", dept: "" }] });
  },

  patchContact(i, patch) {
    const { form } = get();
    if (!form || form.kind !== "consumer") return;
    get().patchForm({
      contacts: form.contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    });
  },

  removeContact(i) {
    const { form } = get();
    if (!form || form.kind !== "consumer") return;
    get().patchForm({ contacts: form.contacts.filter((_, j) => j !== i) });
  },

  async makeSecret() {
    try {
      get().patchForm({ secret: await api.genSecret(), hasSecret: true });
    } catch (e) {
      set({ error: api.toAppError(e) });
    }
  },

  // ── JSON 탭 ───────────────────────────────────────────────
  /**
   * 노드 편집 3형제. `addContact`/`patchContact`/`removeContact` 와 같은 모양이고,
   * 같은 이유로 전부 `patchForm` 을 경유한다 (JSON 탭 draft 동기화를 한 곳에 둔다).
   */
  addNode() {
    const { form } = get();
    if (!form || form.kind !== "upstream") return;
    get().patchForm({ nodes: [...form.nodes, { host: "", port: "", weight: "1" }] });
  },

  patchNode(i, patch) {
    const { form } = get();
    if (!form || form.kind !== "upstream") return;
    const nodes = form.nodes.map((n, k) => (k === i ? { ...n, ...patch } : n));
    get().patchForm({ nodes });
  },

  removeNode(i) {
    const { form } = get();
    if (!form || form.kind !== "upstream") return;
    // 노드가 하나도 없는 upstream 은 게이트웨이가 거부한다 — 마지막 행은 남긴다.
    if (form.nodes.length <= 1) {
      get().flash("노드는 하나 이상 있어야 합니다.");
      return;
    }
    get().patchForm({ nodes: form.nodes.filter((_, k) => k !== i) });
  },

  patchTimeout(patch) {
    const { form } = get();
    if (!form || form.kind !== "upstream") return;
    get().patchForm({ timeout: { ...form.timeout, ...patch } });
  },

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

    // 서버 왕복 전에 즉시 알려주는 필수값 검사. 형태별 규칙은 Rust 의 validate 와 짝이다.
    const missing = (() => {
      switch (form.kind) {
        case "consumer":
          return !form.username.trim() || !form.key.trim() || !form.secret.trim();
        case "service":
          return !form.name.trim() || !form.upstreamId.trim() || !form.logKey.trim();
        case "upstream":
          return (
            !form.name.trim() ||
            form.nodes.length === 0 ||
            // 정수까지 여기서 본다. Rust 의 port·weight 는 i64 라 소수점이 들어오면
            // 역직렬화 단계에서 죽고, 그 에러는 어느 값이 틀렸는지 알려 주지 않는다.
            // JSON 탭으로 노드를 편집할 수 있게 되면서 들어올 경로가 늘었다.
            // weight 는 빈 칸이 허용된다 — api.ts 가 null 로 보내고 Rust 가 1 을 넣는다.
            form.nodes.some(
              (n) =>
                !n.host.trim() ||
                !intText(n.port) ||
                (n.weight.trim() !== "" && !intText(n.weight)),
            )
          );
        default:
          return !form.name.trim() || !form.uri.trim() || !form.serviceId.trim();
      }
    })();
    if (missing) {
      get().flash("필수 항목을 입력하세요.");
      return;
    }

    set({ saving: true, error: null });
    try {
      // 섹션(kindOf)이 아니라 폼의 판별 유니온으로 분기한다 — 화면과 폼이 어긋날 여지를 없앤다.
      if (form.kind === "consumer") {
        await api.consumerSave(env, form);
        get().flash("Consumer가 저장되었습니다.");
      } else if (form.kind === "service") {
        await api.serviceSave(env, form);
        get().flash("Service가 저장되었습니다. (jwt-auth · shi-log 포함)");
      } else if (form.kind === "upstream") {
        await api.upstreamSave(env, form);
        get().flash("Upstream이 저장되었습니다.");
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
        ...DIFF_RESET,
      });
      // 캐시를 갱신한 뒤 비교를 다시 돌리면 방금 만든 API 가 '등록' 으로 바뀐다.
      await get().syncTouched(form.kind);
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
      } else if (form.kind === "service") {
        await api.serviceDelete(env, form.id ?? "", form.name);
      } else if (form.kind === "upstream") {
        await api.upstreamDelete(env, form.id ?? "", form.name);
      } else {
        await api.routeDelete(env, form.id ?? "", form.name);
      }
      get().flash("삭제되었습니다.");
      set({ view: "list", selId: null, form: null, jwt: null, importReturn: false, ...DIFF_RESET });
      // 조회 범위로 걸어 둔 컨슈머를 지웠으면 유령 조건이 남지 않게 풀어 준다.
      const scope = get().routeScope;
      if (
        form.kind === "consumer" &&
        scope.kind === "consumer" &&
        scope.username === form.username
      ) {
        set({ routeScope: ALL_ROUTES });
      }
      await get().syncTouched(form.kind);
    } catch (e) {
      const err = api.toAppError(e);
      set({ error: err });
      get().flash(err.message);
    } finally {
      set({ saving: false });
    }
  },

  /**
   * 저장·삭제 직후의 재동기화.
   *
   * 전체 부트스트랩을 다시 돌리지 않는 이유는 명백하지만, **건드린 리소스는 반드시 전체를
   * 다시 받아야 한다** — 부분 갱신을 하면 게이트웨이에서 지워진 항목이 캐시에 남는다
   * (db.rs 의 sync_routes 주석). 접근 집계는 route 를 고쳐도 바뀌므로 양쪽에서 다시 센다.
   */
  async syncTouched(kind) {
    const { env, settings } = get();
    if (!settings?.[env]?.hasToken) return;

    set({ loading: true });
    try {
      if (kind === "consumer") {
        set({ consumers: await api.consumersSync(env) });
      } else if (kind === "service") {
        set({ services: await api.servicesSync(env) });
      } else if (kind === "upstream") {
        // 노드가 바뀌면 service 셀렉트 라벨의 (host:port) 도 바뀐다 — 둘 다 다시 받는다.
        set({ upstreams: await api.upstreamsSync(env) });
        set({ services: await api.servicesSync(env) });
      } else {
        await api.routesSync(env);
      }
      // Route 목록·접근 집계는 route/consumer 를 건드렸을 때만 의미가 있다.
      if (kind === "route" || kind === "consumer") {
        await get().queryRoutes();
        await get().refreshAccess();
      }
    } catch (e) {
      set({ error: api.toAppError(e) });
    } finally {
      set({ loading: false });
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
      // 섹션 진입이 더 이상 게이트웨이를 부르지 않으므로, 토큰이 방금 생겼다면 여기서
      // 캐시를 채워 줘야 한다. 안 그러면 사용자는 새로고침 아이콘을 찾아낼 때까지
      // 빈 목록만 보게 된다.
      if (env === get().env && settings[env].hasToken) void get().bootstrap();
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

/** Service · Upstream 상세를 여는 공통 부분. `showRoute` 와 같은 자리를 채운다. */
function showMeta(
  set: (partial: Partial<AppState>) => void,
  id: string,
  form: FormState,
  raw: unknown,
): void {
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

/**
 * Import 비교 결과 필터 — 판정 chip + 검색어. 건수가 적어 클라이언트에서 처리한다.
 *
 * chip 은 Rust 의 `state` 가 아니라 화면 판정(`rowVerdict`)이다 — 등록된 건이 스펙과 값까지
 * 같은지가 표의 축이기 때문이다.
 */
export function filterCompareRows(
  rows: CompareRow[],
  chip: RowVerdict | "all",
  q: string,
): CompareRow[] {
  let out = rows;
  if (chip !== "all") out = out.filter((r) => rowVerdict(r) === chip);
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
