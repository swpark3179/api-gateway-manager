/** Route 폼 탭 — 기본 정보 / methods / allowed_groups / status. */

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
                  {s.label}
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

          <div>
            <label className="field-label">plugins · proxy-rewrite.uri</label>
            <input
              className="text-input font-mono"
              value={form.rewrite}
              onChange={(e) => patch({ rewrite: e.target.value })}
              placeholder="/orders/*"
            />
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
