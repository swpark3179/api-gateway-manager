/**
 * Service 폼 편집 탭.
 *
 * 저장 시 `plugins.jwt-auth` 와 `plugins.shi-log.key` 가 항상 붙고, `spec_url` ·
 * `name 접두어` 는 `labels.spec_url` · `labels.name_prefix` 로 들어간다
 * (services.rs 의 모듈 주석에 labels 를 쓰는 이유가 있다).
 */

import { useStore } from "../../store";

const Req = () => <span style={{ color: "var(--red-600)" }}>*</span>;

/** labels 값 제약 — 공백 불가(`^\S+$`) · 256 바이트. Rust 의 check_label_constraints 와 짝이다. */
const MAX_LABEL_BYTES = 256;
const byteLen = (v: string) => new TextEncoder().encode(v).length;

export default function ServiceForm() {
  const form = useStore((s) => s.form);
  const upstreams = useStore((s) => s.upstreams);
  const patchForm = useStore((s) => s.patchForm);

  if (!form || form.kind !== "service") return null;

  const spec = form.specUrl.trim();
  const specHasSpace = /\s/.test(form.specUrl.trim() ? form.specUrl : "");
  const specTooLong = byteLen(spec) > MAX_LABEL_BYTES;
  const specBadScheme = spec !== "" && !/^https?:\/\//.test(spec);

  const prefix = form.namePrefix.trim();
  // 검사는 **다듬은 값**으로 한다 — Rust 도 trim 한 뒤 저장하므로 앞뒤 공백만으로는
  // 게이트웨이가 거절하지 않는다. 안 나는 400 을 예고하면 경고가 신뢰를 잃는다.
  const prefixHasSpace = /\s/.test(prefix);
  const prefixTooLong = byteLen(prefix) > MAX_LABEL_BYTES;
  // 끝문자는 게이트웨이 제약이 아니라 규약이다 — 경고만 하고 저장은 막지 않는다
  // (자동 보정도 하지 않는다. 값을 몰래 바꾸지 않는다는 이 앱의 원칙).
  const prefixNoSeparator = prefix !== "" && !/[/_]$/.test(prefix);

  // 조회한 값이 목록에 없으면 그대로 보여 준다 — 조용히 다른 upstream 으로 바뀌면 안 된다.
  const orphan = form.upstreamId && !upstreams.some((u) => u.id === form.upstreamId);

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
              placeholder="order-api"
            />
          </div>

          <div>
            <label className="field-label">
              upstream_id <Req />
            </label>
            <select
              className="text-input"
              value={form.upstreamId}
              onChange={(e) => patchForm({ upstreamId: e.target.value })}
            >
              {!form.upstreamId && <option value="">— 선택 —</option>}
              {orphan && <option value={form.upstreamId}>{form.upstreamId} (목록에 없음)</option>}
              {upstreams.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id}
                  {u.name && u.name !== u.id ? ` · ${u.name}` : ""}
                  {u.nodeLabel ? ` (${u.nodeLabel})` : ""}
                </option>
              ))}
            </select>
            <div className="text-xs muted" style={{ marginTop: 6 }}>
              {upstreams.length === 0
                ? "등록된 Upstream 이 없습니다. Upstream 화면에서 먼저 생성하세요."
                : "이 service 를 쓰는 라우트가 이 upstream 으로 흘러갑니다."}
            </div>
          </div>

          <div style={{ gridColumn: "1 / -1" }}>
            <label className="field-label">desc</label>
            <input
              className="text-input"
              value={form.desc}
              onChange={(e) => patchForm({ desc: e.target.value })}
              placeholder="주문 도메인 공통 서비스"
            />
          </div>
        </div>
      </div>

      <div className="card-surface" style={{ padding: 24 }}>
        <h5 className="h5">API 스펙 · Import</h5>
        <p className="text-sm muted" style={{ margin: "4px 0 16px" }}>
          두 값 모두 게이트웨이 <span className="font-mono">labels</span> 에 저장되고 Import
          화면에서만 쓰입니다. 인식하는 라벨만 손대므로 담당자 등 다른 라벨은 보존됩니다.
        </p>

        <label className="field-label">spec_url</label>
        <input
          className="text-input font-mono"
          value={form.specUrl}
          onChange={(e) => patchForm({ specUrl: e.target.value })}
          placeholder="https://git.internal.sds/order/-/raw/main/openapi.yaml"
        />
        <div className="text-xs muted" style={{ marginTop: 6 }}>
          <span className="font-mono">labels.spec_url</span> 로 저장됩니다. 파일을 첨부하지 않으면
          Import 가 이 주소의 스펙을 읽어 비교합니다.{" "}
          <span className="font-mono">http</span> ·{" "}
          <span className="font-mono">https</span> 만 허용하고, labels 제약 때문에 공백 없이
          256바이트 이내여야 합니다. 비워 두면 라벨이 삭제됩니다.
        </div>

        {/* 게이트웨이의 400 은 어느 값이 왜 틀렸는지 알려 주지 않으므로 미리 짚어 준다. */}
        {specHasSpace && (
          <div className="text-xs" style={{ marginTop: 8, color: "var(--yellow-700)" }}>
            공백이 들어간 값은 게이트웨이가 거절합니다 (labels 제약{" "}
            <span className="font-mono">^\S+$</span>).
          </div>
        )}
        {specBadScheme && (
          <div className="text-xs" style={{ marginTop: 8, color: "var(--yellow-700)" }}>
            <span className="font-mono">http://</span> 또는{" "}
            <span className="font-mono">https://</span> 로 시작해야 합니다.
          </div>
        )}
        {specTooLong && (
          <div className="text-xs" style={{ marginTop: 8, color: "var(--yellow-700)" }}>
            {byteLen(spec)}바이트입니다. {MAX_LABEL_BYTES}바이트 이내여야 합니다.
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <label className="field-label">name 접두어</label>
          <input
            className="text-input font-mono"
            value={form.namePrefix}
            onChange={(e) => patchForm({ namePrefix: e.target.value })}
            placeholder="EP_"
          />
          <div className="text-xs muted" style={{ marginTop: 6 }}>
            <span className="font-mono">labels.name_prefix</span> 로 저장됩니다. Import 가 미등록
            API 를 신규 등록 화면으로 넘길 때 <span className="font-mono">name</span> 앞에{" "}
            <b>입력한 그대로</b> 붙습니다 — 대문자로 바꾸거나 슬래시를 끼워 넣지 않으므로
            구분자(<span className="font-mono">/</span> · <span className="font-mono">_</span>)까지
            포함해 적으세요. 비워 두면 라벨이 삭제되고 Import 화면의 경로 접두사에서 파생하는
            기본 규칙(<span className="font-mono">/v1</span> →{" "}
            <span className="font-mono">V1/</span>)으로 돌아갑니다.
          </div>

          {prefix !== "" && (
            <div className="text-xs" style={{ marginTop: 6, color: "var(--gray-700)" }}>
              {"신규 등록 시 "}
              <span className="font-mono">name</span>
              {" 예시 "}
              <span className="font-mono" style={{ color: "var(--purple-700)" }}>
                {prefix}
                {"orders/{orderId}"}
              </span>
            </div>
          )}

          {prefixHasSpace && (
            <div className="text-xs" style={{ marginTop: 8, color: "var(--yellow-700)" }}>
              공백이 들어간 값은 게이트웨이가 거절합니다 (labels 제약{" "}
              <span className="font-mono">^\S+$</span>).
            </div>
          )}
          {prefixTooLong && (
            <div className="text-xs" style={{ marginTop: 8, color: "var(--yellow-700)" }}>
              {byteLen(prefix)}바이트입니다. {MAX_LABEL_BYTES}바이트 이내여야 합니다.
            </div>
          )}
          {prefixNoSeparator && (
            <div className="text-xs" style={{ marginTop: 8, color: "var(--yellow-700)" }}>
              끝이 <span className="font-mono">/</span> 도{" "}
              <span className="font-mono">_</span> 도 아닙니다 — path 가 곧바로 이어 붙어{" "}
              <span className="font-mono">{`${prefix}orders`}</span> 가 됩니다. 저장은 됩니다.
            </div>
          )}
        </div>
      </div>

      <div className="card-surface" style={{ padding: 24 }}>
        <h5 className="h5">플러그인</h5>
        <p className="text-sm muted" style={{ margin: "4px 0 16px" }}>
          저장할 때 <span className="font-mono">jwt-auth</span> 와{" "}
          <span className="font-mono">shi-log</span> 가 항상 포함됩니다. 그 밖의 플러그인은
          게이트웨이에 있는 그대로 보존됩니다.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 20px" }}>
          <div>
            <label className="field-label">
              log-key <Req />
            </label>
            <input
              className="text-input font-mono"
              value={form.logKey}
              onChange={(e) => patchForm({ logKey: e.target.value })}
              placeholder="ep"
            />
            <div className="text-xs muted" style={{ marginTop: 6 }}>
              <span className="font-mono">plugins.shi-log.key</span> 로 저장됩니다.
            </div>
          </div>

          <div>
            <label className="field-label">jwt-auth</label>
            <div style={{ paddingTop: 6 }}>
              <span className="badge success">
                <span className="dot" />
                저장 시 포함
              </span>
            </div>
            <div className="text-xs muted" style={{ marginTop: 6 }}>
              <span className="font-mono">{"plugins.jwt-auth: {}"}</span> — 게이트웨이에 이미
              설정이 있으면 그 값을 유지합니다.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
