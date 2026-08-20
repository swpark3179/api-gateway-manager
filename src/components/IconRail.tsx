/** 좌측 64px 아이콘 레일 — 대시보드 / Route / Consumer / 설정 */

import { RAIL, RAIL_ICONS, railStyle } from "../lib/design";
import { useStore } from "../store";

export default function IconRail() {
  const section = useStore((s) => s.section);
  const go = useStore((s) => s.go);

  return (
    <div
      style={{
        background: "#fff",
        borderRight: "1px solid var(--gray-200)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        padding: "10px 0",
      }}
    >
      {RAIL.map((it) => (
        <div
          key={it.key}
          onClick={() => go(it.key)}
          title={it.label}
          style={railStyle(section === it.key)}
        >
          <svg
            viewBox="0 0 24 24"
            width="19"
            height="19"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={RAIL_ICONS[it.key]} />
          </svg>
          <span style={{ font: "500 9px/12px var(--font-sans)", letterSpacing: ".01em" }}>
            {it.label}
          </span>
        </div>
      ))}
    </div>
  );
}
