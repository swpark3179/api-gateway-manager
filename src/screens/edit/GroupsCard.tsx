/**
 * 권한그룹 편집 카드 — Route 와 Consumer 가 공유한다.
 *   Route    → plugins · shi-auth.allowed_groups
 *   Consumer → plugins · jwt-auth.auth_groups
 *
 * 값은 문자열 **배열**이므로 칩 목록을 유지하고, 입력칸만 콤보박스로 둔다.
 * 콤보 옵션은 게이트웨이의 컨슈머들이 실제로 쓰고 있는 그룹이다 (consumerGroupBuckets).
 *
 * Route 에는 모드가 하나 더 있다 — **전체 허용**. 권한그룹을 하나도 등록하지 않은 것과는
 * 다르다: 빈 `allowed_groups` 는 어느 컨슈머도 들어올 수 없는 상태이고, 전체 허용은 그
 * 반대라서 권한 플러그인을 **떼야** 표현된다 (Rust `routes::apply_route_form`).
 * Consumer 에는 이 모드가 없다 — 컨슈머의 auth_groups 가 비어 있는 것은 "이 계정에 권한이
 * 없다" 는 뜻이고, 인가를 여는 쪽은 언제나 route 다.
 */

import { useMemo } from "react";

import GroupCombo from "../../components/GroupCombo";
import { consumerGroupBuckets, NO_GROUP, useStore } from "../../store";

/** Rust 의 기본 저장 위치 (models.rs). 여기와 다르면 비표준 위치다. */
const DEFAULT_LOC: Record<"route" | "consumer", { plugin: string; key: string }> = {
  route: { plugin: "shi-auth", key: "allowed_groups" },
  consumer: { plugin: "jwt-auth", key: "auth_groups" },
};

/** Route 의 두 모드 — `rewriteMode` 칩과 같은 표기다. */
const AUTH_MODES = [
  ["groups", "권한그룹 지정"],
  ["public", "전체 허용"],
] as const;

export default function GroupsCard() {
  const form = useStore((s) => s.form);
  const consumers = useStore((s) => s.consumers);
  const groupDraft = useStore((s) => s.groupDraft);
  const setGroupDraft = useStore((s) => s.setGroupDraft);
  const addGroup = useStore((s) => s.addGroup);
  const removeGroup = useStore((s) => s.removeGroup);
  const patch = useStore((s) => s.patchForm);

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
  // (다른 도구가 `auth-groups` 처럼 다른 표기로 넣어 둔 경우를 숨기지 않기 위해 —
  //  게이트웨이는 표준 위치만 읽으므로 그 사실이 보여야 한다)
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

  const isRoute = form.kind === "route";
  const isPublic = isRoute && form.authMode === "public";

  // 전체 허용으로 저장하면 사라지는 자리. 권한 플러그인이 기본이고, 그룹 값이 **비표준
  // 자리**에서 읽혔다면 그 자리도 함께 지워진다 — 한쪽만 지우면 남은 자리가 계속 검사를
  // 해서 화면이 거짓말을 한다 (Rust `apply_route_form` 이 둘 다 지운다).
  const removed = [
    `plugins · ${def.plugin}`,
    ...(loc && loc.plugin !== def.plugin
      ? [loc.plugin ? `plugins · ${loc.plugin}` : `${loc.key} (최상위 필드)`]
      : []),
  ];

  return (
    <div className="card-surface" style={{ padding: 24 }}>
      <h5 className="h5" style={{ marginBottom: isRoute ? 12 : 6 }}>
        권한그룹
      </h5>

      {/* 두 모드는 나란한 필드가 아니라 **배타적**이다 — proxy-rewrite 칩과 같은 표기다. */}
      {isRoute && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {AUTH_MODES.map(([m, label]) => (
            <div
              key={m}
              className={"chip" + (form.authMode === m ? " on" : "")}
              onClick={() => patch({ authMode: m })}
            >
              {label}
            </div>
          ))}
        </div>
      )}

      {isPublic ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span className="badge warning" title="권한 검사 없이 호출할 수 있습니다">
              <span className="dot" />
              권한 검사 없음
            </span>
          </div>

          <p className="text-sm muted" style={{ margin: "0 0 8px" }}>
            토큰의 권한그룹을 보지 않습니다 — 이 route 는 누구나 호출할 수 있습니다. 저장하면{" "}
            {/* 항목 안에 이미 `plugins · shi-auth` 처럼 가운뎃점이 있어서, 항목 사이를
                같은 기호로 이으면 한 경로처럼 읽힌다 — 쉼표로 끊는다. */}
            {removed.map((r, i) => (
              <span key={r}>
                {i > 0 && ", "}
                <span className="font-mono">{r}</span>
              </span>
            ))}{" "}
            가 게이트웨이에서 삭제됩니다.
          </p>

          {/* 그룹 목록은 폼에 남겨 둔다 (rewriteMode 와 같은 규칙) — 모드를 잘못 눌렀을 때
              되돌릴 수 있어야 한다. 남아 있다는 사실 자체는 알려야 오해가 없다. */}
          {form.groups.length > 0 && (
            <p className="text-xs" style={{ margin: 0, color: "var(--yellow-700)" }}>
              등록해 둔 권한그룹 {form.groups.length}개(
              <span className="font-mono">{form.groups.join(", ")}</span>)는 저장되지 않습니다.
              ‘권한그룹 지정’ 으로 되돌리면 그대로 남아 있습니다.
            </p>
          )}
        </>
      ) : (
        <>
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

          {/* 빈 목록은 "누구나" 가 아니라 "아무도" 다. Route 는 전체 허용 모드가 따로 있으니
              그쪽을 가리켜 준다 — 예전에는 이 상태로 저장하고 왜 403 인지 물어야 했다. */}
          {isRoute && form.groups.length === 0 && (
            <p className="text-xs" style={{ margin: "0 0 12px", color: "var(--yellow-700)" }}>
              그룹이 하나도 없으면 <b>어느 컨슈머도</b> 이 route 를 호출할 수 없습니다. 권한 없이
              열어 두려면 ‘전체 허용’ 을 고르세요.
            </p>
          )}

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
        </>
      )}
    </div>
  );
}
