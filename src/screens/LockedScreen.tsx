/** 현재 환경에 관리 토큰이 없을 때 뜨는 잠금 화면 — 디자인 원본 그대로. */

import { useStore } from "../store";

export default function LockedScreen() {
  const env = useStore((s) => s.env);
  const go = useStore((s) => s.go);

  return (
    <div
      data-screen-label="잠금"
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 48,
      }}
    >
      <div className="card-surface" style={{ maxWidth: 520, padding: 32, textAlign: "center" }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 1000,
            background: "var(--yellow-50)",
            color: "var(--yellow-700)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 16px",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="21"
            height="21"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <rect x="4" y="10" width="16" height="10" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
        </div>
        <h4 className="h4" style={{ marginBottom: 8 }}>
          {env === "dev" ? "개발" : "운영"} 서버는 관리 불가 상태입니다
        </h4>
        <p className="text-md muted" style={{ margin: "0 0 20px" }}>
          관리 토큰이 등록되지 않은 환경은 조회·변경할 수 없습니다. 설정 화면에서 baseUrl과 관리
          토큰을 입력하세요.
        </p>
        <button className="btn md solid-primary" onClick={() => go("settings")}>
          설정으로 이동
        </button>
      </div>
    </div>
  );
}
