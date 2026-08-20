/**
 * 디자인의 38px 커스텀 다크 타이틀바.
 *
 * 창은 `decorations: false` 이므로 드래그·최소화·최대화·닫기를 직접 처리한다.
 * Snap Layouts(최대화 버튼 호버 시 뜨는 Windows 11 레이아웃 팝업)는 Rust 쪽
 * `WM_NCHITTEST → HTMAXBUTTON` 처리로 동작하고, 버튼 하이라이트는 그때
 * Rust 가 보내주는 `window://max-button-hover` 이벤트로 맞춘다.
 */

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { segStyle } from "../lib/design";
import { selectLocked, useStore } from "../store";

const EVT_MAX_HOVER = "window://max-button-hover";

export default function TitleBar() {
  const env = useStore((s) => s.env);
  const setEnv = useStore((s) => s.setEnv);
  const settings = useStore((s) => s.settings);
  const maxHover = useStore((s) => s.maxHover);
  const setMaxHover = useStore((s) => s.setMaxHover);
  const locked = useStore(selectLocked);

  useEffect(() => {
    const un = listen<boolean>(EVT_MAX_HOVER, (e) => setMaxHover(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, [setMaxHover]);

  const cfg = settings?.[env];
  const connLabel = locked ? "미설정" : (cfg?.baseUrl ?? "").replace(/^https?:\/\//, "");

  const win = getCurrentWindow();

  return (
    <div
      data-tauri-drag-region
      className="titlebar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "0 0 0 12px",
        background: "var(--gray-900)",
        color: "#fff",
        userSelect: "none",
      }}
    >
      {/* 브랜드 — pointerEvents:none 으로 두면 클릭이 드래그 영역으로 통과한다 */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, pointerEvents: "none" }}>
        <div
          style={{
            width: 16,
            height: 16,
            borderRadius: 4,
            background: "var(--purple-500)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="11"
            height="11"
            fill="none"
            stroke="#fff"
            strokeWidth="2.4"
            strokeLinecap="round"
          >
            <path d="M4 12h16M12 4v16" />
          </svg>
        </div>
        <span
          className="tb-title"
          style={{ font: "600 12px/16px var(--font-sans)", letterSpacing: ".01em" }}
        >
          API Gateway 관리자
        </span>
        <span style={{ font: "400 11px/16px var(--font-mono)", color: "var(--gray-500)" }}>
          {`v${__APP_VERSION__}`}
        </span>
      </div>

      {/* 개발 / 운영 전환 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: 3,
          background: "rgba(255,255,255,.08)",
          borderRadius: 6,
        }}
      >
        <div onClick={() => setEnv("dev")} style={segStyle(env === "dev")}>
          개발
        </div>
        <div onClick={() => setEnv("prod")} style={segStyle(env === "prod")}>
          운영
        </div>
      </div>

      {/* 연결 상태 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          font: "400 11px/16px var(--font-mono)",
          color: "var(--gray-400)",
          pointerEvents: "none",
          minWidth: 0,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            flex: "0 0 auto",
            background: locked ? "var(--yellow-400)" : "var(--green-400)",
          }}
        />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {connLabel}
        </span>
      </div>

      {/* 드래그 여백 */}
      <div data-tauri-drag-region style={{ flex: 1, height: 38 }} />

      {/* 창 컨트롤 */}
      <div style={{ display: "flex", alignItems: "stretch", height: 38 }}>
        <div className="wc" title="최소화" onClick={() => void win.minimize()}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 12h16" />
          </svg>
        </div>
        <div
          className={"wc" + (maxHover ? " nc-hover" : "")}
          title="최대화"
          onClick={() => void win.toggleMaximize()}
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="4" width="16" height="16" rx="1" />
          </svg>
        </div>
        <div className="wc close" title="닫기" onClick={() => void win.close()}>
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </div>
      </div>
    </div>
  );
}
