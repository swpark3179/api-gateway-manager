/**
 * 대시보드.
 *
 * 디자인의 목업 수치를 전부 실측값으로 바꿨다:
 *   · KPI            → 각 리소스 목록 건수
 *   · 최근 관리 API 호출 → 이 앱이 수행한 호출 이력 (Rust history.rs)
 *   · APISIX 버전     → 응답의 `Server: APISIX/x.y.z` 헤더
 *   · 응답 시간        → 실제 왕복 시간
 *   · etcd 행         → Admin API 로 알 수 없어 Service 실측 건수로 대체
 */

import { useStore } from "../store";

interface Kpi {
  label: string;
  value: number | string;
  delta: string;
  dir?: "up" | "down";
}

export default function Dashboard() {
  const env = useStore((s) => s.env);
  const dash = useStore((s) => s.dash);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  const refresh = useStore((s) => s.refresh);
  const newRouteFromDash = useStore((s) => s.newRouteFromDash);

  const envLabel = env === "dev" ? "개발" : "운영";
  const o = dash?.overview;

  const kpis: Kpi[] = [
    {
      label: "Route",
      value: o?.routes ?? "—",
      delta: o ? `활성 ${o.routesActive} · 비활성 ${o.routesInactive}` : "—",
      dir: "up",
    },
    {
      label: "Consumer",
      value: o?.consumers ?? "—",
      delta: o ? `jwt-auth ${o.consumersJwt}/${o.consumers} 적용` : "—",
      dir: "up",
    },
    { label: "Service", value: o?.services ?? "—", delta: "조회 전용" },
    { label: "Upstream", value: o?.upstreams ?? "—", delta: "조회 전용" },
  ];

  const health: Array<{ label: string; value: string }> = [
    { label: "Admin API", value: dash?.baseUrl || "—" },
    // 라벨이 `X-API-KEY` 가 아닌 이유: 헤더로는 관리키 전체가 나가지만(Rust
    // `config::api_key`), 여기 뿌리는 마스킹 값은 secret 을 가리려고 `$` 뒤만 자른다
    // (`config::mask`). 같은 이름을 붙이면 두 값이 같아 보인다.
    { label: "관리키", value: dash?.tokenMasked || "미설정" },
    { label: "APISIX 버전", value: o?.version ?? "—" },
    { label: "Service", value: o ? `${o.services}개 · Upstream ${o.upstreams}개` : "—" },
    { label: "응답 시간", value: o?.latencyMs != null ? `${o.latencyMs}ms` : "—" },
  ];

  return (
    <div data-screen-label="대시보드" style={{ padding: "24px 28px 48px", maxWidth: 1180 }}>
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div>
          <h2 className="page-title" style={{ fontSize: 24, lineHeight: "32px" }}>
            대시보드
          </h2>
          <p className="page-sub">
            {envLabel} 게이트웨이 ·{" "}
            <span className="font-mono selectable" style={{ fontSize: 12 }}>
              {dash?.adminBase || "—"}
            </span>
          </p>
        </div>
        <div className="page-actions">
          <button className="btn md outline" onClick={() => void refresh()} disabled={loading}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" />
            </svg>
            {loading ? "불러오는 중…" : "새로고침"}
          </button>
          <button className="btn md solid-primary" onClick={() => void newRouteFromDash()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            신규 Route 등록
          </button>
        </div>
      </div>

      {error && (
        <div
          className="card-surface"
          style={{
            padding: "16px 20px",
            marginBottom: 20,
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
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4,1fr)",
          gap: 16,
          marginBottom: 20,
        }}
      >
        {kpis.map((k) => (
          <div key={k.label} className="card-surface kpi-card">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{k.value}</div>
            <div className={"kpi-delta" + (k.dir ? " " + k.dir : "")}>{k.delta}</div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.35fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div className="card-surface" style={{ padding: "20px 24px" }}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <h5 className="h5">최근 관리 API 호출</h5>
            <span className="text-xs muted font-mono">{envLabel}</span>
          </div>

          {(dash?.activity ?? []).map((a, i) => (
            <div className="act" key={`${a.path}-${i}`}>
              <span
                className={"badge " + a.cls}
                style={{ marginTop: 2, minWidth: 52, justifyContent: "center" }}
              >
                {a.verb}
              </span>
              <div className="body">
                <b>{a.target}</b> — {a.note}
                <div
                  className="font-mono"
                  style={{ fontSize: 11, color: "var(--gray-400)", marginTop: 2 }}
                >
                  {a.path}
                </div>
              </div>
              <span className="when">{a.when}</span>
            </div>
          ))}

          {(dash?.activity ?? []).length === 0 && (
            <div className="state-block" style={{ padding: "32px 12px" }}>
              <div className="msg">아직 기록된 호출이 없습니다.</div>
            </div>
          )}
        </div>

        <div className="card-surface" style={{ padding: "20px 24px" }}>
          <h5 className="h5" style={{ marginBottom: 14 }}>
            연결 상태
          </h5>
          {health.map((h) => (
            <div
              key={h.label}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "9px 0",
                borderBottom: "1px dashed var(--gray-100)",
              }}
            >
              <span className="text-sm muted">{h.label}</span>
              <span
                className="font-mono selectable"
                style={{
                  fontSize: 12,
                  color: "var(--gray-800)",
                  textAlign: "right",
                  wordBreak: "break-all",
                }}
              >
                {h.value}
              </span>
            </div>
          ))}

          {/* 프록시 우회 · 인증서 검증 건너뛰기는 고정값이다 (`config.rs` 모듈 주석).
              예전에는 토글 상태에 따라 경고/확인 배너가 갈렸지만, 이제 껐다 켤 수 없으므로
              무엇이 적용돼 있는지만 한 번 알려 준다. 만료되지 않는 경고 배너는 곧 배경이 된다. */}
          <div
            style={{
              marginTop: 14,
              padding: 12,
              background: "var(--purple-25)",
              border: "1px solid var(--purple-100)",
              borderRadius: 8,
            }}
          >
            <div
              className="text-xs"
              style={{ color: "var(--purple-800)", fontWeight: 500, marginBottom: 4 }}
            >
              프록시 우회 · 인증서 검증 건너뛰기 적용됨
            </div>
            <div
              className="font-mono"
              style={{ fontSize: 11, lineHeight: "16px", color: "var(--gray-600)" }}
            >
              reqwest.no_proxy() · danger_accept_invalid_certs(true)
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
