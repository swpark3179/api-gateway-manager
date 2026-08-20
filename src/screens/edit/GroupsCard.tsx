/**
 * 그룹 문자열 배열 편집 카드 — Route 와 Consumer 가 공유한다.
 *   Route    → plugins · shi-auth.allowed_groups
 *   Consumer → plugins · jwt-auth.auth-groups
 */

import { useStore } from "../../store";

export default function GroupsCard() {
  const form = useStore((s) => s.form);
  const groupDraft = useStore((s) => s.groupDraft);
  const setGroupDraft = useStore((s) => s.setGroupDraft);
  const addGroup = useStore((s) => s.addGroup);
  const removeGroup = useStore((s) => s.removeGroup);

  if (!form) return null;

  // 조회한 항목이면 실제로 값이 들어 있던 자리를 그대로 보여 준다.
  // (다른 도구가 `auth_groups` 처럼 다른 표기로 넣어 둔 경우를 숨기지 않기 위해)
  const loc = form.groupsLocation;
  const label = loc
    ? loc.plugin
      ? `plugins · ${loc.plugin}.${loc.key}`
      : `${loc.key} (최상위 필드)`
    : form.kind === "consumer"
      ? "plugins · jwt-auth.auth-groups"
      : "plugins · shi-auth.allowed_groups";

  return (
    <div className="card-surface" style={{ padding: 24 }}>
      <h5 className="h5" style={{ marginBottom: 6 }}>
        {label}
      </h5>
      <p className="text-sm muted" style={{ margin: "0 0 14px" }}>
        {loc?.asCsv
          ? "콤마로 이어진 문자열로 저장됩니다. 입력 후 Enter를 누르세요."
          : "문자열 배열로 등록됩니다. 입력 후 Enter를 누르세요."}
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {form.groups.map((g, i) => (
          <div key={g} className="chip on" style={{ cursor: "default" }}>
            <span className="font-mono" style={{ fontSize: 12 }}>
              {g}
            </span>
            <span className="x" onClick={() => removeGroup(i)} style={{ cursor: "pointer" }}>
              <svg
                viewBox="0 0 24 24"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </span>
          </div>
        ))}
        {form.groups.length === 0 && (
          <span className="text-sm muted">등록된 그룹이 없습니다.</span>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, maxWidth: 420 }}>
        <input
          className="text-input font-mono"
          value={groupDraft}
          onChange={(e) => setGroupDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addGroup();
            }
          }}
          placeholder="ops-admin"
        />
        <button className="btn md outline" onClick={addGroup} style={{ flex: "0 0 auto" }}>
          추가
        </button>
      </div>
    </div>
  );
}
