/** Consumer 폼 탭 — username / desc / jwt-auth.key / jwt-auth.secret + 담당자 + 권한그룹. */

import { useStore } from "../../store";
import ContactsCard from "./ContactsCard";
import GroupsCard from "./GroupsCard";

const Req = () => <span style={{ color: "var(--red-600)" }}>*</span>;

export default function ConsumerForm() {
  const form = useStore((s) => s.form);
  const view = useStore((s) => s.view);
  const patch = useStore((s) => s.patchForm);
  const makeSecret = useStore((s) => s.makeSecret);

  if (!form || form.kind !== "consumer") return null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
      <div className="card-surface" style={{ padding: 24 }}>
        <h5 className="h5" style={{ marginBottom: 18 }}>
          Consumer 정보
        </h5>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 20px" }}>
          <div>
            <label className="field-label">
              username <Req />
            </label>
            <input
              className="text-input font-mono"
              value={form.username}
              onChange={(e) => patch({ username: e.target.value })}
              placeholder="partner_alpha"
              // username 은 APISIX 의 식별자라 수정할 수 없다 (수정하면 다른 consumer 가 된다)
              disabled={view === "detail"}
              style={view === "detail" ? { background: "var(--gray-25)" } : undefined}
            />
            {view === "detail" && (
              <div className="text-xs muted" style={{ marginTop: 6 }}>
                username 은 식별자이므로 변경할 수 없습니다. 이름을 바꾸려면 새로 등록하세요.
              </div>
            )}
          </div>

          <div>
            <label className="field-label">desc</label>
            <input
              className="text-input"
              value={form.desc}
              onChange={(e) => patch({ desc: e.target.value })}
              placeholder="제휴사 알파 연동 계정"
            />
          </div>

          <div>
            <label className="field-label">
              plugins · jwt-auth.key <Req />
            </label>
            <input
              className="text-input font-mono"
              value={form.key}
              onChange={(e) => patch({ key: e.target.value })}
              placeholder="partner-alpha-key"
            />
          </div>

          <div>
            <label className="field-label">
              plugins · jwt-auth.secret <Req />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="text-input font-mono"
                value={form.secret}
                onChange={(e) => patch({ secret: e.target.value, hasSecret: true })}
                placeholder="32자 이상 권장"
              />
              <button
                className="btn md outline"
                onClick={() => void makeSecret()}
                style={{ flex: "0 0 auto" }}
              >
                생성
              </button>
            </div>
            {view === "detail" && !form.hasSecret && (
              <div
                className="text-xs"
                style={{ marginTop: 6, color: "var(--yellow-700)" }}
              >
                게이트웨이가 secret 을 돌려주지 않았습니다. 저장하려면 secret 을 다시 입력하거나
                새로 생성하세요.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 담당자는 계정 메타데이터, 권한그룹은 인가 — 인가를 뒤에 둔다. */}
      <ContactsCard />
      <GroupsCard />
    </div>
  );
}
