/**
 * 좌측 64px 아이콘 레일 — 대시보드 / Route / Consumer / Upstream / Service / 설정.
 *
 * 전체 관리자가 아닌 관리 토큰이면 Upstream · Service 를 뺀다. 두 리소스는 게이트웨이
 * 전체에 걸쳐 있어 특정 service 만 맡은 토큰이 건드릴 대상이 아니다
 * (`store.ts` 의 `ADMIN_ONLY` 주석). 개발과 운영의 권한이 다를 수 있으므로 환경을 바꾸면
 * 이 목록도 바뀐다 — 그래서 `setEnv` 가 홈으로 되돌린다.
 */

import { RAIL, RAIL_ICONS, railStyle } from "../lib/design";
import { ADMIN_ONLY, selectIsAdmin, useStore } from "../store";

export default function IconRail() {
  const section = useStore((s) => s.section);
  const go = useStore((s) => s.go);
  const isAdmin = useStore(selectIsAdmin);
  const items = isAdmin ? RAIL : RAIL.filter((it) => !ADMIN_ONLY.includes(it.key));

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
      {items.map((it) => (
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
