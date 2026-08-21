/**
 * Upstream 폼 편집 탭.
 *
 * 노드 목록은 `ContactsCard` 의 "객체 배열" 패턴을 그대로 따른다 — 그리드 행 + 행별 삭제 +
 * 하단 추가 버튼, 상태는 전부 `patchForm` 을 경유한다.
 *
 * `weight` 는 화면에 두지 않는다. 대신 조회한 값을 폼이 들고 있다가 그대로 되쓴다
 * (`types.UpstreamNode` 주석 참조) — 보이지 않는 값을 저장 한 번으로 1 로 덮으면 안 된다.
 */

import { useStore } from "../../store";

const Req = () => <span style={{ color: "var(--red-600)" }}>*</span>;

const PORT_MIN = 1;
const PORT_MAX = 65535;

export default function UpstreamForm() {
  const form = useStore((s) => s.form);
  const patchForm = useStore((s) => s.patchForm);
  const addNode = useStore((s) => s.addNode);
  const patchNode = useStore((s) => s.patchNode);
  const removeNode = useStore((s) => s.removeNode);
  const patchTimeout = useStore((s) => s.patchTimeout);

  if (!form || form.kind !== "upstream") return null;

  const badPort = form.nodes.some((n) => {
    const v = n.port.trim();
    if (v === "") return false;
    const num = Number(v);
    return !Number.isInteger(num) || num < PORT_MIN || num > PORT_MAX;
  });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
      <div className="card-surface" style={{ padding: 24 }}>
        <h5 className="h5" style={{ marginBottom: 16 }}>
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
              onChange={(e) => patchForm({ name: e.target.value })}
              placeholder="order-upstream"
            />
          </div>

          <div>
            <label className="field-label">desc</label>
            <input
              className="text-input"
              value={form.desc}
              onChange={(e) => patchForm({ desc: e.target.value })}
              placeholder="주문 서비스 노드"
            />
          </div>
        </div>
      </div>

      <div className="card-surface" style={{ padding: 24 }}>
        <h5 className="h5">
          노드 <Req />
        </h5>
        <p className="text-sm muted" style={{ margin: "4px 0 14px" }}>
          <span className="font-mono">{'nodes: [{ host, port, weight }]'}</span> 배열로 저장됩니다.
          여러 개 등록하면 게이트웨이가 나눠 보냅니다.
        </p>

        <div
          style={{ display: "grid", gridTemplateColumns: "2fr 1fr 32px", gap: "8px 12px" }}
        >
          <label className="field-label" style={{ marginBottom: 0 }}>
            host
          </label>
          <label className="field-label" style={{ marginBottom: 0 }}>
            port
          </label>
          <span />

          {form.nodes.map((n, i) => (
            // 행마다 로컬 상태가 없으므로 index 키로 충분하다 (ContactsCard 와 같다).
            <NodeRow
              key={i}
              host={n.host}
              port={n.port}
              onHost={(v) => patchNode(i, { host: v })}
              onPort={(v) => patchNode(i, { port: v })}
              onRemove={() => removeNode(i)}
            />
          ))}
        </div>

        {badPort && (
          <div className="text-xs" style={{ marginTop: 10, color: "var(--yellow-700)" }}>
            port 는 {PORT_MIN}~{PORT_MAX} 사이의 정수여야 합니다.
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <button className="btn sm outline" onClick={addNode}>
            노드 추가
          </button>
        </div>
      </div>

      <div className="card-surface" style={{ padding: 24 }}>
        <h5 className="h5">timeout</h5>
        <p className="text-sm muted" style={{ margin: "4px 0 16px" }}>
          초 단위입니다. 기본값은 <span className="font-mono">connect 10</span> ·{" "}
          <span className="font-mono">send 10</span> · <span className="font-mono">read 60</span>{" "}
          입니다.
        </p>

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px 20px" }}
        >
          {(
            [
              ["connect", "연결까지 기다리는 시간"],
              ["send", "요청을 보내는 데 걸리는 시간"],
              ["read", "응답을 받는 데 걸리는 시간"],
            ] as Array<[keyof typeof form.timeout, string]>
          ).map(([key, hint]) => (
            <div key={key}>
              <label className="field-label">{key}</label>
              <input
                className="text-input font-mono"
                value={form.timeout[key]}
                onChange={(e) => patchTimeout({ [key]: e.target.value })}
                inputMode="decimal"
              />
              <div className="text-xs muted" style={{ marginTop: 6 }}>
                {hint}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NodeRow({
  host,
  port,
  onHost,
  onPort,
  onRemove,
}: {
  host: string;
  port: string;
  onHost: (v: string) => void;
  onPort: (v: string) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <input
        className="text-input font-mono"
        value={host}
        onChange={(e) => onHost(e.target.value)}
        placeholder="10.20.3.11"
      />
      <input
        className="text-input font-mono"
        value={port}
        onChange={(e) => onPort(e.target.value)}
        placeholder="8080"
        inputMode="numeric"
      />
      <button
        className="icon-btn"
        onClick={onRemove}
        title="이 노드 삭제"
        style={{ width: 32, height: 32, alignSelf: "center" }}
      >
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </>
  );
}
