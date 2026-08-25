/**
 * Service 폼 편집 탭.
 *
 * `spec_url` · `name 접두어` 는 `labels.spec_url` · `labels.name_prefix` 로 들어간다
 * (services.rs 의 모듈 주석에 labels 를 쓰는 이유가 있다).
 *
 * 플러그인 두 개는 **조건부**다 — jwt-auth 가 불필요한 service 도, shi-log 가 불필요한
 * service 도 있다. 토글을 끄거나 `log-key` 를 비우면 그 플러그인이 지워지고, 둘 다 없으면
 * `plugins` 키 자체가 사라진다. 판단은 services.rs 의 `apply_service_form` 이 한다.
 */

import { switchKnobStyle, switchStyle } from "../../lib/design";
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

  // log-key 는 필수가 아니다 — 비면 shi-log 를 지운다. 다만 값이 **있으면** 공백이
  // 들어갈 수 없다 (Rust 의 validate 가 거절한다). 검사는 다듬은 값으로 — 저장도 그렇게 한다.
  const logKey = form.logKey.trim();
  const logKeyHasSpace = /\s/.test(logKey);

  // 두 플러그인이 다 빠지면 plugins 키 자체가 사라진다. 파괴적인 결과라 저장 전에 말해 준다
  // (게이트웨이의 400 을 미리 짚어 주는 위 경고들과 같은 성질이다).
  const noPlugins = !form.jwtAuth && logKey === "";

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
          두 플러그인 모두 <b>선택</b>입니다 — 필요 없는 service 는 토글을 끄거나{" "}
          <span className="font-mono">log-key</span> 를 비우면 저장할 때 그 플러그인이
          지워집니다. 그 밖의 플러그인은 게이트웨이에 있는 그대로 보존됩니다.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 20px" }}>
          <div>
            <label className="field-label">log-key</label>
            <input
              className="text-input font-mono"
              value={form.logKey}
              onChange={(e) => patchForm({ logKey: e.target.value })}
              placeholder="ep"
            />
            <div className="text-xs muted" style={{ marginTop: 6 }}>
              <span className="font-mono">plugins.shi-log.key</span> 로 저장됩니다. 비워 두면{" "}
              <span className="font-mono">plugins.shi-log</span> 가 <b>통째로</b> 삭제됩니다 —{" "}
              <span className="font-mono">key</span> 만이 아니라{" "}
              <span className="font-mono">level</span> 같은 다른 필드까지 함께 사라집니다.
            </div>

            {logKeyHasSpace && (
              <div className="text-xs" style={{ marginTop: 8, color: "var(--yellow-700)" }}>
                공백이 들어간 값은 저장되지 않습니다. 지우려면 칸을 <b>비워</b> 두세요.
              </div>
            )}
          </div>

          <div>
            <label className="field-label">jwt-auth</label>
            {/*
              patchForm 을 반드시 탄다 — set({ form }) 로 우회하면 jsonDraft 가 조용히
              어긋난다 (store.ts 의 patchForm 주석).
            */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 6 }}>
              <div
                onClick={() => patchForm({ jwtAuth: !form.jwtAuth })}
                style={switchStyle(form.jwtAuth)}
              >
                <div style={switchKnobStyle} />
              </div>
              <span
                className="text-xs"
                style={{ color: form.jwtAuth ? "var(--purple-700)" : "var(--gray-500)" }}
              >
                {form.jwtAuth ? "저장 시 포함" : "저장 시 삭제"}
              </span>
            </div>
            <div className="text-xs muted" style={{ marginTop: 6 }}>
              {form.jwtAuth ? (
                <>
                  <span className="font-mono">{"plugins.jwt-auth: {}"}</span> — 게이트웨이에 이미
                  설정이 있으면 그 값을 유지합니다.
                </>
              ) : (
                <>
                  저장할 때 <span className="font-mono">plugins.jwt-auth</span> 를 삭제합니다.
                  게이트웨이에 설정돼 있던 <span className="font-mono">header</span> 등의 옵션도
                  함께 사라집니다.
                </>
              )}
            </div>
          </div>
        </div>

        {/* 파괴적인 결과라 저장 전에 화면에서 말해 준다. 저장은 막지 않는다. */}
        {noPlugins && (
          <div className="text-xs" style={{ marginTop: 16, color: "var(--yellow-700)" }}>
            앱이 관리하는 플러그인이 하나도 남지 않습니다 — 다른 플러그인이 없다면{" "}
            <span className="font-mono">plugins</span> 키 자체가 삭제됩니다. 게이트웨이에{" "}
            <span className="font-mono">limit-count</span> 처럼 이 앱이 모르는 플러그인이 붙어
            있으면 그것은 그대로 남습니다.
          </div>
        )}
      </div>
    </div>
  );
}
