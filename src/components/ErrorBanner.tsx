/**
 * 빨간 에러 배너.
 *
 * 같은 20줄이 ListScreen · Dashboard · ImportScreen 에 복붙돼 있었다. 화면이 둘 더 늘어나는
 * 참에 한 곳으로 모은다.
 */

import type { AppError } from "../types";

export default function ErrorBanner({ error }: { error: AppError | null }) {
  if (!error) return null;

  return (
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
        <div className="text-sm" style={{ color: "var(--red-700)", opacity: 0.85, marginTop: 4 }}>
          {error.hint}
        </div>
      )}
    </div>
  );
}
