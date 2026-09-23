/**
 * Upstream 폼의 헬스체크(`checks`) 카드 + 이 PC 에서의 노드 점검.
 *
 * 폼이 다루는 것은 능동 검사(`checks.active`)의 주요 키와 수동 검사(`checks.passive`)의 장애
 * 판정 키다. 그 밖의 키(`concurrency` · `req_headers` · `passive.healthy` …)는 저장할 때 Rust 가
 * 보존한다 (`upstreams.rs` 의 `apply_checks`). 빈 칸은 APISIX 기본값에 맡긴다 — 기본값을
 * placeholder 로 보여 주므로 대부분은 `http_path` 하나만 적으면 된다.
 *
 * 상태는 전부 `patchChecks` → `patchForm` 을 탄다 (JSON 탭 draft 동기화 — store.ts 주석).
 *
 * `노드 점검` 은 게이트웨이의 판정이 아니다. 이 PC 에서 노드로 한 번 보낸 요청의 결과라,
 * 저장 전에 `http_path` · 포트가 맞는지 확인하는 용도로만 쓴다. 게이트웨이가 본 상태는
 * `UpstreamHealthCard` 가 Control API 로 조회한다.
 */

import { useState } from "react";

import { CHECK_DEFAULTS, CHECK_TYPES, checksLabel, checksProblems } from "../../lib/checks";
import { switchKnobStyle, switchStyle } from "../../lib/design";
import { useStore } from "../../store";
import type { AppError, ChecksFormState, ProbeResult } from "../../types";

type Key = keyof ChecksFormState;

const subHead: React.CSSProperties = {
  font: "600 13px/20px var(--font-sans)",
  color: "var(--gray-800)",
  margin: "20px 0 10px",
};

const VERDICT: Record<ProbeResult["verdict"], { tone: string; text: string }> = {
  healthy: { tone: "success", text: "성공" },
  unhealthy: { tone: "error", text: "실패" },
  neutral: { tone: "neutral", text: "세지 않음" },
};

export default function UpstreamChecksCard() {
  const form = useStore((s) => s.form);
  const upstreams = useStore((s) => s.upstreams);
  const patchChecks = useStore((s) => s.patchChecks);
  const probeUpstream = useStore((s) => s.probeUpstream);

  const [probe, setProbe] = useState<{ at: Date; results: ProbeResult[] } | null>(null);
  const [probeErr, setProbeErr] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);

  if (!form || form.kind !== "upstream") return null;
  const c = form.checks;
  const http = c.type !== "tcp";
  const problems = checksProblems(c);
  // 게이트웨이에 지금 저장돼 있는 헬스체크 — 끄고 저장하면 지워진다는 경고에 쓴다.
  const saved = form.id ? checksLabel(upstreams.find((u) => u.id === form.id)?.checks) : "";

  /** 칸 하나. 빈 칸 = 기본값이라 placeholder 에 그 값을 적는다. */
  const field = (
    key: Key,
    label: string,
    opts: { hint?: string; def?: string; span?: number; mono?: boolean; numeric?: boolean } = {},
  ) => (
    <div style={opts.span ? { gridColumn: `span ${opts.span}` } : undefined}>
      <label className="field-label">{label}</label>
      <input
        className={"text-input" + (opts.mono === false ? "" : " font-mono")}
        value={c[key] as string}
        onChange={(e) => patchChecks({ [key]: e.target.value })}
        placeholder={opts.def ? `기본 ${opts.def}` : undefined}
        inputMode={opts.numeric ? "decimal" : undefined}
        aria-label={label}
      />
      {opts.hint && (
        <div className="text-xs muted" style={{ marginTop: 6 }}>
          {opts.hint}
        </div>
      )}
    </div>
  );

  const onProbe = async () => {
    setBusy(true);
    setProbeErr(null);
    const r = await probeUpstream();
    if (r.ok) {
      setProbe({ at: new Date(), results: r.value });
    } else {
      setProbe(null);
      setProbeErr(r.error);
    }
    setBusy(false);
  };

  return (
    <div className="card-surface" style={{ padding: 24 }}>
      <div
        style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}
      >
        <div>
          <h5 className="h5">헬스체크</h5>
          <p className="text-sm muted" style={{ margin: "4px 0 0" }}>
            <span className="font-mono">checks</span> 로 저장됩니다. 게이트웨이가 노드를 주기적으로
            검사해, 장애로 판정된 노드에는 요청을 보내지 않습니다. 빈 칸은 APISIX 기본값을
            씁니다.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "0 0 auto" }}>
          <div
            role="switch"
            aria-checked={c.enabled}
            aria-label="헬스체크 사용"
            onClick={() => patchChecks({ enabled: !c.enabled })}
            style={switchStyle(c.enabled)}
          >
            <div style={switchKnobStyle} />
          </div>
          <span
            className="text-xs"
            style={{ color: c.enabled ? "var(--purple-700)" : "var(--gray-500)" }}
          >
            {c.enabled ? "사용 · 저장 시 포함" : "사용 안 함"}
          </span>
        </div>
      </div>

      {!c.enabled && saved && (
        <div className="text-xs" style={{ marginTop: 14, color: "var(--yellow-700)" }}>
          게이트웨이에 헬스체크(<span className="font-mono">{saved}</span>)가 설정돼 있습니다.
          이대로 저장하면 <span className="font-mono">checks</span> 가 <b>통째로</b> 삭제됩니다 —
          폼에 없는 <span className="font-mono">req_headers</span> 같은 값도 함께 사라집니다.
        </div>
      )}

      {c.enabled && (
        <>
          <div style={subHead}>능동 검사 (active)</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px 20px" }}>
            <div>
              <label className="field-label">type</label>
              <div style={{ display: "flex", gap: 6, paddingTop: 2 }}>
                {CHECK_TYPES.map((t) => (
                  <div
                    key={t}
                    className={"chip" + (c.type === t ? " on" : "")}
                    onClick={() => patchChecks({ type: t })}
                    style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
                  >
                    {t}
                  </div>
                ))}
              </div>
              <div className="text-xs muted" style={{ marginTop: 6 }}>
                {http ? "검사 경로로 GET 을 보내 응답 코드로 판정합니다." : "연결만 되면 정상입니다."}
              </div>
            </div>
            {field("timeout", "timeout (초)", {
              def: CHECK_DEFAULTS.timeout,
              numeric: true,
              hint: "검사 요청 하나를 기다리는 시간",
            })}
            {field("port", "port", {
              def: "노드 port",
              numeric: true,
              hint: "검사만 다른 포트로 보낼 때",
            })}

            {http && (
              <>
                {field("httpPath", "http_path", {
                  def: CHECK_DEFAULTS.httpPath,
                  span: 2,
                  hint: "헬스체크 엔드포인트 — 예: /health · /actuator/health",
                })}
                {field("host", "host", {
                  def: "노드 host",
                  hint: "검사 요청의 Host 헤더",
                })}
              </>
            )}
          </div>

          <div style={subHead}>정상 판정 (healthy)</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px 20px" }}>
            {field("healthyInterval", "interval (초)", {
              def: CHECK_DEFAULTS.healthyInterval,
              numeric: true,
              hint: "정상 노드를 검사하는 주기",
            })}
            {field("healthySuccesses", "successes", {
              def: CHECK_DEFAULTS.healthySuccesses,
              numeric: true,
              hint: "연속 성공 몇 번에 정상으로 되돌리나",
            })}
            {http &&
              field("healthyStatuses", "http_statuses", {
                def: CHECK_DEFAULTS.healthyStatuses,
                hint: "성공으로 셀 응답 코드",
              })}
          </div>

          <div style={subHead}>장애 판정 (unhealthy)</div>
          <div
            style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px 20px" }}
          >
            {field("unhealthyInterval", "interval (초)", {
              def: CHECK_DEFAULTS.unhealthyInterval,
              numeric: true,
              hint: "장애 노드를 검사하는 주기",
            })}
            {http &&
              field("unhealthyHttpFailures", "http_failures", {
                def: CHECK_DEFAULTS.unhealthyHttpFailures,
                numeric: true,
                hint: "장애 코드 몇 번에 빼나",
              })}
            {field("unhealthyTcpFailures", "tcp_failures", {
              def: CHECK_DEFAULTS.unhealthyTcpFailures,
              numeric: true,
              hint: "연결 실패 몇 번에 빼나",
            })}
            {field("unhealthyTimeouts", "timeouts", {
              def: CHECK_DEFAULTS.unhealthyTimeouts,
              numeric: true,
              hint: "시간 초과 몇 번에 빼나",
            })}
            {http &&
              field("unhealthyStatuses", "http_statuses", {
                def: CHECK_DEFAULTS.unhealthyStatuses,
                span: 4,
                hint: "실패로 셀 응답 코드. 두 목록 어디에도 없는 코드는 세지 않습니다.",
              })}
          </div>

          {!http && (
            <div className="text-xs muted" style={{ marginTop: 12 }}>
              tcp 검사에는 HTTP 요청이 없어 <span className="font-mono">http_path</span> ·{" "}
              <span className="font-mono">host</span> · 응답 코드 칸을 저장하지 않습니다. 입력해 둔
              값은 폼에 남아 있어 http 로 되돌리면 다시 보입니다.
            </div>
          )}

          <div
            style={{
              ...subHead,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              marginTop: 24,
            }}
          >
            <span>수동 검사 (passive)</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                role="switch"
                aria-checked={c.passive}
                aria-label="수동 검사 사용"
                onClick={() => patchChecks({ passive: !c.passive })}
                style={switchStyle(c.passive)}
              >
                <div style={switchKnobStyle} />
              </div>
              <span
                className="text-xs"
                style={{ color: c.passive ? "var(--purple-700)" : "var(--gray-500)" }}
              >
                {c.passive ? "사용" : "사용 안 함"}
              </span>
            </div>
          </div>
          <div className="text-xs muted" style={{ marginTop: -4 }}>
            실제로 프록시한 요청의 응답을 세어 장애를 판정합니다. 장애로 빠진 노드는 위의 능동
            검사가 다시 정상으로 되돌립니다 — 그래서 수동 검사만 따로 켤 수는 없습니다.
          </div>
          {c.passive && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: "16px 20px",
                marginTop: 12,
              }}
            >
              {field("passiveHttpFailures", "http_failures", {
                def: CHECK_DEFAULTS.passiveHttpFailures,
                numeric: true,
              })}
              {field("passiveTcpFailures", "tcp_failures", {
                def: CHECK_DEFAULTS.passiveTcpFailures,
                numeric: true,
              })}
              {field("passiveTimeouts", "timeouts", {
                def: CHECK_DEFAULTS.passiveTimeouts,
                numeric: true,
              })}
              {field("passiveStatuses", "http_statuses", {
                def: CHECK_DEFAULTS.passiveStatuses,
                span: 3,
                hint: "실패로 셀 응답 코드",
              })}
            </div>
          )}

          {/* 게이트웨이의 400 은 어느 칸이 틀렸는지 알려 주지 않는다. 저장은 여기서 막힌다. */}
          {problems.length > 0 && (
            <div className="text-xs" style={{ marginTop: 14, color: "var(--yellow-700)" }}>
              {problems.map((p) => (
                <div key={p}>{p}</div>
              ))}
            </div>
          )}

          <ProbeSection
            http={http}
            busy={busy}
            onProbe={() => void onProbe()}
            probe={probe}
            error={probeErr}
          />
        </>
      )}
    </div>
  );
}

function ProbeSection({
  http,
  busy,
  onProbe,
  probe,
  error,
}: {
  http: boolean;
  busy: boolean;
  onProbe: () => void;
  probe: { at: Date; results: ProbeResult[] } | null;
  error: AppError | null;
}) {
  return (
    <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--gray-200)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ font: "600 13px/20px var(--font-sans)", color: "var(--gray-800)" }}>
            이 PC 에서 노드 점검
          </div>
          <div className="text-xs muted" style={{ marginTop: 2 }}>
            위 설정대로 각 노드에 검사 요청을 <b>한 번</b> 보내 봅니다 — 저장 전에{" "}
            {http ? (
              <>
                <span className="font-mono">http_path</span> · 포트가
              </>
            ) : (
              "포트가"
            )}{" "}
            맞는지 확인하는 용도입니다. 게이트웨이가 본 상태는 아닙니다 (네트워크 경로가
            다릅니다).{http ? " 인증서는 검증하지 않습니다." : ""}
          </div>
        </div>
        <button
          className="btn sm outline"
          onClick={onProbe}
          disabled={busy}
          style={{ flex: "0 0 auto" }}
        >
          {busy ? "점검 중…" : "노드 점검"}
        </button>
      </div>

      {error && (
        <div className="text-xs" style={{ marginTop: 10, color: "var(--red-700)" }}>
          {error.message}
          {error.hint ? ` — ${error.hint}` : ""}
        </div>
      )}

      {probe && (
        <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
          {probe.results.map((r, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "84px 1fr auto",
                gap: 12,
                alignItems: "center",
                padding: "8px 12px",
                background: "var(--gray-25)",
                border: "1px solid var(--gray-200)",
                borderRadius: 8,
              }}
            >
              <span className={"badge " + VERDICT[r.verdict].tone} style={{ justifySelf: "start" }}>
                <span className="dot" />
                {VERDICT[r.verdict].text}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="font-mono text-xs selectable" style={{ color: "var(--gray-800)" }}>
                  {r.target}
                </div>
                <div className="text-xs muted">{r.message}</div>
              </div>
              <span className="font-mono text-xs muted">{r.elapsedMs}ms</span>
            </div>
          ))}
          <div className="text-xs muted">
            {probe.at.toLocaleTimeString("ko-KR")} 점검 · 게이트웨이는 같은 결과가{" "}
            <span className="font-mono">successes</span> ·{" "}
            <span className="font-mono">*_failures</span> 번 이어져야 상태를 바꿉니다.
          </div>
        </div>
      )}
    </div>
  );
}
