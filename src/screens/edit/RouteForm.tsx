/** Route 폼 탭 — 기본 정보 / methods / 권한그룹(또는 전체 허용) / status. */

import { methodChips } from "../../lib/design";
import { useStore } from "../../store";
import GroupsCard from "./GroupsCard";

const Req = () => <span style={{ color: "var(--red-600)" }}>*</span>;

export default function RouteForm() {
  const form = useStore((s) => s.form);
  const services = useStore((s) => s.services);
  const patch = useStore((s) => s.patchForm);
  const toggleMethod = useStore((s) => s.toggleMethod);
  const view = useStore((s) => s.view);

  if (!form || form.kind !== "route") return null;

  const active = form.status === 1;
  const rewriteMode = form.rewriteMode;
  const regexFrom = form.rewriteRegex[0] ?? "";
  const regexTo = form.rewriteRegex[1] ?? "";
  // 첫 쌍 뒤에 남아 있는 쌍의 수. 폼은 이것을 건드리지 않지만 **들고는 있어야** 저장 시
  // 보존된다 (배열 통째로 Rust 에 넘어간다).
  const extraPairs = Math.max(0, Math.floor((form.rewriteRegex.length - 2) / 2));

  /** 첫 쌍의 한 칸만 고친다. 뒤쪽 쌍은 그대로 둔 채 배열을 새로 만든다. */
  const patchRegex = (i: 0 | 1, v: string) => {
    const next = [...form.rewriteRegex];
    // 두 칸이 없는 상태(첫 입력)에서도 [패턴, 치환] 자리가 먼저 생겨야 한다.
    while (next.length < 2) next.push("");
    next[i] = v;
    patch({ rewriteRegex: next });
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
      <div className="card-surface" style={{ padding: 24 }}>
        <h5 className="h5" style={{ marginBottom: 18 }}>
          기본 정보
        </h5>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 20px" }}>
          <div>
            <label className="field-label">
              name <Req />
            </label>
            <input
              className="text-input"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="order-list-v1"
            />
          </div>

          <div>
            <label className="field-label">
              service_id <Req />
            </label>
            <select
              className="text-input"
              value={form.serviceId}
              onChange={(e) => patch({ serviceId: e.target.value })}
            >
              {/* 저장된 service_id 가 목록에 없을 수도 있으므로 자리를 만들어 준다 */}
              {form.serviceId && !services.some((s) => s.id === form.serviceId) && (
                <option value={form.serviceId}>{form.serviceId}</option>
              )}
              {!form.serviceId && <option value="">— 선택 —</option>}
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.optionLabel}
                </option>
              ))}
            </select>
            <div className="text-xs muted" style={{ marginTop: 6 }}>
              {services.length === 0
                ? "등록된 Service 가 없습니다. Upstream/Service 화면에서 먼저 생성하세요."
                : "신규 서버의 upstream · service는 Upstream/Service 화면에서 먼저 생성합니다."}
            </div>
          </div>

          <div>
            <label className="field-label">
              uri <Req />
            </label>
            <input
              className="text-input font-mono"
              value={form.uri}
              onChange={(e) => patch({ uri: e.target.value })}
              placeholder="/api/v1/orders/*"
            />
            <div className="text-xs muted" style={{ marginTop: 6 }}>
              쉼표로 구분하면 uris 배열로 저장됩니다.
            </div>
          </div>

          <div style={{ gridColumn: "1 / -1" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginBottom: 6,
              }}
            >
              <label className="field-label" style={{ marginBottom: 0 }}>
                plugins · proxy-rewrite
              </label>
              {/* 두 키는 나란한 필드가 아니라 **배타적**이다. APISIX 는 uri 가 있으면
                  regex_uri 를 무시하므로(proxy-rewrite.lua), 한쪽만 저장한다. */}
              {(["uri", "regex"] as const).map((m) => (
                <div
                  key={m}
                  className={"chip" + (rewriteMode === m ? " on" : "")}
                  onClick={() => patch({ rewriteMode: m })}
                  style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
                >
                  {m === "uri" ? "uri" : "regex_uri"}
                </div>
              ))}
            </div>

            {rewriteMode === "uri" ? (
              <>
                <input
                  className="text-input font-mono"
                  value={form.rewrite}
                  onChange={(e) => patch({ rewrite: e.target.value })}
                  placeholder="/orders/*"
                />
                <div className="text-xs muted" style={{ marginTop: 6 }}>
                  정적 문자열입니다 — 경로 파라미터를 upstream 으로 넘기려면{" "}
                  <span className="font-mono">regex_uri</span> 를 쓰세요.
                </div>
              </>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                <input
                  className="text-input font-mono"
                  value={regexFrom}
                  onChange={(e) => patchRegex(0, e.target.value)}
                  placeholder="^/evcp/Vendor/CMCTB_VENDOR_GRP/(.*)"
                  aria-label="regex_uri 패턴"
                />
                <input
                  className="text-input font-mono"
                  value={regexTo}
                  onChange={(e) => patchRegex(1, e.target.value)}
                  placeholder="/Vendor/CMCTB_VENDOR_GRP/$1"
                  aria-label="regex_uri 치환값"
                />
                <div className="text-xs muted">
                  요청 경로를 위 패턴으로 매칭해 아래 값으로 바꿔 upstream 에 보냅니다.
                  캡처는 <span className="font-mono">$1</span> · <span className="font-mono">$2</span>{" "}
                  로 참조합니다.
                </div>
                {extraPairs > 0 && (
                  <div className="text-xs" style={{ color: "var(--yellow-700)" }}>
                    이 route 의 <span className="font-mono">regex_uri</span> 는 {extraPairs + 1}쌍입니다
                    — 폼은 첫 쌍만 편집하고 나머지는 그대로 보존됩니다.
                  </div>
                )}
                {regexTo.trim() !== "" && !regexTo.trim().startsWith("/") && (
                  <div className="text-xs" style={{ color: "var(--yellow-700)" }}>
                    치환값이 <span className="font-mono">/</span> 로 시작하지 않습니다. upstream 이
                    받는 것은 경로이므로 대개 <span className="font-mono">/</span> 로 시작합니다.
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ gridColumn: "1 / -1" }}>
            <label className="field-label">desc</label>
            <input
              className="text-input"
              value={form.desc}
              onChange={(e) => patch({ desc: e.target.value })}
              placeholder="주문 목록 조회 API"
            />
          </div>
        </div>
      </div>

      <div className="card-surface" style={{ padding: 24 }}>
        <h5 className="h5" style={{ marginBottom: 6 }}>
          methods
        </h5>
        <p className="text-sm muted" style={{ margin: "0 0 14px" }}>
          허용할 HTTP 메서드를 선택하세요.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {methodChips(form.methods).map((m) => (
            <div
              key={m}
              className={"chip" + (form.methods.includes(m) ? " on" : "")}
              onClick={() => toggleMethod(m)}
              style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
            >
              {m}
            </div>
          ))}
        </div>
      </div>

      <GroupsCard />

      <div
        className="card-surface"
        style={{
          padding: "20px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <div style={{ font: "500 14px/20px var(--font-sans)", color: "var(--gray-900)" }}>
            status
          </div>
          <div className="text-sm muted">
            {view === "create" ? (
              <>
                등록 시 <span className="font-mono">1</span>(활성)로 자동 설정됩니다.
              </>
            ) : (
              <>
                기존 상태가 유지됩니다. 활성/비활성 전환은 게이트웨이 정책에 따릅니다.
              </>
            )}
          </div>
        </div>
        <span className={"badge " + (active ? "success" : "neutral")}>
          <span className="dot" />
          {active ? "1 · 활성" : "0 · 비활성"}
        </span>
      </div>
    </div>
  );
}
