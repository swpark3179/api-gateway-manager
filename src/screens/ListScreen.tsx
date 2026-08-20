/** Route / Consumer 목록 — 디자인의 '목록' 화면. */

import { useMemo } from "react";

import { maskSecret } from "../lib/design";
import { consumerGroupBuckets, filterConsumers, kindOf, useStore } from "../store";

const ROW_H = "14px 16px";

interface Row {
  id: string;
  c1: string;
  c1sub: string;
  c2: string;
  tags: string[];
  c4: string;
  groups: string[];
  badge: string;
  status: string;
  updated: string;
}

export default function ListScreen() {
  const section = useStore((s) => s.section);
  const env = useStore((s) => s.env);
  const chip = useStore((s) => s.chip);
  const q = useStore((s) => s.q);
  const setQ = useStore((s) => s.setQ);
  const setChip = useStore((s) => s.setChip);
  const newItem = useStore((s) => s.newItem);
  const openItem = useStore((s) => s.openItem);
  const openImport = useStore((s) => s.openImport);
  const hardRefresh = useStore((s) => s.hardRefresh);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  const settings = useStore((s) => s.settings);
  // Route 는 내장 SQLite 가 이미 필터링해 준 결과다 (store.ts 모듈 주석 참조).
  const routes = useStore((s) => s.routes);
  const routesTotal = useStore((s) => s.routesTotal);
  const routeCounts = useStore((s) => s.routeCounts);
  const allConsumers = useStore((s) => s.consumers);

  const kind = kindOf(section);
  const isConsumer = kind === "consumer";

  // 새 배열을 만드는 계산이라 스토어 셀렉터가 아니라 useMemo 로 감싼다.
  const consumers = useMemo(
    () => filterConsumers(allConsumers, chip, q),
    [allConsumers, chip, q],
  );

  const rows: Row[] = isConsumer
    ? consumers.map((c) => ({
        id: c.username,
        c1: c.username,
        c1sub: c.key,
        c2: maskSecret(c.secret),
        tags: c.hasJwtAuth ? ["jwt-auth"] : [],
        c4: "HS256",
        groups: c.groups,
        badge: "success",
        status: "사용 중",
        updated: c.updated,
      }))
    : routes.map((r) => ({
        id: r.id,
        c1: r.name || "(이름 없음)",
        c1sub: r.serviceId || "—",
        c2: r.uri,
        tags: r.methods,
        c4: r.rewrite || "—",
        groups: r.groups,
        badge: r.status === 1 ? "success" : "neutral",
        status: r.status === 1 ? "1 · 활성" : "0 · 비활성",
        updated: r.updated,
      }));

  const cols = isConsumer
    ? ["username / key", "secret", "plugins", "alg", "auth-groups", "상태", "수정일시"]
    : ["name / service_id", "uri", "methods", "proxy-rewrite", "allowed_groups", "status", "수정일시"];

  // Consumer 는 실제 auth-groups 값으로, Route 는 status 로 나눈다.
  const chipKeys: Array<[string, string]> = useMemo(
    () =>
      isConsumer
        ? [
            ["all", "전체"] as [string, string],
            ...consumerGroupBuckets(allConsumers).map(
              (b) => [b.key, `${b.label} (${b.count})`] as [string, string],
            ),
          ]
        : [
            // 건수는 캐시가 돌려준 값이다 — 검색어는 반영하고 chip 은 빼서 계산한다.
            ["all", `전체 (${routeCounts.all})`],
            ["on", `status 1 (${routeCounts.on})`],
            ["off", `status 0 (${routeCounts.off})`],
          ],
    [isConsumer, allConsumers, routeCounts],
  );

  const adminBase = settings?.[env]?.adminBase ?? "";
  const listApiPath = `${adminBase}/${isConsumer ? "consumers" : "routes"}`;

  return (
    <div data-screen-label="목록" style={{ padding: "24px 28px 48px" }}>
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div>
          <h2 className="page-title" style={{ fontSize: 24, lineHeight: "32px" }}>
            {isConsumer ? "Consumer" : "Route"}
          </h2>
          <p className="page-sub">
            {isConsumer
              ? "jwt-auth 기반 소비자 계정을 등록하고 토큰을 발급합니다."
              : "등록된 라우트를 조회하고 uri · methods · 플러그인을 관리합니다."}
          </p>
        </div>
        <div className="page-actions">
          {!isConsumer && (
            <>
              <button
                className="icon-btn"
                title="게이트웨이에서 전체 목록을 다시 조회해 로컬 캐시를 갱신합니다"
                onClick={() => void hardRefresh()}
                disabled={loading}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M20 11a8 8 0 1 0-2.3 5.7" />
                  <path d="M20 4v7h-7" />
                </svg>
              </button>
              <button className="btn md outline" onClick={openImport}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 3v12M7 10l5 5 5-5" />
                  <path d="M4 19h16" />
                </svg>
                Import
              </button>
            </>
          )}
          <div className="gnb-search" style={{ width: 240, height: 36 }}>
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="var(--gray-400)"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-4.2-4.2" />
            </svg>
            <input
              placeholder={isConsumer ? "username · key 검색" : "name · uri 검색"}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button className="btn md solid-primary" onClick={newItem}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            {isConsumer ? "신규 Consumer" : "신규 Route"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {chipKeys.map(([k, label]) => (
          <div
            key={k}
            className={"chip" + (chip === k ? " on" : "")}
            onClick={() => setChip(k)}
          >
            {label}
          </div>
        ))}
      </div>

      {error && (
        <div
          className="card-surface"
          style={{
            padding: "16px 20px",
            marginBottom: 16,
            background: "var(--red-50)",
            borderColor: "var(--red-200)",
          }}
        >
          <div style={{ font: "500 13px/20px var(--font-sans)", color: "var(--red-700)" }}>
            {error.message}
          </div>
          {error.hint && (
            <div
              className="text-sm"
              style={{ color: "var(--red-700)", opacity: 0.85, marginTop: 4 }}
            >
              {error.hint}
            </div>
          )}
        </div>
      )}

      <table className="kw-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} style={{ whiteSpace: "nowrap" }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => openItem(r.id)} style={{ cursor: "pointer" }}>
              <td style={{ padding: ROW_H }}>
                <div className="name">{r.c1}</div>
                <div className="mono">{r.c1sub}</div>
              </td>
              <td className="mono" style={{ padding: ROW_H }}>
                {r.c2}
              </td>
              <td style={{ padding: ROW_H }}>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {r.tags.map((t) => (
                    <span
                      key={t}
                      className="badge neutral"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </td>
              <td className="mono" style={{ padding: ROW_H }}>
                {r.c4}
              </td>
              <td style={{ padding: ROW_H }}>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {r.groups.map((g) => (
                    <span key={g} className="badge primary">
                      {g}
                    </span>
                  ))}
                </div>
              </td>
              <td style={{ padding: ROW_H }}>
                <span className={"badge " + r.badge}>
                  <span className="dot" />
                  {r.status}
                </span>
              </td>
              <td className="mono" style={{ padding: ROW_H }}>
                {r.updated}
              </td>
            </tr>
          ))}

          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length} style={{ padding: 0 }}>
                <div className="state-block">
                  {loading ? (
                    <>
                      <div className="spinner" />
                      <div className="msg">불러오는 중…</div>
                    </>
                  ) : (
                    <div className="msg">
                      {q.trim() || chip !== "all"
                        ? "조건에 맞는 항목이 없습니다."
                        : error
                          ? "목록을 불러오지 못했습니다."
                          : `등록된 ${isConsumer ? "Consumer" : "Route"}가 없습니다.`}
                    </div>
                  )}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "14px 4px",
          font: "400 12px/16px var(--font-mono)",
          color: "var(--gray-500)",
        }}
      >
        <span>총 {isConsumer ? rows.length : routesTotal}건</span>
        <span className="selectable">GET {listApiPath}</span>
      </div>
    </div>
  );
}
