/** 하단 중앙 토스트 — 디자인 원본 그대로. */

import { useStore } from "../store";

export default function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;

  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        bottom: 28,
        transform: "translateX(-50%)",
        zIndex: 60,
        animation: "toastIn 200ms cubic-bezier(.4,0,.2,1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 18px",
          background: "var(--gray-900)",
          color: "#fff",
          borderRadius: 8,
          boxShadow: "var(--shadow-lg)",
          font: "500 13px/18px var(--font-sans)",
          maxWidth: "70vw",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="var(--green-400)"
          strokeWidth="2.4"
          strokeLinecap="round"
          style={{ flex: "0 0 auto" }}
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
        <span>{toast}</span>
      </div>
    </div>
  );
}
