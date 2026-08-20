/**
 * 설정 — 개발 / 운영 게이트웨이의 Admin API 접속 정보.
 *
 * 디자인 대비 추가된 것은 '인증서 검증 건너뛰기' 토글 하나다(기본 OFF).
 * 토큰은 Windows 자격 증명 관리자에 저장되고 프런트로는 마스킹된 값만 내려오므로,
 * 입력란을 비워 두면 '기존 토큰 유지'로 동작한다.
 */

import { useEffect, useState } from "react";

import { useStore } from "../store";
import type { EnvConfigView, EnvKey, EnvPayload } from "../types";

const trackStyle = (on: boolean): React.CSSProperties => ({
  width: 44,
  height: 24,
  borderRadius: 1000,
  padding: 3,
  cursor: "pointer",
  transition: "background 120ms",
  flex: "0 0 auto",
  display: "flex",
  justifyContent: on ? "flex-end" : "flex-start",
  background: on ? "var(--purple-600)" : "var(--gray-300)",
});

const knobStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: "50%",
  background: "#fff",
  boxShadow: "var(--shadow-xs)",
};

const rowBoxStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "14px 16px",
  background: "var(--gray-25)",
  border: "1px solid var(--gray-200)",
  borderRadius: 8,
};

function EnvCard({ env, cfg }: { env: EnvKey; cfg: EnvConfigView }) {
  const saveSettings = useStore((s) => s.saveSettings);
  const testSettings = useStore((s) => s.testSettings);

  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl);
  const [noProxy, setNoProxy] = useState(cfg.noProxy);
  const [insecureTls, setInsecureTls] = useState(cfg.insecureTls);
  /** 빈 문자열 = 변경 없음 (저장된 토큰 유지) */
  const [token, setToken] = useState("");
  const [reveal, setReveal] = useState(false);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);

  // 저장 후 서버 상태가 갱신되면 로컬 입력값도 맞춰 준다.
  useEffect(() => {
    setBaseUrl(cfg.baseUrl);
    setNoProxy(cfg.noProxy);
    setInsecureTls(cfg.insecureTls);
    setToken("");
  }, [cfg.baseUrl, cfg.noProxy, cfg.insecureTls, cfg.hasToken]);

  const payload = (tokenOverride?: string | null): EnvPayload => ({
    baseUrl,
    noProxy,
    insecureTls,
    token: tokenOverride !== undefined ? tokenOverride : token.trim() === "" ? null : token,
  });

  const onTest = async () => {
    setBusy(true);
    setResult("호출 중…");
    const r = await testSettings(env, payload());
    setResult(r.text);
    setBusy(false);
  };

  const onSave = async () => {
    setBusy(true);
    const ok = await saveSettings(env, payload());
    if (ok) setResult("");
    setBusy(false);
  };

  const onClearToken = async () => {
    setBusy(true);
    await saveSettings(env, payload(""));
    setResult("");
    setBusy(false);
  };

  return (
    <div className="card-surface" style={{ padding: 24 }}>
      <div className="row between" style={{ marginBottom: 18 }}>
        <div className="row" style={{ gap: 10 }}>
          <h5 className="h5">{env === "dev" ? "개발 서버" : "운영 서버"}</h5>
          <span className={"badge " + (cfg.hasToken ? "success" : "warning")}>
            <span className="dot" />
            {cfg.hasToken ? "관리 가능" : "토큰 미설정"}
          </span>
        </div>
        <span className="text-xs muted font-mono">
          {env === "dev" ? "DEVELOPMENT" : "PRODUCTION"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <label className="field-label">
            Admin API baseUrl <span style={{ color: "var(--red-600)" }}>*</span>
          </label>
          <input
            className="text-input font-mono"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://gw.example.com:9180"
          />
          <div className="text-xs muted" style={{ marginTop: 6 }}>
            경로 <span className="font-mono">/apisix/admin</span> 은 자동으로 붙습니다.
          </div>
        </div>

        <div>
          <label className="field-label">
            관리 토큰 (X-API-KEY) <span style={{ color: "var(--red-600)" }}>*</span>
          </label>
          <input
            className="text-input font-mono"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type={reveal ? "text" : "password"}
            placeholder={cfg.hasToken ? cfg.tokenMasked : "관리 토큰을 입력하세요"}
          />
          <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
            <button className="btn sm outline" onClick={() => setReveal((v) => !v)}>
              {reveal ? "가리기" : "표시"}
            </button>
            {cfg.hasToken && (
              <button className="btn sm ghost" onClick={() => void onClearToken()} disabled={busy}>
                토큰 삭제
              </button>
            )}
            <span className="text-xs muted">
              {cfg.hasToken
                ? "토큰은 Windows 자격 증명 관리자에 보관됩니다. 비워 두면 기존 토큰이 유지됩니다."
                : "미입력 시 해당 환경은 관리할 수 없습니다."}
            </span>
          </div>
        </div>

        <div style={rowBoxStyle}>
          <div>
            <div style={{ font: "500 13px/18px var(--font-sans)", color: "var(--gray-900)" }}>
              프록시 강제 우회
            </div>
            <div className="text-xs muted">시스템 프록시를 타지 않고 직접 호출합니다.</div>
          </div>
          <div onClick={() => setNoProxy((v) => !v)} style={trackStyle(noProxy)}>
            <div style={knobStyle} />
          </div>
        </div>

        {!noProxy && (
          <div
            style={{
              padding: "10px 14px",
              background: "var(--yellow-50)",
              border: "1px solid var(--yellow-200)",
              borderRadius: 8,
              font: "400 12px/18px var(--font-sans)",
              color: "var(--yellow-800)",
              marginTop: -8,
            }}
          >
            끄면 Windows 시스템 프록시를 경유합니다. 사내 게이트웨이는 대개 프록시를 타면 연결되지
            않습니다.
          </div>
        )}

        <div style={rowBoxStyle}>
          <div>
            <div style={{ font: "500 13px/18px var(--font-sans)", color: "var(--gray-900)" }}>
              인증서 검증 건너뛰기
            </div>
            <div className="text-xs muted">사설·자체서명 인증서를 쓰는 게이트웨이용입니다.</div>
          </div>
          <div onClick={() => setInsecureTls((v) => !v)} style={trackStyle(insecureTls)}>
            <div style={knobStyle} />
          </div>
        </div>

        {insecureTls && (
          <div
            style={{
              padding: "10px 14px",
              background: "var(--yellow-50)",
              border: "1px solid var(--yellow-200)",
              borderRadius: 8,
              font: "400 12px/18px var(--font-sans)",
              color: "var(--yellow-800)",
              marginTop: -8,
            }}
          >
            서버 인증서를 검증하지 않습니다. 중간자 공격에 노출될 수 있으니 신뢰된 사내망에서만
            사용하세요. 가능하면 사내 CA 를 Windows 인증서 저장소에 설치하는 편이 안전합니다.
          </div>
        )}

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn md outline" onClick={() => void onTest()} disabled={busy}>
            연결 테스트
          </button>
          <button className="btn md solid-primary" onClick={() => void onSave()} disabled={busy}>
            저장
          </button>
          <span className="text-xs font-mono selectable" style={{ color: "var(--gray-500)" }}>
            {result}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function Settings() {
  const settings = useStore((s) => s.settings);

  const callRules = [
    { label: "인증 헤더", value: "X-API-KEY: <관리 토큰>" },
    { label: "프록시 우회", value: "reqwest::ClientBuilder::no_proxy()" },
    { label: "요청 경로", value: "{baseUrl}/apisix/admin/{resource}" },
  ];

  return (
    <div data-screen-label="설정" style={{ padding: "24px 28px 56px", maxWidth: 1120 }}>
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div>
          <h2 className="page-title" style={{ fontSize: 24, lineHeight: "32px" }}>
            설정
          </h2>
          <p className="page-sub">
            개발 · 운영 게이트웨이의 Admin API 접속 정보를 각각 등록합니다. 토큰이 없는 환경은
            관리할 수 없습니다.
          </p>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        {settings && <EnvCard env="dev" cfg={settings.dev} />}
        {settings && <EnvCard env="prod" cfg={settings.prod} />}
      </div>

      <div className="card-surface" style={{ padding: "22px 24px", marginTop: 16 }}>
        <h5 className="h5" style={{ marginBottom: 10 }}>
          호출 규칙
        </h5>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
          {callRules.map((c) => (
            <div
              key={c.label}
              style={{
                padding: "14px 16px",
                background: "var(--gray-25)",
                border: "1px solid var(--gray-200)",
                borderRadius: 8,
              }}
            >
              <div
                style={{
                  font: "500 12px/16px var(--font-sans)",
                  color: "var(--gray-700)",
                  marginBottom: 6,
                }}
              >
                {c.label}
              </div>
              <div
                className="font-mono selectable"
                style={{
                  fontSize: 11.5,
                  lineHeight: "18px",
                  color: "var(--gray-600)",
                  wordBreak: "break-all",
                }}
              >
                {c.value}
              </div>
            </div>
          ))}
        </div>
        <div className="text-xs muted" style={{ marginTop: 12, lineHeight: "18px" }}>
          모든 게이트웨이 호출은 앱 백엔드(Rust)에서 나갑니다. 웹뷰는 외부로 직접 통신하지 않도록
          CSP 로 차단되어 있어, 시스템 프록시가 설정돼 있어도 우회 경로가 생기지 않습니다.
        </div>
      </div>
    </div>
  );
}
