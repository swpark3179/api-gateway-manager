/**
 * Import 비교 결과 → 등록된 API 한 건의 "스펙 적용본 vs 게이트웨이 저장분".
 *
 * 이 화면은 **상세로 가기 전 한 단계**다. 차이가 없으면 store 가 아예 이 화면을 띄우지 않고
 * 곧바로 상세를 연다 (`store.openRouteFromImport`).
 *
 * 두 개의 카드가 있다:
 *   1. 변경 사항 선택 — 필드별로 무엇을 적용할지 고른다. **차이가 있는 항목은 처음부터 모두
 *      선택돼 있다** — 여기까지 온 이유가 "스펙대로 맞추겠다" 라서 빼고 싶은 것만 해제한다.
 *   2. 요청 본문 — 고른 것을 반영한 본문과 기존 본문의 줄 단위 diff. 체크를 끌 때마다 바뀐다.
 *
 * 저장은 `store.save()` 를 그대로 부른다 — Import 전용 저장 경로를 만들지 않으므로
 * 플러그인 보존 머지(`routes::apply_route_form`)가 그대로 적용되고, 저장 후 캐시 재동기화와
 * 비교 재실행도 기존 흐름을 탄다.
 */

import { useMemo, useState } from "react";

import ErrorBanner from "../components/ErrorBanner";
import { jsonText } from "../lib/design";
import {
  applySelection,
  diffFields,
  hasSelection,
  lineDiff,
  type DiffField,
  type DiffLine,
  type DiffSelection,
  type FlagKey,
} from "../lib/importDiff";
import { useStore } from "../store";

type Pane = "diff" | "before" | "after";

const MONO_BOX: React.CSSProperties = {
  margin: 0,
  width: "100%",
  height: 430,
  padding: 16,
  border: "1px solid var(--gray-300)",
  borderRadius: 8,
  background: "var(--gray-25)",
  font: "400 12.5px/20px var(--font-mono)",
  color: "var(--gray-800)",
  overflow: "auto",
};

/** diff 한 줄의 색 — 거터 기호와 배경을 한 곳에서 정한다. */
const LINE_STYLE: Record<DiffLine["kind"], { sign: string; bg: string; fg: string }> = {
  same: { sign: " ", bg: "transparent", fg: "var(--gray-700)" },
  del: { sign: "-", bg: "var(--red-50)", fg: "var(--red-700)" },
  add: { sign: "+", bg: "var(--green-50)", fg: "var(--green-700)" },
};

export default function ImportDiffScreen() {
  const row = useStore((s) => s.diffRow);
  const base = useStore((s) => s.diffBase);
  const rows = useStore((s) => s.importRows);
  const sel = useStore((s) => s.diffSel);
  const saving = useStore((s) => s.saving);
  const error = useStore((s) => s.error);
  const setDiffSel = useStore((s) => s.setDiffSel);
  const setDiffAll = useStore((s) => s.setDiffAll);
  const skipToDetail = useStore((s) => s.skipDiffToDetail);
  const backToList = useStore((s) => s.backToList);
  const save = useStore((s) => s.save);

  const [pane, setPane] = useState<Pane>("diff");

  const fields = useMemo(
    () => (row && base ? diffFields(row, base, rows) : []),
    [row, base, rows],
  );
  // 저장될 본문 그대로를 미리 본다 — store 의 `form` 과 같은 값이지만, 이 화면이 자기 입력
  // (base + row + sel)에서 직접 만들어 두 값이 어긋날 자리를 없앤다.
  const before = useMemo(() => (base ? jsonText(base) : ""), [base]);
  const after = useMemo(
    () => (row && base ? jsonText(applySelection(base, row, sel)) : ""),
    [row, base, sel],
  );
  const lines = useMemo(() => lineDiff(before, after), [before, after]);

  if (!row || !base) return null;

  const changed = fields.filter((f) => !f.same).length;
  const picked = hasSelection(sel);
  const title = `${row.method} ${row.fullPath}`;
  const sub = base.id ? `PUT /apisix/admin/routes/${base.id}` : "PUT /apisix/admin/routes";

  return (
    <div data-screen-label="스펙 비교" style={{ padding: "20px 28px 56px", maxWidth: 1120 }}>
      <div className="breadcrumb">
        <a onClick={backToList} style={{ cursor: "pointer" }}>
          API 스펙 Import
        </a>
        <span className="sep">/</span>
        <span className="curr">{title}</span>
      </div>

      <div className="page-header" style={{ marginBottom: 18 }}>
        <div style={{ minWidth: 0 }}>
          {/* .page-title 은 kit.css 가 font 축약형으로 잡고 있어 .font-mono 클래스가 먹지
              않는다 (kit.css 가 나중에 로드된다). 폰트를 인라인으로 준다. */}
          <h2
            className="page-title"
            style={{
              fontSize: 22,
              lineHeight: "30px",
              fontFamily: "var(--font-mono)",
              wordBreak: "break-all",
            }}
          >
            {title}
          </h2>
          <p className="page-sub" style={{ fontSize: 13 }}>
            대상 route <span className="font-mono">{row.routeName || row.routeId}</span> — 스펙과
            다른 항목 {changed}건이 모두 선택돼 있습니다. 그대로 두고 싶은 것을 해제한 뒤 저장을
            누르면 게이트웨이에 반영됩니다.
          </p>
          <p
            className="page-sub selectable"
            style={{ fontSize: 12, marginTop: 2, fontFamily: "var(--font-mono)" }}
          >
            {sub}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn md outline" onClick={skipToDetail} disabled={saving}>
            적용 없이 상세로 이동
          </button>
          <button className="btn md outline" onClick={backToList} disabled={saving}>
            취소
          </button>
          <button
            className="btn md solid-primary"
            onClick={() => void save()}
            disabled={saving || !picked}
            title={picked ? undefined : "적용할 항목을 하나 이상 선택하세요"}
          >
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>

      <ErrorBanner error={error} />

      {/* ── ① 변경 사항 선택 ────────────────────────────────── */}
      <div className="card-surface" style={{ padding: "20px 22px", marginBottom: 16 }}>
        <div className="row between" style={{ marginBottom: 14, gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h5 className="h5">변경 사항 선택</h5>
            <div className="text-sm muted" style={{ marginTop: 2 }}>
              고른 항목만 요청 본문에 반영됩니다. 스펙과 다른 항목은 처음부터 모두 선택돼 있으니,
              그대로 두고 싶은 것만 해제하세요.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flex: "0 0 auto" }}>
            <button className="btn sm outline" onClick={() => setDiffAll(false)}>
              전부 해제
            </button>
            <button className="btn sm solid-neutral" onClick={() => setDiffAll(true)}>
              차이 전부 선택
            </button>
          </div>
        </div>

        <table className="kw-table">
          <thead>
            <tr>
              <th style={{ width: 190, whiteSpace: "nowrap" }}>필드</th>
              <th style={{ whiteSpace: "nowrap" }}>기존 (게이트웨이)</th>
              <th style={{ whiteSpace: "nowrap" }}>스펙 적용 시</th>
              <th style={{ width: 210, whiteSpace: "nowrap" }}>적용</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <FieldRow
                key={f.key}
                field={f}
                sel={sel}
                onToggle={(k, on) => setDiffSel({ [k]: on })}
              />
            ))}
          </tbody>
        </table>

        <div className="text-xs muted" style={{ marginTop: 12, lineHeight: "18px" }}>
          <span className="font-mono">methods</span> · <span className="font-mono">status</span> ·{" "}
          <span className="font-mono">service_id</span> ·{" "}
          <span className="font-mono">allowed_groups</span> 는 이 화면에서 바꾸지 않습니다 —
          게이트웨이에 저장된 값이 그대로 유지됩니다. (
          <span className="font-mono">{row.method}</span> 는 이 route 에 이미 올라와 있어서 이 API
          가 '등록' 으로 판정됐고, route 에 남는 다른 메서드는 옆 API 의 몫입니다.)
        </div>
      </div>

      {/* ── ② 요청 본문 ─────────────────────────────────────── */}
      <div className="card-surface" style={{ padding: "20px 22px" }}>
        <div className="row between" style={{ marginBottom: 12, gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h5 className="h5">요청 본문</h5>
            <div className="text-sm muted font-mono selectable" style={{ marginTop: 2 }}>
              {sub}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {(
            [
              ["diff", "차이"],
              ["before", "기존"],
              ["after", "적용 후"],
            ] as Array<[Pane, string]>
          ).map(([k, label]) => (
            <div key={k} className={"chip" + (pane === k ? " on" : "")} onClick={() => setPane(k)}>
              {label}
            </div>
          ))}
        </div>

        {pane === "diff" ? (
          <pre className="selectable" style={MONO_BOX}>
            {lines.map((l, i) => {
              const st = LINE_STYLE[l.kind];
              return (
                <div key={i} style={{ background: st.bg, color: st.fg }}>
                  {`${st.sign} ${l.text}`}
                </div>
              );
            })}
          </pre>
        ) : (
          <pre className="selectable" style={MONO_BOX}>
            {pane === "before" ? before : after}
          </pre>
        )}

        <div className="text-xs muted" style={{ marginTop: 10, lineHeight: "18px" }}>
          앱이 관리하는 키만 보여 줍니다. 게이트웨이에 이미 설정된 다른 플러그인
          (<span className="font-mono">limit-count</span> 등) 은 저장 시 그대로 보존됩니다.
          {!picked && (
            <>
              <br />
              적용할 항목을 하나도 고르지 않아 저장할 것이 없습니다 — 바뀌지 않는 본문을
              게이트웨이에 보내지 않습니다.
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface FieldRowProps {
  field: DiffField;
  sel: DiffSelection;
  onToggle: (key: FlagKey, on: boolean) => void;
}

const ROW_PAD = "12px 16px";

function FieldRow({ field, sel, onToggle }: FieldRowProps) {
  return (
    <tr>
      <td style={{ padding: ROW_PAD, verticalAlign: "top" }}>
        <div className="name font-mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
          {field.label}
        </div>
        <span
          className={"badge " + (field.same ? "success" : "warning")}
          style={{ marginTop: 6 }}
        >
          <span className="dot" />
          {field.same ? "동일" : "다름"}
        </span>
      </td>

      <td className="mono" style={{ padding: ROW_PAD, verticalAlign: "top", wordBreak: "break-all" }}>
        {field.current}
      </td>

      <td
        style={{
          padding: ROW_PAD,
          verticalAlign: "top",
          wordBreak: "break-all",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: field.same ? "var(--gray-500)" : "var(--purple-700)",
        }}
      >
        {field.next}
        {field.note && (
          <div className="text-xs muted" style={{ marginTop: 6, fontFamily: "var(--font-sans)" }}>
            {field.note}
          </div>
        )}
        {field.warn && (
          <div
            className="text-xs"
            style={{ marginTop: 6, fontFamily: "var(--font-sans)", color: "var(--red-700)" }}
          >
            {field.warn}
          </div>
        )}
      </td>

      <td style={{ padding: ROW_PAD, verticalAlign: "top" }}>
        {field.same ? (
          <span className="text-xs muted">—</span>
        ) : (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              font: "400 12px/18px var(--font-sans)",
              color: "var(--gray-700)",
            }}
          >
            <input
              type="checkbox"
              checked={sel[field.key]}
              onChange={(e) => onToggle(field.key, e.target.checked)}
            />
            <span>스펙 값 적용</span>
          </label>
        )}
      </td>
    </tr>
  );
}
