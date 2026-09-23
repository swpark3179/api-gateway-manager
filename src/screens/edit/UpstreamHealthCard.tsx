/**
 * Upstream 상세의 "현재 상태" 카드 — 게이트웨이 헬스체커가 판정한 노드 상태.
 *
 * APISIX Control API `GET /v1/healthcheck/upstreams/{id}` 를 부른다 (Rust `upstreams::health`).
 * Admin API 가 아니라서 관리키를 보내지 않고, 주소는 설정 화면의 `Control API 주소` 다
 * (비우면 baseUrl 의 호스트 + 9090).
 *
 * **저장된 설정 기준이다.** 폼에서 고친 checks 는 저장해야 게이트웨이가 쓴다 — 저장 전 확인은
 * 헬스체크 카드의 `노드 점검` 이 한다. 신규 등록 화면에는 조회할 upstream 이 없어 그리지 않는다.
 *
 * 헬스체커가 없다는 답(404)은 에러가 아니다: APISIX 는 이 upstream 으로 요청이 처음 흘러들 때
 * 체커를 만든다. 그 사실을 빨갛게 세우면 멀쩡한 설정을 의심하게 되므로 안내로 보여 준다.
 */

import { useState } from "react";

import { checksLabel, counterText, healthTone, isUp } from "../../lib/checks";
import { useStore } from "../../store";
import type { AppError, HealthReport } from "../../types";

export default function UpstreamHealthCard() {
  const form = useStore((s) => s.form);
  const upstreams = useStore((s) => s.upstreams);
  const cfg = useStore((s) => s.settings?.[s.env] ?? null);
  const checkUpstreamHealth = useStore((s) => s.checkUpstreamHealth);

  const [result, setResult] = useState<{ at: Date; report: HealthReport } | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);

  if (!form || form.kind !== "upstream" || !form.id) return null;
  const id = form.id;
  const saved = checksLabel(upstreams.find((u) => u.id === id)?.checks);
  const base = (cfg?.controlUrl.trim() || cfg?.controlDefault || "").replace(/\/+$/, "");

  const onCheck = async () => {
    setBusy(true);
    setError(null);
    const r = await checkUpstreamHealth(id);
    if (r.ok) {
      setResult({ at: new Date(), report: r.value });
    } else {
      setResult(null);
      setError(r.error);
    }
    setBusy(false);
  };

  const checker = result?.report.checker ?? null;
  const up = checker ? checker.nodes.filter(isUp).length : 0;

  return (
    <div className="card-surface" style={{ padding: 24 }}>
      <div
        style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}
      >
        <div>
          <h5 className="h5">현재 상태</h5>
          <p className="text-sm muted" style={{ margin: "4px 0 0" }}>
            게이트웨이의 헬스체커가 판정한 노드 상태입니다.{" "}
            {saved ? (
              <>
                저장된 설정 <span className="font-mono">{saved}</span> 기준이며, 폼에서 고친 값은
                저장한 뒤에 반영됩니다.
              </>
            ) : (
              <>
                게이트웨이에 저장된 헬스체크가 없어 조회할 상태가 없습니다 — 위에서 헬스체크를
                켜고 저장하세요.
              </>
            )}
          </p>
        </div>
        {saved && (
          <button
            className="btn sm outline"
            onClick={() => void onCheck()}
            disabled={busy}
            style={{ flex: "0 0 auto" }}
          >
            {busy ? "조회 중…" : "상태 조회"}
          </button>
        )}
      </div>

      {error && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 14px",
            background: "var(--red-50)",
            border: "1px solid var(--red-200)",
            borderRadius: 8,
          }}
        >
          <div className="text-sm" style={{ color: "var(--red-700)", fontWeight: 500 }}>
            {error.message}
          </div>
          {error.hint && (
            <div className="text-xs" style={{ color: "var(--red-700)", marginTop: 4 }}>
              {error.hint}
            </div>
          )}
        </div>
      )}

      {result && !checker && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 14px",
            background: "var(--blue-50)",
            border: "1px solid var(--blue-200)",
            borderRadius: 8,
            font: "400 12px/18px var(--font-sans)",
            color: "var(--blue-800)",
          }}
        >
          헬스체커가 아직 없습니다 (<span className="font-mono">{result.report.message}</span>).
          APISIX 는 이 upstream 으로 요청이 처음 들어올 때 헬스체커를 만듭니다 — 방금 저장했거나
          트래픽이 없었다면 호출을 한 번 보낸 뒤 다시 조회하세요.
        </div>
      )}

      {checker && (
        <div style={{ marginTop: 14 }}>
          <div className="text-xs" style={{ color: "var(--gray-700)", marginBottom: 8 }}>
            노드 {checker.nodes.length}개 중 <b>{up}개</b>가 요청을 받고 있습니다
            {checker.kind ? (
              <>
                {" "}
                · 검사 방식 <span className="font-mono">{checker.kind}</span>
              </>
            ) : null}
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {checker.nodes.map((n, i) => {
              const t = healthTone(n.status);
              const counters = counterText(n);
              return (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "104px 1fr",
                    gap: 12,
                    alignItems: "center",
                    padding: "8px 12px",
                    background: "var(--gray-25)",
                    border: "1px solid var(--gray-200)",
                    borderRadius: 8,
                  }}
                >
                  <span className={"badge " + t.tone} style={{ justifySelf: "start" }}>
                    <span className="dot" />
                    {t.text}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="font-mono text-xs selectable" style={{ color: "var(--gray-800)" }}>
                      {n.host}
                      {n.port !== null ? `:${n.port}` : ""}
                      {n.ip && n.ip !== n.host ? ` (${n.ip})` : ""}
                    </div>
                    {counters && <div className="text-xs muted">{counters}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {saved && (
        <div
          className="font-mono selectable"
          style={{ marginTop: 14, font: "400 12px/16px var(--font-mono)", color: "var(--gray-500)" }}
        >
          GET {result?.report.url ?? `${base}/v1/healthcheck/upstreams/${id}`}
          {result ? ` · ${result.at.toLocaleTimeString("ko-KR")} 조회` : ""}
        </div>
      )}
    </div>
  );
}
