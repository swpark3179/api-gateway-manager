/**
 * 부트스트랩 진행 표시 — 게이트웨이 전체 조회가 끝날 때까지의 단계를 보여준다.
 *
 * 두 변형이 있다.
 *   · `overlay` — 기동 · 환경 전환. 아직 보여줄 목록이 없으므로 가려도 잃을 것이 없다.
 *   · `bar`     — 상단 새로고침 버튼. 보고 있던 목록을 네 번의 왕복 동안 가리면 안 되므로
 *                 얇은 막대만 띄운다 (버튼 자체도 disabled 로 진행 중임을 알린다).
 */

import { useStore } from "../store";

export default function BootProgress() {
  const booting = useStore((s) => s.booting);
  const variant = useStore((s) => s.bootVariant);
  const step = useStore((s) => s.bootStep);
  const total = useStore((s) => s.bootTotal);
  const label = useStore((s) => s.bootLabel);

  if (!booting) return null;

  const pct = total > 0 ? Math.round((step / total) * 100) : 0;

  const bar = (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={step}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={label}
    >
      <div className="bar" style={{ width: `${pct}%` }} />
    </div>
  );

  if (variant === "bar") {
    return (
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 30 }}>{bar}</div>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        background: "var(--bg-canvas)",
        display: "grid",
        placeItems: "center",
      }}
    >
      <div style={{ width: 320, display: "flex", flexDirection: "column", gap: 10 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 12,
          }}
        >
          <span style={{ font: "500 14px/20px var(--font-sans)", color: "var(--gray-900)" }}>
            {label}
          </span>
          <span className="font-mono" style={{ fontSize: 12, color: "var(--gray-500)" }}>
            {Math.min(step + 1, total)} / {total}
          </span>
        </div>
        {bar}
        <div className="text-sm muted">게이트웨이에서 전체 목록을 받아 로컬 캐시를 채웁니다.</div>
      </div>
    </div>
  );
}
