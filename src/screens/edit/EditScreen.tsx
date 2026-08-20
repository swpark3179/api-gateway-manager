/** Route / Consumer 상세·신규 화면 — breadcrumb + 헤더 + 탭. */

import { kindOf, useStore } from "../../store";
import ConsumerForm from "./ConsumerForm";
import JsonTab from "./JsonTab";
import JwtTab from "./JwtTab";
import RouteForm from "./RouteForm";

export default function EditScreen() {
  const section = useStore((s) => s.section);
  const view = useStore((s) => s.view);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const form = useStore((s) => s.form);
  const saving = useStore((s) => s.saving);
  const backToList = useStore((s) => s.backToList);
  const save = useStore((s) => s.save);
  const remove = useStore((s) => s.remove);

  if (!form) return null;

  const kind = kindOf(section);
  const isConsumer = kind === "consumer";
  const isCreate = view === "create";
  const listTitle = isConsumer ? "Consumer" : "Route";

  const label = form.kind === "consumer" ? form.username : form.name;
  const crumb = isCreate ? "신규 등록" : label;
  const title = isCreate
    ? isConsumer
      ? "신규 Consumer 등록"
      : "신규 Route 등록"
    : label;

  // 디자인의 editSub 를 실제 호출에 맞춰 표기한다.
  //  · Route 신규 → POST /routes (APISIX 가 id 를 자동 생성)
  //  · Route 수정 → PUT /routes/{실제 id}
  //  · Consumer   → PUT /consumers (본문에 username)
  const sub = isConsumer
    ? "PUT /apisix/admin/consumers"
    : form.kind === "route" && form.id
      ? `PUT /apisix/admin/routes/${form.id}`
      : "POST /apisix/admin/routes";

  const tabs: Array<[typeof tab, string]> =
    isConsumer && view === "detail"
      ? [
          ["form", "폼 편집"],
          ["json", "JSON"],
          ["jwt", "JWT 토큰"],
        ]
      : [
          ["form", "폼 편집"],
          ["json", "JSON"],
        ];

  return (
    <div data-screen-label="상세" style={{ padding: "20px 28px 56px", maxWidth: 1080 }}>
      <div className="breadcrumb">
        <a onClick={backToList} style={{ cursor: "pointer" }}>
          {listTitle}
        </a>
        <span className="sep">/</span>
        <span className="curr">{crumb || "—"}</span>
      </div>

      <div className="page-header" style={{ marginBottom: 18 }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="page-title" style={{ fontSize: 24, lineHeight: "32px" }}>
            {title || "—"}
          </h2>
          <p className="page-sub font-mono selectable" style={{ fontSize: 12 }}>
            {sub}
          </p>
        </div>
        <div className="page-actions">
          {view === "detail" && (
            <button
              className="btn md outline"
              onClick={() => void remove()}
              disabled={saving}
              style={{ color: "var(--red-700)", borderColor: "var(--red-200)" }}
            >
              삭제
            </button>
          )}
          <button className="btn md outline" onClick={backToList} disabled={saving}>
            취소
          </button>
          <button className="btn md solid-primary" onClick={() => void save()} disabled={saving}>
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>

      <div className="tabs">
        {tabs.map(([k, label]) => (
          <div key={k} className={"tab" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>
            {label}
          </div>
        ))}
      </div>

      {tab === "form" && (isConsumer ? <ConsumerForm /> : <RouteForm />)}
      {tab === "json" && <JsonTab sub={sub} />}
      {tab === "jwt" && <JwtTab />}
    </div>
  );
}
