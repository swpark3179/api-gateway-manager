/**
 * Rust 커맨드 래퍼.
 *
 * 게이트웨이로 나가는 HTTP 는 **전부** 여기를 통해 Rust 로 넘어간다.
 * 웹뷰(WebView2)는 시스템 프록시를 따르므로 프런트에서 fetch 로 게이트웨이를 부르면
 * "무조건 비프록시" 조건이 깨진다. tauri.conf.json 의 CSP 가 이를 구조적으로 막고 있다.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AppError,
  ConsumerFormState,
  ConsumerView,
  DashboardPayload,
  EnvKey,
  EnvPayload,
  JwtResult,
  RouteFormState,
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

export const routesList = (env: EnvKey) => call<RouteView[]>("routes_list", { env });

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

// ── Consumer ─────────────────────────────────────────────────

export const consumersList = (env: EnvKey) => call<ConsumerView[]>("consumers_list", { env });

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
