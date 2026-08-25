/** Route / Consumer 목록 — 디자인의 '목록' 화면. */

import { useMemo } from "react";

import { maskSecret, syncLabel } from "../lib/design";
import { filterConsumers, kindOf, NO_GROUP, useStore } from "../store";
import GroupCombo from "../components/GroupCombo";
import { ALL_ROUTES, rewriteText, scopeLabel } from "../types";

const ROW_H = "14px 16px";

interface ReleaseChipProps {
  /** 어느 축인지 (`consumer` · `auth-groups`) */
  label: string;
  value: string;
  title: string;
  onClear: () => void;
}

/** 지금 걸린 필터를 알려 주고 × 로 풀어 주는 칩. */
function ReleaseChip({ label, value, title, onClear }: ReleaseChipProps) {
  return (
    <div className="chip on" style={{ cursor: "default" }}>
      <span style={{ fontSize: 12 }}>{label}: </span>
      <span className="font-mono" style={{ fontSize: 12 }}>
        {value}
      </span>
      <span className="x" onClick={onClear} style={{ cursor: "pointer" }} title={title}>
        <svg
          viewBox="0 0 24 24"
          width="11"
          height="11"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </span>
    </div>
  );
}

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
  const booting = useStore((s) => s.booting);
  const error = useStore((s) => s.error);
  const settings = useStore((s) => s.settings);
  const syncedAt = useStore((s) => s.syncedAt[s.env]);
  const routeScope = useStore((s) => s.routeScope);
  const setRouteScope = useStore((s) => s.setRouteScope);
  const namePrefix = useStore((s) => s.namePrefix);
  const setNamePrefix = useStore((s) => s.setNamePrefix);
  // 접두사 후보는 Service 의 `labels.name_prefix` 다 — 이미 메모리에 있어 새 IPC 가 없다.
  const services = useStore((s) => s.services);
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
        // 사람이 목록에서 찾는 것은 식별자가 아니라 설명이다. username 은 그 아래 줄로 내리되
        // 사라지게 두지는 않는다 — APISIX 식별자이고 상세 화면의 열쇠다.
        c1: c.desc || "(설명 없음)",
        c1sub: c.username,
        c2: maskSecret(c.secret),
        tags: c.hasJwtAuth ? ["jwt-auth"] : [],
        // 예전 자리는 항상 `HS256` 이라 행마다 같은 값이었다. 서브라인에서 밀려난 key 를 넣는다.
        c4: c.key,
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
        // regex_uri 를 그리지 않으면 그 route 만 빈칸으로 보인다 (`rewriteText`).
        c4: rewriteText(r) || "—",
        groups: r.groups,
        badge: r.status === 1 ? "success" : "neutral",
        status: r.status === 1 ? "1 · 활성" : "0 · 비활성",
        updated: r.updated,
      }));

  const cols = isConsumer
    ? ["desc / username", "secret", "plugins", "key", "auth-groups", "상태", "수정일시"]
    : ["name / service_id", "uri", "methods", "proxy-rewrite", "allowed_groups", "status", "수정일시"];

  /**
   * 상단 chip 은 Route 의 status 축 전용이다.
   *
   * Consumer 의 권한그룹 버킷은 좌측 패널이 이미 같은 값을 같은 건수로 보여 주고 있어서,
   * 화면에 두 번 두면 어느 쪽이 켜져 있는지가 오히려 헷갈린다. 대신 고른 그룹만 아래의
   * 해제 칩으로 남긴다 (Route 의 consumer 칩과 같은 이유 — 그 주석 참조).
   */
  /**
   * name 접두사 후보 — Service 에 등록된 `labels.name_prefix` 를 모은다.
   *
   * route 명에서 역산하지 않는다. 접두어는 service 단위로 **정해 둔 규약**이고
   * (`ServiceForm` 의 'name 접두어'), 이름에서 첫 구분자 앞을 잘라 모으면 규약이 아닌
   * 우연한 조각까지 후보로 올라온다. 규약에 없는 값이 필요하면 직접 입력하면 된다.
   */
  const prefixOptions = useMemo(
    () =>
      Array.from(
        new Set(services.map((v) => v.namePrefix.trim()).filter(Boolean)),
      ).sort(),
    [services],
  );

  const chipKeys: Array<[string, string]> = useMemo(
    () =>
      isConsumer
        ? []
        : [
            // 건수는 캐시가 돌려준 값이다 — 검색어는 반영하고 chip 은 빼서 계산한다.
            ["all", `전체 (${routeCounts.all})`],
            ["on", `status 1 (${routeCounts.on})`],
            ["off", `status 0 (${routeCounts.off})`],
          ],
    [isConsumer, routeCounts],
  );

  // 좌측 패널에서 걸어 둔 조건을 본문에도 남긴다. 두 화면이 서로 다른 축을 쓰지만
  // (Consumer 는 chip, Route 는 조회 범위) 사용자에게는 같은 "지금 걸린 필터" 다.
  const release: ReleaseChipProps | null = isConsumer
    ? chip === "all"
      ? null
      : {
          label: "auth-groups",
          value: chip === NO_GROUP ? "(그룹 없음)" : chip,
          title: "권한그룹 필터 해제",
          onClear: () => setChip("all"),
        }
    : scopeLabel(routeScope)
      ? {
          // 컨슈머 한 명이면 그 이름을, '그룹 제한 없음' 이면 그 이름을 그대로 보여 준다.
          label: routeScope.kind === "consumer" ? "consumer" : "범위",
          value: scopeLabel(routeScope)!,
          title: "조회 범위 해제",
          onClear: () => setRouteScope(ALL_ROUTES),
        }
      : null;

  // 접두사는 조회 범위와 별개 축이라 해제 칩도 따로 낸다 (둘 다 켜질 수 있다).
  const prefixRelease: ReleaseChipProps | null =
    !isConsumer && namePrefix.trim() !== ""
      ? {
          label: "name 접두사",
          value: namePrefix.trim(),
          title: "name 접두사 필터 해제",
          onClear: () => setNamePrefix(""),
        }
      : null;

  const adminBase = settings?.[env]?.adminBase ?? "";
  const listApiPath = `${adminBase}/${isConsumer ? "consumers" : "routes"}`;

  // 화면 진입이 더 이상 게이트웨이를 부르지 않으므로 "등록된 …가 없습니다" 만으로는
  // "게이트웨이에 없다" 와 "캐시를 아직 못 채웠다" 를 구별할 수 없다. 네 경우를 나눈다.
  // 조건 판정에 조회 범위를 반드시 포함해야 한다 — 빠뜨리면 컨슈머를 골라 0건이 됐을 때
  // "등록된 Route가 없습니다" 가 뜬다.
  const filtered =
    q.trim() !== "" ||
    chip !== "all" ||
    (!isConsumer && (routeScope.kind !== "all" || namePrefix.trim() !== ""));
  const emptyState =
    loading || booting ? (
      <>
        <div className="spinner" />
        <div className="msg">동기화 중…</div>
      </>
    ) : error ? (
      <div className="msg">목록을 불러오지 못했습니다. 새로고침으로 다시 시도하세요.</div>
    ) : syncedAt == null ? (
      <>
        <div className="msg">아직 게이트웨이와 동기화하지 않았습니다.</div>
        <button className="btn sm outline" onClick={() => void hardRefresh()}>
          새로고침
        </button>
      </>
    ) : filtered ? (
      <div className="msg">조건에 맞는 항목이 없습니다.</div>
    ) : (
      <div className="msg">등록된 {isConsumer ? "Consumer" : "Route"}가 없습니다.</div>
    );

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
          <span
            className="text-xs muted font-mono"
            title={
              syncedAt
                ? `마지막 동기화: ${new Date(syncedAt).toLocaleString("ko-KR")}`
                : "아직 게이트웨이와 동기화하지 않았습니다"
            }
            style={{ whiteSpace: "nowrap" }}
          >
            {syncLabel(syncedAt)}
          </span>
          <button
            className="icon-btn"
            title="게이트웨이에서 Route · Consumer 전체 목록을 다시 조회해 로컬 캐시를 갱신합니다"
            onClick={() => void hardRefresh()}
            disabled={loading || booting}
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
          {!isConsumer && (
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
          )}
          {!isConsumer && (
            // 검색어와 **다른 축**이라 검색창과 나란히 둔다 — 하나로 합치면 '포함' 과
            // '시작' 두 규칙이 한 칸에 섞인다.
            <div style={{ display: "flex", width: 200, height: 36 }}>
              <GroupCombo
                className="text-input font-mono"
                value={namePrefix}
                onChange={setNamePrefix}
                onCommit={setNamePrefix}
                options={prefixOptions}
                placeholder="name 접두사"
                ariaLabel="name 접두사로 필터"
                // 옆의 검색창 · Import 버튼과 같은 36px 로 맞춘다 (.text-input 기본은 40px).
                inputStyle={{ height: 36 }}
              />
            </div>
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
              placeholder={isConsumer ? "desc · username · key 검색" : "name · uri 검색"}
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

      {(chipKeys.length > 0 || release || prefixRelease) && (
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

          {/* 좌측 패널을 스크롤로 지나친 사용자가 목록이 왜 짧은지 알 수 없으면 안 된다. */}
          {release && <ReleaseChip {...release} />}
          {prefixRelease && <ReleaseChip {...prefixRelease} />}
        </div>
      )}

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
                <div className="state-block">{emptyState}</div>
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
