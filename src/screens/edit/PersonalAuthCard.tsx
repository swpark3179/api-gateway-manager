/**
 * 개인 식별기능(`plugins.shi-personal-auth`) 토글.
 *
 *   route · service  빈 블록(`{}`)으로 붙어 있기만 하면 된다 — 단순 on/off.
 *   consumer         블록 안에 `secret` 이 있어야 한다. 켜는 순간 비어 있으면 랜덤 hex 를
 *                    채워 주고, 직접 입력한 값으로 바꿀 수도 있다. 저장할 수 있는 상태는
 *                    (ON + secret) 또는 (OFF) 뿐이다 — `store.save` 와 Rust `validate` 가 막는다.
 *
 * 붙이고 떼는 규칙의 진실은 Rust 다 (`models::apply_personal_auth_flag` · `consumers.rs`).
 * 여기서는 반드시 `patchForm` 을 탄다 — 우회하면 JSON 탭의 draft 가 어긋난다.
 */

import { switchKnobStyle, switchStyle } from "../../lib/design";
import { useStore } from "../../store";

/** 스위치 + "저장 시 포함/삭제" 표시. Service 의 플러그인 카드는 이것만 쓴다. */
export function PersonalAuthSwitch() {
  const form = useStore((s) => s.form);
  const patchForm = useStore((s) => s.patchForm);
  const makePersonalSecret = useStore((s) => s.makePersonalSecret);

  if (!form || (form.kind !== "route" && form.kind !== "service" && form.kind !== "consumer")) {
    return null;
  }
  const on = form.personalAuth;

  const toggle = () => {
    patchForm({ personalAuth: !on });
    // consumer 는 secret 이 있어야 저장된다. 켜면서 비어 있으면 바로 채워 준다 — 직접 쓰고
    // 싶으면 덮어쓰면 된다. 끌 때는 값을 지우지 않는다 (되돌렸을 때 살아 있어야 한다).
    if (!on && form.kind === "consumer" && !form.personalSecret.trim()) {
      void makePersonalSecret();
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div
        role="switch"
        aria-checked={on}
        aria-label="개인 식별기능 적용"
        onClick={toggle}
        style={switchStyle(on)}
      >
        <div style={switchKnobStyle} />
      </div>
      <span className="text-xs" style={{ color: on ? "var(--purple-700)" : "var(--gray-500)" }}>
        {on ? "적용 · 저장 시 포함" : "미적용 · 저장 시 삭제"}
      </span>
    </div>
  );
}

/** Route · Consumer 폼의 카드. */
export default function PersonalAuthCard() {
  const form = useStore((s) => s.form);
  const patchForm = useStore((s) => s.patchForm);
  const makePersonalSecret = useStore((s) => s.makePersonalSecret);

  if (!form || (form.kind !== "route" && form.kind !== "consumer")) return null;

  const on = form.personalAuth;
  const isConsumer = form.kind === "consumer";
  const secretMissing = isConsumer && on && !form.personalSecret.trim();
  const secretHasSpace = isConsumer && on && /\s/.test(form.personalSecret.trim());

  return (
    <div className="card-surface" style={{ padding: 24 }}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}
      >
        <div>
          <h5 className="h5">개인 식별기능 적용</h5>
          <p className="text-sm muted" style={{ margin: "4px 0 0" }}>
            {on ? (
              isConsumer ? (
                <>
                  <span className="font-mono">{"plugins.shi-personal-auth: { secret }"}</span> 로
                  저장됩니다.
                </>
              ) : (
                <>
                  <span className="font-mono">{"plugins.shi-personal-auth: {}"}</span> — 게이트웨이에
                  이미 옵션이 있으면 그 값을 유지합니다.
                </>
              )
            ) : (
              <>
                저장할 때 <span className="font-mono">plugins.shi-personal-auth</span> 를
                삭제합니다.
              </>
            )}
          </p>
        </div>
        <PersonalAuthSwitch />
      </div>

      {isConsumer && on && (
        <div style={{ marginTop: 16 }}>
          <label className="field-label">
            secret <span style={{ color: "var(--red-600)" }}>*</span>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="text-input font-mono"
              value={form.personalSecret}
              onChange={(e) => patchForm({ personalSecret: e.target.value })}
              placeholder="직접 입력하거나 '생성' 을 누르세요"
              aria-label="개인 식별기능 secret"
            />
            <button
              className="btn md outline"
              onClick={() => void makePersonalSecret()}
              style={{ flex: "0 0 auto" }}
            >
              생성
            </button>
          </div>
          <div className="text-xs muted" style={{ marginTop: 6 }}>
            ‘생성’ 은 랜덤 해시값(hex 32자)을 채웁니다. 직접 입력한 값도 그대로 저장됩니다.
          </div>
          {secretMissing && (
            <div className="text-xs" style={{ marginTop: 6, color: "var(--yellow-700)" }}>
              secret 이 비어 있으면 저장할 수 없습니다. 입력하거나 생성하세요 — 적용하지 않으려면
              토글을 끄세요.
            </div>
          )}
          {secretHasSpace && (
            <div className="text-xs" style={{ marginTop: 6, color: "var(--yellow-700)" }}>
              공백이 들어간 secret 은 저장되지 않습니다.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
