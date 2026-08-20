/**
 * 232px 사이드 패널 — 섹션별 요약 항목(클릭 시 목록 필터) + 하단 ENDPOINT 블록.
 * 디자인의 panelDef / panelChipKeys 규칙을 그대로 따른다.
 */

import { useMemo } from "react";

import { consumerGroupBuckets, useStore } from "../store";

interface Row {
  label: string;
  count: string | number;
  /** 클릭 시 적용할 chip 필터. null 이면 클릭 불가 항목. */
  chip: string | null;
}

export default function SidePanel() {
  const section = useStore((s) => s.section);
  const env = useStore((s) => s.env);
  const chip = useStore((s) => s.chip);
  const view = useStore((s) => s.view);
  const routes = useStore((s) => s.routes);
  const consumers = useStore((s) => s.consumers);
  const dash = useStore((s) => s.dash);
  const settings = useStore((s) => s.settings);
  const setChip = useStore((s) => s.setChip);

  const { title, rows } = useMemo<{ title: string; rows: Row[] }>(() => {
    switch (section) {
      case "routes":
        return {
          title: "ROUTES",
          rows: [
            { label: "전체", count: routes.length, chip: "all" },
            {
              label: "활성 (status 1)",
              count: routes.filter((r) => r.status === 1).length,
              chip: "on",
            },
            {
              label: "비활성 (status 0)",
              count: routes.filter((r) => r.status !== 1).length,
              chip: "off",
            },
          ],
        };
      case "consumers":
        // 고정 구분(제휴사/내부 시스템) 대신, 실제 데이터에 존재하는 auth-groups 값으로 나눈다.
        return {
          title: "AUTH-GROUPS",
          rows: [
            { label: "전체", count: consumers.length, chip: "all" },
            ...consumerGroupBuckets(consumers).map((b) => ({
              label: b.label,
              count: b.count,
              chip: b.key,
            })),
          ],
        };
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
  }, [section, routes, consumers, settings, dash]);

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

      {rows.map((p, i) => {
        const on = p.chip ? chip === p.chip && view === "list" : i === 0;
        return (
          <div
            key={p.label}
            className={"lnb-item" + (on ? " on" : "")}
            onClick={() => p.chip && setChip(p.chip)}
            style={p.chip ? undefined : { cursor: "default" }}
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
