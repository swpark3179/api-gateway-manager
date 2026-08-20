/**
 * JWT 토큰 탭 (Consumer 상세 전용).
 * 서명은 Rust 의 `jwt_sign` 커맨드가 수행한다 — HS256, payload `{key, nbf, exp}`.
 */

import { useStore } from "../../store";

export default function JwtTab() {
  const form = useStore((s) => s.form);
  const jwt = useStore((s) => s.jwt);
  const signJwt = useStore((s) => s.signJwt);
  const copyJwt = useStore((s) => s.copyJwt);

  if (!form || form.kind !== "consumer") return null;

  const cardStyle: React.CSSProperties = {
    padding: "12px 14px",
    background: "var(--gray-25)",
    border: "1px solid var(--gray-200)",
    borderRadius: 8,
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
      <div className="card-surface" style={{ padding: 24 }}>
        <div className="row between" style={{ marginBottom: 14 }}>
          <div className="row" style={{ gap: 10 }}>
            <h5 className="h5">발급 토큰</h5>
            <span className="badge primary font-mono">{jwt?.alg ?? "HS256"}</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm outline" onClick={() => void signJwt()}>
              재발급
            </button>
            <button className="btn sm solid-primary" onClick={() => void copyJwt()} disabled={!jwt}>
              복사
            </button>
          </div>
        </div>

        <div
          className="selectable"
          style={{
            padding: "14px 16px",
            background: "var(--gray-900)",
            borderRadius: 8,
            font: "400 12px/20px var(--font-mono)",
            color: jwt ? "var(--green-300)" : "var(--gray-400)",
            wordBreak: "break-all",
          }}
        >
          {jwt?.token ?? "토큰을 생성하려면 key · secret을 입력하세요."}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3,1fr)",
            gap: 12,
            marginTop: 16,
          }}
        >
          <div style={cardStyle}>
            <div className="text-xs muted">nbf</div>
            <div className="font-mono" style={{ fontSize: 13, color: "var(--gray-900)" }}>
              {jwt?.nbf ?? "—"}
            </div>
            <div className="text-xs muted font-mono">{jwt?.nbfHuman ?? ""}</div>
          </div>

          <div style={cardStyle}>
            <div className="text-xs muted">exp</div>
            <div className="font-mono" style={{ fontSize: 13, color: "var(--gray-900)" }}>
              {jwt?.exp ?? "—"}
            </div>
            <div className="text-xs muted font-mono">{jwt?.expHuman ?? ""}</div>
          </div>

          <div style={cardStyle}>
            <div className="text-xs muted">key</div>
            <div
              className="font-mono"
              style={{ fontSize: 13, color: "var(--gray-900)", wordBreak: "break-all" }}
            >
              {form.key || "—"}
            </div>
          </div>
        </div>
      </div>

      <div className="card-surface" style={{ padding: 24 }}>
        <h5 className="h5" style={{ marginBottom: 12 }}>
          payload
        </h5>
        <pre
          className="selectable"
          style={{
            margin: 0,
            padding: "14px 16px",
            background: "var(--gray-25)",
            border: "1px solid var(--gray-200)",
            borderRadius: 8,
            font: "400 12.5px/20px var(--font-mono)",
            color: "var(--gray-800)",
            overflow: "auto",
          }}
        >
          {jwt?.payload ?? "{}"}
        </pre>
        <div
          style={{
            marginTop: 12,
            padding: "12px 14px",
            background: "var(--blue-50)",
            border: "1px solid var(--blue-200)",
            borderRadius: 8,
            font: "400 12px/18px var(--font-sans)",
            color: "var(--blue-800)",
          }}
        >
          호출 시 <span className="font-mono">Authorization: Bearer &lt;token&gt;</span> 형태로
          전달하며, secret은 게이트웨이에만 보관됩니다.
        </div>
      </div>
    </div>
  );
}
