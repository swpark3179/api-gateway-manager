/**
 * Upstream 폼의 헬스체크(`checks`) 카드 + 이 PC 에서의 노드 점검.
 *
 * 대부분의 upstream 은 같은 설정을 쓰고 host · port 만 다르다. 그래서 카드 맨 위에
 * **'기본값으로 자동설정'** 을 두고, 화면에는 upstream 마다 달라지는 칸(type · http_path · host ·
 * port · timeout)만 펼쳐 둔다. 나머지 숫자는 '세부 설정' 으로 접고 한 줄 요약만 보여 준다.
 *
 *   자동설정   `lib/checks.ts` 의 `CHECK_PRESET`(운영 설정) + 편집 중인 노드의 host · port
 *             (`presetChecks`). 노드마다 값이 다르면 그 칸은 비운다 — 비워 두면 각 노드를 자기
 *             host · port 로 검사한다. 확인 창 대신 '되돌리기' 를 둔다 (이 앱에는 확인 창이 없다).
 *
 * 저장할 때 폼이 모르는 키(`req_headers` …)는 Rust 가 보존한다 (`upstreams.rs` 의 `apply_checks`).
 * 빈 칸은 APISIX 기본값에 맡긴다 — 기본값을 placeholder 로 보여 준다.
 *
 * 상태는 전부 `patchChecks` → `patchForm` 을 탄다 (JSON 탭 draft 동기화 — store.ts 주석).
 *
 * `노드 점검` 은 게이트웨이의 판정이 아니다. 이 PC 에서 노드로 한 번 보낸 요청의 결과라,
 * 저장 전에 `http_path` · 포트가 맞는지 확인하는 용도로만 쓴다. 게이트웨이가 본 상태는
 * `UpstreamHealthCard` 가 Control API 로 조회한다.
 */

import { useState } from "react";

import {
  CHECK_DEFAULTS,
  CHECK_PRESET,
  CHECK_TYPES,
  checksLabel,
  checksNodeWarnings,
  checksProblems,
  checksSummary,
  presetChecks,
} from "../../lib/checks";
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

/** 자동설정 버튼 옆 설명 — 무엇이 채워지는지를 누르기 전에 보여 준다. */
const PRESET_TEXT =
  `http_path ${CHECK_PRESET.httpPath} · timeout ${CHECK_PRESET.timeout}초 · ` +
  `정상 ${CHECK_PRESET.healthyInterval}초마다 ${CHECK_PRESET.healthySuccesses}회 · ` +
  `장애 ${CHECK_PRESET.unhealthyInterval}초마다 ${CHECK_PRESET.unhealthyHttpFailures}회 · 수동 검사 사용`;

/** 되돌리기에 쓸 직전 값과 적용 결과 안내. */
interface Applied {
  prev: ChecksFormState;
  host: string;
  port: string;
  notes: string[];
}

export default function UpstreamChecksCard() {
  const form = useStore((s) => s.form);
  const upstreams = useStore((s) => s.upstreams);
  const patchChecks = useStore((s) => s.patchChecks);
  const probeUpstream = useStore((s) => s.probeUpstream);

  const [probe, setProbe] = useState<{ at: Date; results: ProbeResult[] } | null>(null);
  const [probeErr, setProbeErr] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [detail, setDetail] = useState(false);

  if (!form || form.kind !== "upstream") return null;
  const c = form.checks;
  const http = c.type !== "tcp";
  const problems = checksProblems(c);
  const nodeWarnings = checksNodeWarnings(c, form.nodes);
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

  const onPreset = () => {
    const r = presetChecks(form.nodes);
    setApplied({ prev: c, host: r.checks.host, port: r.checks.port, notes: r.notes });
    patchChecks(r.checks);
  };

  const onUndo = () => {
    if (!applied) return;
    patchChecks(applied.prev);
    setApplied(null);
  };

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
            검사해, 장애로 판정된 노드에는 요청을 보내지 않습니다.
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

      <div
        style={{
          marginTop: 16,
          padding: "12px 14px",
          background: "var(--purple-25)",
          border: "1px solid var(--purple-200)",
          borderRadius: 8,
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}
        >
          <div className="text-xs" style={{ color: "var(--gray-700)", lineHeight: "18px" }}>
            <b>기본값으로 자동설정</b> — {PRESET_TEXT}. <b>host · port</b> 는 이 upstream 의
            노드에서 가져옵니다.
          </div>
          <button
            className="btn sm solid-primary"
            onClick={onPreset}
            style={{ flex: "0 0 auto" }}
          >
            기본값으로 자동설정
          </button>
        </div>
        {applied && (
          <div style={{ marginTop: 10, display: "grid", gap: 4 }}>
            <div
              className="text-xs"
              style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--purple-700)" }}
            >
              <span>
                적용했습니다 — host{" "}
                <span className="font-mono">{applied.host || "(각 노드)"}</span> · port{" "}
                <span className="font-mono">{applied.port || "(각 노드)"}</span>. 저장해야
                게이트웨이에 반영됩니다.
              </span>
              <button className="btn sm ghost" onClick={onUndo} style={{ height: 22 }}>
                되돌리기
              </button>
            </div>
            {applied.notes.map((n) => (
              <div key={n} className="text-xs" style={{ color: "var(--yellow-700)" }}>
                {n}
              </div>
            ))}
          </div>
        )}
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
          <div style={subHead}>검사 대상</div>
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
            {http ? (
              field("httpPath", "http_path", {
                def: CHECK_DEFAULTS.httpPath,
                span: 2,
                hint: "헬스체크 엔드포인트 — 예: /actuator/health",
              })
            ) : (
              <div style={{ gridColumn: "span 2" }} />
            )}

            {http &&
              field("host", "host", {
                def: "각 노드 host",
                hint: "검사 요청의 Host 헤더",
              })}
            {field("port", "port", {
              def: "각 노드 port",
              numeric: true,
              hint: "비우면 노드마다 자기 port 로 검사",
            })}
            {field("timeout", "timeout (초)", {
              def: CHECK_DEFAULTS.timeout,
              numeric: true,
              hint: "검사 요청 하나를 기다리는 시간",
            })}
          </div>

          {nodeWarnings.length > 0 && (
            <div className="text-xs" style={{ marginTop: 10, color: "var(--yellow-700)" }}>
              {nodeWarnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
              <div>노드를 바꿨다면 ‘기본값으로 자동설정’ 을 다시 누르세요.</div>
            </div>
          )}

          {!http && (
            <div className="text-xs muted" style={{ marginTop: 12 }}>
              tcp 검사에는 HTTP 요청이 없어 <span className="font-mono">http_path</span> ·{" "}
              <span className="font-mono">host</span> · 응답 코드 칸을 저장하지 않습니다. 입력해 둔
              값은 폼에 남아 있어 http 로 되돌리면 다시 보입니다.
            </div>
          )}

          <div
            onClick={() => setDetail((v) => !v)}
            role="button"
            aria-expanded={detail}
            style={{
              marginTop: 20,
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              cursor: "pointer",
              border: "1px solid var(--gray-200)",
              borderRadius: 8,
              background: "var(--gray-25)",
            }}
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              style={{
                flex: "0 0 auto",
                transform: detail ? "rotate(90deg)" : undefined,
                transition: "transform 120ms",
                color: "var(--gray-500)",
              }}
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
            <span style={{ font: "600 13px/20px var(--font-sans)", color: "var(--gray-800)" }}>
              세부 설정
            </span>
            <span
              className="text-xs muted"
              style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={checksSummary(c)}
            >
              {checksSummary(c)}
            </span>
          </div>

          {detail && (
            <>
              <div style={subHead}>능동 검사 (active)</div>
              <div
                style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px 20px" }}
              >
                {field("concurrency", "concurrency", {
                  def: CHECK_DEFAULTS.concurrency,
                  numeric: true,
                  hint: "동시에 검사하는 노드 수",
                })}
                {http && (
                  <div>
                    <label className="field-label">https_verify_certificate</label>
                    <select
                      className="text-input"
                      value={c.httpsVerify}
                      onChange={(e) =>
                        patchChecks({ httpsVerify: e.target.value as ChecksFormState["httpsVerify"] })
                      }
                      aria-label="https_verify_certificate"
                    >
                      <option value="">기본 (검증함)</option>
                      <option value="true">검증함 (true)</option>
                      <option value="false">검증 안 함 (false)</option>
                    </select>
                    <div className="text-xs muted" style={{ marginTop: 6 }}>
                      https 검사의 인증서 검증
                    </div>
                  </div>
                )}
              </div>

              <div style={subHead}>정상 판정 (healthy)</div>
              <div
                style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px 20px" }}
              >
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
                  <div>
                    <label className="field-label">type</label>
                    <select
                      className="text-input font-mono"
                      value={c.passiveType}
                      onChange={(e) =>
                        patchChecks({ passiveType: e.target.value as ChecksFormState["passiveType"] })
                      }
                      aria-label="수동 검사 type"
                    >
                      <option value="">기본 ({CHECK_DEFAULTS.passiveType})</option>
                      {CHECK_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  {field("passiveHealthySuccesses", "정상 판정 successes", {
                    def: CHECK_DEFAULTS.passiveHealthySuccesses,
                    numeric: true,
                  })}
                  {field("passiveHealthyStatuses", "정상 판정 http_statuses", {
                    def: CHECK_DEFAULTS.passiveHealthyStatuses,
                  })}
                  {field("passiveHttpFailures", "장애 판정 http_failures", {
                    def: CHECK_DEFAULTS.passiveHttpFailures,
                    numeric: true,
                  })}
                  {field("passiveTcpFailures", "장애 판정 tcp_failures", {
                    def: CHECK_DEFAULTS.passiveTcpFailures,
                    numeric: true,
                  })}
                  {field("passiveTimeouts", "장애 판정 timeouts", {
                    def: CHECK_DEFAULTS.passiveTimeouts,
                    numeric: true,
                  })}
                  {field("passiveStatuses", "장애 판정 http_statuses", {
                    def: CHECK_DEFAULTS.passiveStatuses,
                    span: 3,
                    hint: "실패로 셀 응답 코드",
                  })}
                </div>
              )}
            </>
          )}

          {/* 게이트웨이의 400 은 어느 칸이 틀렸는지 알려 주지 않는다. 저장은 여기서 막힌다.
              세부 설정을 접어 둬도 보이도록 접는 영역 밖에 둔다. */}
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
