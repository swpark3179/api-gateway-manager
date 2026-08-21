/**
 * 232px 사이드 패널 — 섹션별 요약 항목(클릭 시 목록 필터) + 하단 ENDPOINT 블록.
 *
 * Route 섹션의 패널은 **컨슈머 접근** 목록이다. 상태(전체/활성/비활성)는 상단 토글 칩이
 * 이미 제공하므로 여기서 되풀이하지 않고, 대신 "이 컨슈머가 쓸 수 있는 API" 를 고르게 한다.
 * 판정은 컨슈머의 auth-groups 와 라우트의 allowed_groups 교집합이고 SQLite 조인으로 푼다.
 */

import { useMemo, useState } from "react";

import { consumerGroupBuckets, useStore } from "../store";

/** 컨슈머가 이보다 많으면 패널 안에 찾기 입력칸을 띄운다. 수백 행은 스크롤로 감당이 안 된다. */
const FILTER_THRESHOLD = 12;

interface Row {
  label: string;
  count: string | number;
  /** 클릭 시 적용할 chip 필터. null 이면 클릭 불가 항목. */
  chip: string | null;
  /** Route 섹션 전용 — 클릭 시 선택할 컨슈머 (null = 필터 해제) */
  consumer?: string | null;
  /** 접근 가능한 라우트가 0건인 컨슈머는 흐리게 */
  dim?: boolean;
}

export default function SidePanel() {
  const section = useStore((s) => s.section);
  const env = useStore((s) => s.env);
  const chip = useStore((s) => s.chip);
  const view = useStore((s) => s.view);
  const routeConsumer = useStore((s) => s.routeConsumer);
  // 패널 숫자는 캐시가 따로 돌려준 고정 집계다 — routeCounts 를 쓰면 컨슈머를 고른 순간
  // '전체' 행이 그 컨슈머의 건수를 표시하게 되어 순환한다 (store.ts 모듈 주석 참조).
  const access = useStore((s) => s.access);
  const consumers = useStore((s) => s.consumers);
  const services = useStore((s) => s.services);
  const upstreams = useStore((s) => s.upstreams);
  const dash = useStore((s) => s.dash);
  const settings = useStore((s) => s.settings);
  const setChip = useStore((s) => s.setChip);
  const setRouteConsumer = useStore((s) => s.setRouteConsumer);

  const [needle, setNeedle] = useState("");

  const isRoutes = section === "routes";

  const { title, rows } = useMemo<{ title: string; rows: Row[] }>(() => {
    switch (section) {
      case "routes": {
        const counts = new Map(access?.items.map((i) => [i.username, i.count]));
        const n = needle.trim().toLowerCase();
        const list = consumers
          .filter((c) => !n || c.username.toLowerCase().includes(n))
          .map((c) => ({ username: c.username, count: counts.get(c.username) ?? 0 }))
          // 많이 쓰는 컨슈머를 위로, 같으면 이름순 (consumerGroupBuckets 와 같은 관례)
          .sort((a, b) => b.count - a.count || a.username.localeCompare(b.username));

        return {
          title: "CONSUMER 접근",
          rows: [
            { label: "전체 Route", count: access?.all ?? 0, chip: null, consumer: null },
            ...list.map((c) => ({
              label: c.username,
              count: c.count,
              chip: null,
              consumer: c.username,
              dim: c.count === 0,
            })),
            // 어떤 컨슈머로도 걸리지 않는 라우트를 화면에서 사라지게 두지 않는다.
            ...(access && access.ungrouped > 0
              ? [{ label: "그룹 제한 없음", count: access.ungrouped, chip: null }]
              : []),
          ],
        };
      }
      case "consumers":
        // 고정 구분(제휴사/내부 시스템) 대신, 실제 데이터에 존재하는 auth-groups 값으로 나눈다.
        return {
          title: "권한그룹",
          rows: [
            { label: "전체", count: consumers.length, chip: "all" },
            ...consumerGroupBuckets(consumers).map((b) => ({
              label: b.label,
              count: b.count,
              chip: b.key,
            })),
          ],
        };
      case "upstreams": {
        // 노드가 하나도 없는 upstream 은 게이트웨이가 트래픽을 흘릴 데가 없다는 뜻이라
        // 따로 세어 준다 — 목록에서는 눈에 잘 띄지 않는다.
        const empty = upstreams.filter((u) => u.nodes.length === 0).length;
        return {
          title: "UPSTREAM",
          rows: [
            { label: "전체", count: upstreams.length, chip: null },
            { label: "노드 미등록", count: empty, chip: null, dim: empty === 0 },
          ],
        };
      }
      case "services": {
        // spec_url 이 빈 service 는 Import 화면에서 파일을 첨부해야만 비교할 수 있다.
        const noSpec = services.filter((x) => !x.specUrl.trim()).length;
        return {
          title: "SERVICE",
          rows: [
            { label: "전체", count: services.length, chip: null },
            { label: "spec_url 미등록", count: noSpec, chip: null, dim: noSpec === 0 },
          ],
        };
      }
      case "settings":
        return {
          title: "ENVIRONMENT",
          rows: [
            { label: "개발 서버", count: settings?.dev.hasToken ? "연결" : "미설정", chip: null },
            { label: "운영 서버", count: settings?.prod.hasToken ? "연결" : "미설정", chip: null },
          ],
        };
      default:
        return {
          title: "개요",
          rows: [
            {
              label: "현황 요약",
              count: (dash?.overview.routes ?? 0) + (dash?.overview.consumers ?? 0),
              chip: null,
            },
          ],
        };
    }
  }, [section, access, consumers, services, upstreams, settings, dash, needle]);

  const cfg = settings?.[env];
  const hasToken = !!cfg?.hasToken;
  const endpoint = cfg?.adminBase || "—";

  return (
    <div
      style={{
        background: "#fff",
        borderRight: "1px solid var(--gray-200)",
        display: "flex",
        flexDirection: "column",
        padding: "16px 12px",
        minHeight: 0,
        overflow: "auto",
      }}
    >
      <div
        style={{
          font: "700 10px/12px var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: ".06em",
          color: "var(--gray-400)",
          padding: "2px 10px 10px",
        }}
      >
        {title}
      </div>

      {isRoutes && consumers.length > FILTER_THRESHOLD && (
        <input
          className="text-input"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          placeholder="consumer 찾기"
          style={{ height: 30, fontSize: 12, margin: "0 4px 8px", width: "calc(100% - 8px)" }}
        />
      )}

      {rows.map((p, i) => {
        // Route 섹션은 컨슈머 축, 나머지는 chip 축으로 선택 상태를 판단한다.
        const on = isRoutes
          ? p.consumer !== undefined && view === "list" && routeConsumer === p.consumer
          : p.chip
            ? chip === p.chip && view === "list"
            : i === 0;
        const clickable = isRoutes ? p.consumer !== undefined : !!p.chip;

        return (
          <div
            key={p.label}
            className={"lnb-item" + (on ? " on" : "")}
            onClick={() => {
              if (isRoutes) {
                if (p.consumer !== undefined) setRouteConsumer(p.consumer);
              } else if (p.chip) {
                setChip(p.chip);
              }
            }}
            style={{
              ...(clickable ? undefined : { cursor: "default" }),
              ...(p.dim && !on ? { opacity: 0.6 } : undefined),
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
              title={p.label}
            >
              {p.label}
            </span>
            <span className="count">{p.count}</span>
          </div>
        );
      })}

      {isRoutes && consumers.length === 0 && (
        <div className="text-xs muted" style={{ padding: "8px 10px" }}>
          등록된 Consumer 가 없습니다.
        </div>
      )}

      <div style={{ flex: 1, minHeight: 16 }} />

      <div
        style={{
          borderTop: "1px solid var(--gray-200)",
          paddingTop: 12,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div
          style={{
            font: "700 10px/12px var(--font-mono)",
            letterSpacing: ".06em",
            color: "var(--gray-400)",
            padding: "0 10px 2px",
          }}
        >
          ENDPOINT
        </div>
        <div
          className="selectable"
          style={{
            font: "400 11px/16px var(--font-mono)",
            color: "var(--gray-600)",
            padding: "0 10px",
            wordBreak: "break-all",
          }}
        >
          {endpoint}
        </div>
        <div style={{ padding: "6px 10px 0" }}>
          <span className={"badge " + (hasToken ? "success" : "warning")}>
            <span className="dot" />
            {hasToken ? "관리 토큰 등록됨" : "관리 토큰 미설정"}
          </span>
        </div>
      </div>
    </div>
  );
}
