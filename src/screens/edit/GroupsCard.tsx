/**
 * 권한그룹 편집 카드 — Route 와 Consumer 가 공유한다.
 *   Route    → plugins · shi-auth.allowed_groups
 *   Consumer → plugins · jwt-auth.auth-groups
 *
 * 값은 문자열 **배열**이므로 칩 목록을 유지하고, 입력칸만 콤보박스로 둔다.
 * 콤보 옵션은 게이트웨이의 컨슈머들이 실제로 쓰고 있는 그룹이다 (consumerGroupBuckets).
 */

import { useMemo } from "react";

import GroupCombo from "../../components/GroupCombo";
import { consumerGroupBuckets, NO_GROUP, useStore } from "../../store";

/** Rust 의 기본 저장 위치 (models.rs). 여기와 다르면 비표준 위치다. */
const DEFAULT_LOC: Record<"route" | "consumer", { plugin: string; key: string }> = {
  route: { plugin: "shi-auth", key: "allowed_groups" },
  consumer: { plugin: "jwt-auth", key: "auth-groups" },
};

export default function GroupsCard() {
  const form = useStore((s) => s.form);
  const consumers = useStore((s) => s.consumers);
  const groupDraft = useStore((s) => s.groupDraft);
  const setGroupDraft = useStore((s) => s.setGroupDraft);
  const addGroup = useStore((s) => s.addGroup);
  const removeGroup = useStore((s) => s.removeGroup);

  // 새 배열을 만드는 계산이라 스토어 셀렉터가 아니라 useMemo 로 감싼다 (store.ts 주석 참조).
  // 이미 선택된 값은 후보에서 빼고, 사용 빈도순(consumerGroupBuckets)을 그대로 쓴다.
  const options = useMemo(() => {
    const picked = new Set(
      form && (form.kind === "route" || form.kind === "consumer") ? form.groups : [],
    );
    return consumerGroupBuckets(consumers)
      .map((b) => b.key)
      .filter((k) => k !== NO_GROUP && !picked.has(k));
  }, [consumers, form]);

  // 이 카드는 route·consumer 전용이다. Service·Upstream 폼은 이걸 렌더하지 않지만,
  // 타입으로도 좁혀 둬야 form.groups 접근이 성립한다.
  if (!form || (form.kind !== "route" && form.kind !== "consumer")) return null;

  // 조회한 항목이면 실제로 값이 들어 있던 자리를 알려 준다.
  // (다른 도구가 `auth_groups` 처럼 다른 표기로 넣어 둔 경우를 숨기지 않기 위해)
  const loc = form.groupsLocation;
  const def = DEFAULT_LOC[form.kind];
  const where = loc
    ? loc.plugin
      ? `plugins · ${loc.plugin}.${loc.key}`
      : `${loc.key} (최상위 필드)`
    : `plugins · ${def.plugin}.${def.key}`;
  // 표준 위치가 아니면 눈에 띄게 알린다 — muted 회색 한 줄은 아무도 읽지 않고,
  // 그 신호가 이 정보를 남기는 이유다.
  const nonStandard = !!loc && (loc.plugin !== def.plugin || loc.key !== def.key);

  return (
    <div className="card-surface" style={{ padding: 24 }}>
      <h5 className="h5" style={{ marginBottom: 6 }}>
        권한그룹
      </h5>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        {nonStandard ? (
          <span className="badge warning" title="이 앱의 기본 위치가 아닙니다">
            <span className="dot" />
            {where}
          </span>
        ) : (
          <span className="text-xs muted font-mono">{where}</span>
        )}
      </div>

      <p className="text-sm muted" style={{ margin: "0 0 14px" }}>
        {loc?.asCsv
          ? "콤마로 이어진 문자열로 저장됩니다. 목록에서 고르거나 직접 입력한 뒤 Enter를 누르세요."
          : "문자열 배열로 등록됩니다. 목록에서 고르거나 직접 입력한 뒤 Enter를 누르세요."}
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
        <GroupCombo
          className="text-input font-mono"
          value={groupDraft}
          onChange={setGroupDraft}
          onCommit={(v) => addGroup(v)}
          options={options}
        />
        <button
          className="btn md outline"
          onClick={() => addGroup()}
          style={{ flex: "0 0 auto" }}
        >
          추가
        </button>
      </div>
    </div>
  );
}
