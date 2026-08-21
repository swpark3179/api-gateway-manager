/**
 * Rust 커맨드 래퍼.
 *
 * 게이트웨이로 나가는 HTTP 는 **전부** 여기를 통해 Rust 로 넘어간다.
 * 웹뷰(WebView2)는 시스템 프록시를 따르므로 프런트에서 fetch 로 게이트웨이를 부르면
 * "무조건 비프록시" 조건이 깨진다. tauri.conf.json 의 CSP 가 이를 구조적으로 막고 있다.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AccessCounts,
  AppError,
  CompareRow,
  ConsumerFormState,
  ConsumerView,
  DashboardPayload,
  EnvKey,
  EnvPayload,
  ImportSource,
  JwtResult,
  OasDoc,
  RouteFormState,
  RoutesPage,
  RouteView,
  ServiceOption,
  SettingsView,
  TestResult,
} from "./types";

/** Rust 가 던진 AppError 인지 판별한다. */
export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  return { kind: "internal", message: String(e) };
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

// ── 설정 ─────────────────────────────────────────────────────

export const settingsGet = () => call<SettingsView>("settings_get");

export const settingsSave = (env: EnvKey, payload: EnvPayload) =>
  call<SettingsView>("settings_save", { env, payload });

export const settingsTest = (env: EnvKey, payload: EnvPayload) =>
  call<TestResult>("settings_test", { env, payload });

// ── Route ────────────────────────────────────────────────────

/**
 * 게이트웨이에서 Route 전체 목록을 다시 받아 내장 SQLite 캐시를 갱신한다. 반환값은 건수다.
 *
 * 채우기(sync)와 읽기(query)를 나눈 이유: 조회 축이 셋(chip · 검색어 · 컨슈머)이라
 * 채우기에 필터를 실어 보내면 호출부마다 세 인자를 끌고 다녀야 한다.
 */
export const routesSync = (env: EnvKey) => call<number>("routes_sync", { env });

/** 캐시만 조회한다 — 필터가 바뀔 때마다 게이트웨이를 다시 부르지 않는다. */
export const routesQuery = (env: EnvKey, chip: string, q: string, consumer: string | null) =>
  call<RoutesPage>("routes_query", { env, chip, q, consumer });

/** 캐시에서 라우트 한 건. 목록이 필터돼 있어도 상세로 갈 수 있게 해 준다. */
export const routeCached = (env: EnvKey, id: string) =>
  call<RouteView | null>("route_cached", { env, id });

export const routeSave = (env: EnvKey, f: RouteFormState) =>
  call<RouteView>("route_save", {
    env,
    form: {
      id: f.id,
      name: f.name,
      uri: f.uri,
      desc: f.desc,
      methods: f.methods,
      serviceId: f.serviceId,
      rewrite: f.rewrite,
      groups: f.groups,
      status: f.status,
      groupsLocation: f.groupsLocation,
    },
  });

export const routeDelete = (env: EnvKey, id: string, name: string) =>
  call<void>("route_delete", { env, id, name });

// ── OAS Import ───────────────────────────────────────────────

/**
 * 스펙을 읽어 파싱하고 비교용으로 캐시에 적재한다.
 *
 * URL 경로가 Rust 에 있는 이유는 CSP(`connect-src 'self' ipc:`)가 웹뷰의 외부 통신을
 * 막고 있기 때문이다 — 프런트에서 fetch 하면 즉시 실패한다.
 */
export const oasLoad = (env: EnvKey, source: ImportSource) =>
  call<OasDoc>("oas_load", { env, source });

/** 적재된 스펙을 선택한 service 안의 라우트와 비교한다. */
export const oasCompare = (env: EnvKey, serviceId: string, prefix: string) =>
  call<CompareRow[]>("oas_compare", { env, serviceId, prefix });

// ── Consumer ─────────────────────────────────────────────────

/** 게이트웨이에서 Consumer 전체 목록을 다시 받아 캐시를 갱신하고 그 목록을 돌려준다. */
export const consumersSync = (env: EnvKey) => call<ConsumerView[]>("consumers_sync", { env });

/** 캐시의 Consumer 전체 목록 (게이트웨이 호출 없음). */
export const consumersCached = (env: EnvKey) => call<ConsumerView[]>("consumers_cached", { env });

/** Route 화면 좌측 패널의 컨슈머별 접근 가능 건수. routes·consumers 동기화 후에 부른다. */
export const consumerAccessCounts = (env: EnvKey) =>
  call<AccessCounts>("consumer_access_counts", { env });

export const consumerSave = (env: EnvKey, f: ConsumerFormState) =>
  call<ConsumerView>("consumer_save", {
    env,
    form: {
      username: f.username,
      desc: f.desc,
      key: f.key,
      secret: f.secret,
      groups: f.groups,
      isNew: f.isNew,
      groupsLocation: f.groupsLocation,
      // 이 줄을 빠뜨리면 Rust 쪽 contacts 가 null 로 들어가 "labels 를 건드리지 않는다"가 된다.
      // 지워지는 게 아니라 유지되는 쪽으로 degrade 하도록 Option<Vec<_>> 으로 받는다.
      contacts: f.contacts,
    },
  });

export const consumerDelete = (env: EnvKey, username: string) =>
  call<void>("consumer_delete", { env, username });

// ── 기타 ─────────────────────────────────────────────────────

export const servicesList = (env: EnvKey) => call<ServiceOption[]>("services_list", { env });

export const dashboard = (env: EnvKey) => call<DashboardPayload>("dashboard", { env });

/** nbf · exp 는 Rust 쪽 고정값을 쓴다 (nbf 2025-08-01 00:00, exp 3000-12-31 17:59). */
export const jwtSign = (key: string, secret: string) =>
  call<JwtResult>("jwt_sign", { key, secret, nbf: null, exp: null });

export const genSecret = () => call<string>("gen_secret");

export const appReady = () => call<void>("app_ready");
