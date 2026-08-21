/**
 * Service 폼 편집 탭.
 *
 * 저장 시 `plugins.jwt-auth` 와 `plugins.shi-log.key` 가 항상 붙고, `spec_url` 은
 * `labels.spec_url` 로 들어간다 (services.rs 의 모듈 주석에 이유가 있다).
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
        <h5 className="h5">API 스펙 주소</h5>
        <p className="text-sm muted" style={{ margin: "4px 0 16px" }}>
          게이트웨이 <span className="font-mono">labels.spec_url</span> 에 저장됩니다. Import
          화면에서 파일을 첨부하지 않으면 이 주소의 스펙을 읽어 비교합니다.
        </p>

        <label className="field-label">spec_url</label>
        <input
          className="text-input font-mono"
          value={form.specUrl}
          onChange={(e) => patchForm({ specUrl: e.target.value })}
          placeholder="https://git.internal.sds/order/-/raw/main/openapi.yaml"
        />
        <div className="text-xs muted" style={{ marginTop: 6 }}>
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
