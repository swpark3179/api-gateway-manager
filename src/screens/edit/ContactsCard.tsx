/**
 * 담당자 카드 — 게이트웨이 `labels` 의 `name{n}` / `dept{n}` 쌍을 그리드로 편집한다.
 *
 * 번호 규칙(저장 시 1..N 으로 재번호, 빈 값은 키 생략, 우리가 만들지 않은 라벨은 보존)은
 * Rust 한 곳에만 있다 — `models::set_contacts_at`. 여기서는 행 목록만 다룬다.
 */

import { useStore } from "../../store";

/** APISIX label 값은 `^\S+$` 라 공백이 하나라도 있으면 게이트웨이가 400 을 낸다. */
const hasSpace = (v: string) => /\s/.test(v.trim());

export default function ContactsCard() {
  const form = useStore((s) => s.form);
  const addContact = useStore((s) => s.addContact);
  const patchContact = useStore((s) => s.patchContact);
  const removeContact = useStore((s) => s.removeContact);

  if (!form || form.kind !== "consumer") return null;

  const bad = form.contacts.some((c) => hasSpace(c.name) || hasSpace(c.dept));

  return (
    <div className="card-surface" style={{ padding: 24 }}>
      <h5 className="h5" style={{ marginBottom: 6 }}>
        담당자
      </h5>
      <p className="text-sm muted" style={{ margin: "0 0 14px" }}>
        게이트웨이 <span className="font-mono">labels</span> 의{" "}
        <span className="font-mono">name1</span> · <span className="font-mono">dept1</span> …
        쌍으로 저장됩니다. 저장할 때 1번부터 다시 번호가 매겨집니다.
      </p>

      {form.contacts.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 32px", gap: "8px 12px" }}>
          <label className="field-label" style={{ marginBottom: 0 }}>
            성명
          </label>
          <label className="field-label" style={{ marginBottom: 0 }}>
            부서
          </label>
          <span />

          {form.contacts.map((c, i) => (
            // 행마다 로컬 상태가 없으므로 index 키로 충분하다.
            <Row
              key={i}
              name={c.name}
              dept={c.dept}
              onName={(v) => patchContact(i, { name: v })}
              onDept={(v) => patchContact(i, { dept: v })}
              onRemove={() => removeContact(i)}
            />
          ))}
        </div>
      )}

      {form.contacts.length === 0 && (
        <div className="text-sm muted" style={{ marginBottom: 14 }}>
          등록된 담당자가 없습니다.
        </div>
      )}

      {bad && (
        <div className="text-xs" style={{ marginTop: 10, color: "var(--yellow-700)" }}>
          공백이 들어간 값은 게이트웨이가 거절합니다 (labels 제약{" "}
          <span className="font-mono">^\S+$</span>). &lsquo;플랫폼 개발팀&rsquo; 대신
          &lsquo;플랫폼개발팀&rsquo; 처럼 붙여 쓰세요.
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <button className="btn sm outline" onClick={addContact}>
          행 추가
        </button>
      </div>
    </div>
  );
}

function Row({
  name,
  dept,
  onName,
  onDept,
  onRemove,
}: {
  name: string;
  dept: string;
  onName: (v: string) => void;
  onDept: (v: string) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <input className="text-input" value={name} onChange={(e) => onName(e.target.value)} />
      <input className="text-input" value={dept} onChange={(e) => onDept(e.target.value)} />
      <button
        className="icon-btn"
        onClick={onRemove}
        title="이 행 삭제"
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
