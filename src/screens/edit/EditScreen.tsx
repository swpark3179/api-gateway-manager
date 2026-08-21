/**
 * Route · Consumer · Service · Upstream 의 상세·신규 화면 — breadcrumb + 헤더 + 탭.
 *
 * 네 형태가 이 껍데기를 공유한다. 저장·취소·삭제가 헤더에 있어서, 형태마다 화면을 따로 두면
 * 그 세 버튼과 `saving` 처리를 네 번 복붙하게 된다. 형태별로 다른 것은 `form.kind` 로 고른
 * 본문 컴포넌트와 아래 라벨 표뿐이다.
 */

import { useStore } from "../../store";
import ConsumerForm from "./ConsumerForm";
import JsonTab from "./JsonTab";
import JwtTab from "./JwtTab";
import RouteForm from "./RouteForm";
import ServiceForm from "./ServiceForm";
import UpstreamForm from "./UpstreamForm";
import type { FormState, Kind } from "../../types";

/** 형태별 화면 문구와 Admin API 리소스 이름. */
const META: Record<Kind, { label: string; resource: string }> = {
  route: { label: "Route", resource: "routes" },
  consumer: { label: "Consumer", resource: "consumers" },
  service: { label: "Service", resource: "services" },
  upstream: { label: "Upstream", resource: "upstreams" },
};

/** 목록에 보여 줄 식별자 — consumer 만 username 이 이름 자리다. */
const nameOf = (f: FormState): string => (f.kind === "consumer" ? f.username : f.name);

export default function EditScreen() {
  const view = useStore((s) => s.view);
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const form = useStore((s) => s.form);
  const saving = useStore((s) => s.saving);
  const backToList = useStore((s) => s.backToList);
  // Import 비교 결과에서 넘어왔으면 '목록' 링크가 그쪽으로 돌아간다 (store.backToList).
  const fromImport = useStore((s) => s.importReturn && !!s.importDoc);
  const save = useStore((s) => s.save);
  const remove = useStore((s) => s.remove);

  if (!form) return null;

  // 섹션이 아니라 폼의 판별 유니온을 신뢰한다 — 화면과 폼이 어긋날 여지를 없앤다.
  const kind = form.kind;
  const isConsumer = kind === "consumer";
  const isCreate = view === "create";
  const meta = META[kind];
  // Import 비교 결과에서 넘어온 Route 는 '목록' 링크가 그 화면으로 돌아간다.
  const listTitle = kind === "route" && fromImport ? "API 스펙 Import" : meta.label;

  const label = nameOf(form);
  const crumb = isCreate ? "신규 등록" : label;
  const title = isCreate ? `신규 ${meta.label} 등록` : label;

  // 디자인의 editSub 를 실제 호출에 맞춰 표기한다.
  //  · 신규     → POST /{resource} (APISIX 가 id 를 자동 생성)
  //  · 수정     → PUT /{resource}/{실제 id}
  //  · Consumer → PUT /consumers (id 가 아니라 본문의 username 으로 식별한다)
  const sub = isConsumer
    ? "PUT /apisix/admin/consumers"
    : form.id
      ? `PUT /apisix/admin/${meta.resource}/${form.id}`
      : `POST /apisix/admin/${meta.resource}`;

  // JSON · JWT 탭은 route·consumer 전용이다 (design.formJson 주석 참조).
  const tabs: Array<[typeof tab, string]> =
    kind === "service" || kind === "upstream"
      ? [["form", "폼 편집"]]
      : isConsumer && view === "detail"
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

      {tab === "form" && kind === "route" && <RouteForm />}
      {tab === "form" && kind === "consumer" && <ConsumerForm />}
      {tab === "form" && kind === "service" && <ServiceForm />}
      {tab === "form" && kind === "upstream" && <UpstreamForm />}
      {tab === "json" && <JsonTab sub={sub} />}
      {tab === "jwt" && <JwtTab />}
    </div>
  );
}
