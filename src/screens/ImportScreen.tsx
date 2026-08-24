/**
 * OAS 3.0 스펙 Import — 스펙의 API 목록을 선택한 service 의 라우트와 대조한다.
 *
 * 두 단계가 한 화면에 있다:
 *   1. 스펙 불러오기 — 드래그&드롭 또는 파일 선택 + service · 경로 접두사
 *   2. 비교 결과 — 등록 / 메서드 불일치 / 미등록.
 *      · 등록 · 메서드 불일치 → 스펙 적용본과의 차이를 먼저 본다 (ImportDiffScreen).
 *        차이가 없으면 그 단계를 건너뛰고 상세로 간다.
 *      · 미등록 → 값이 채워진 신규 Route 폼.
 *
 * # 스펙을 어디서 읽는가 — 두 모드
 *
 * 주소를 손으로 붙여 넣는 입력란은 없다. 스펙 주소는 service 의 속성이므로
 * (`labels.spec_url`) service 를 고르면 따라와야 한다.
 *
 *   파일 첨부함   → 첨부한 스펙으로 비교. service 를 바꾸면 비교만 다시 돌린다.
 *   파일 미첨부   → 고른 service 의 `spec_url` 을 읽어 비교한다.
 *
 * 갈림길은 `store.setImportService` 에 있고, 판단 기준은 `importFileName` 이 비었는지다.
 * 파일 읽기는 Rust 가 한다 — 웹뷰에 `fs:` 권한이 없고, URL 은 CSP 가 웹뷰의 외부 통신을
 * 막고 있어 프런트에서 fetch 할 수 없다 (api.ts · client.rs 주석 참조).
 */

import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import ErrorBanner from "../components/ErrorBanner";
import { nameFromPrefix } from "../lib/design";
import { filterCompareRows, useStore } from "../store";
import type { CompareRow, MatchState } from "../types";

const ROW_H = "12px 16px";

/** URL 로 받는 스펙의 크기 상한 (Rust 쪽 MAX_SPEC_BYTES 와 같은 값). */
const MAX_SPEC_BYTES = 8 * 1024 * 1024;

const STATE_META: Record<MatchState, { label: string; cls: string }> = {
  registered: { label: "등록", cls: "success" },
  methodMismatch: { label: "메서드 불일치", cls: "warning" },
  unregistered: { label: "미등록", cls: "neutral" },
};

const CHIPS: Array<[MatchState | "all", string]> = [
  ["all", "전체"],
  ["registered", "등록"],
  ["methodMismatch", "메서드 불일치"],
  ["unregistered", "미등록"],
];

export default function ImportScreen() {
  const env = useStore((s) => s.env);
  const settings = useStore((s) => s.settings);
  const services = useStore((s) => s.services);
  const doc = useStore((s) => s.importDoc);
  const rows = useStore((s) => s.importRows);
  const service = useStore((s) => s.importService);
  const prefix = useStore((s) => s.importPrefix);
  const noProxy = useStore((s) => s.importNoProxy);
  const busy = useStore((s) => s.importBusy);
  const error = useStore((s) => s.importError);
  const chip = useStore((s) => s.importChip);
  const q = useStore((s) => s.importQ);

  const fileName = useStore((s) => s.importFileName);

  const loadOas = useStore((s) => s.loadOas);
  const clearFile = useStore((s) => s.clearImportFile);
  const setService = useStore((s) => s.setImportService);
  const setPrefix = useStore((s) => s.setImportPrefix);
  const setNoProxy = useStore((s) => s.setImportNoProxy);
  const setChip = useStore((s) => s.setImportChip);
  const setQ = useStore((s) => s.setImportQ);
  const openRoute = useStore((s) => s.openRouteFromImport);
  const createRoute = useStore((s) => s.createRouteFromOas);
  const backToList = useStore((s) => s.backToList);
  const flash = useStore((s) => s.flash);

  const [over, setOver] = useState(false);

  const counts = useMemo(() => {
    const c: Record<MatchState, number> = {
      registered: 0,
      methodMismatch: 0,
      unregistered: 0,
    };
    for (const r of rows) c[r.state] += 1;
    return c;
  }, [rows]);

  const shown = useMemo(() => filterCompareRows(rows, chip, q), [rows, chip, q]);

  async function dropFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (file.size > MAX_SPEC_BYTES) {
      flash(`파일이 너무 큽니다 (최대 ${MAX_SPEC_BYTES / (1024 * 1024)}MiB).`);
      return;
    }
    await loadOas({ kind: "text", value: await file.text() }, file.name);
  }

  async function pickFile() {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "OpenAPI 스펙", extensions: ["yaml", "yml", "json"] }],
    });
    if (typeof picked !== "string") return;
    // 파일 다이얼로그는 전체 경로를 준다 — 칩에는 파일명만 보여 준다.
    const base = picked.split(/[\\/]/).pop() || picked;
    await loadOas({ kind: "path", value: picked }, base);
  }

  const envLabel = env === "dev" ? "개발" : "운영";
  const serviceMissing = services.length === 0;
  const selected = services.find((s) => s.id === service);
  /** 접두사에서 파생되는 route 명 접두사 — 눌러 보기 전에 무엇이 채워질지 보여 준다. */
  const namePrefix = nameFromPrefix(prefix);

  return (
    <div data-screen-label="Import" style={{ padding: "20px 28px 56px", maxWidth: 1120 }}>
      <div className="breadcrumb">
        <a onClick={backToList} style={{ cursor: "pointer" }}>
          Route
        </a>
        <span className="sep">/</span>
        <span className="curr">API 스펙 Import</span>
      </div>

      <div className="page-header" style={{ marginBottom: 18 }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="page-title" style={{ fontSize: 24, lineHeight: "32px" }}>
            API 스펙 Import
          </h2>
          <p className="page-sub">
            OAS 3.0 스펙의 API 목록을 {envLabel} 서버의 선택한 service 와 대조합니다. 파일을
            첨부하지 않으면 고른 service 의 <span className="font-mono">spec_url</span> 을
            읽습니다. 등록된 API 는 스펙을 적용한 본문과의 차이를 먼저 보여 주고(같으면 바로
            상세로), 미등록 API 는 값이 채워진 신규 등록 화면으로 이어집니다.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn md outline" onClick={backToList}>
            목록으로
          </button>
        </div>
      </div>

      {/* ── 1단계 · 소스 입력 ───────────────────────────────── */}
      <div className="card-surface" style={{ padding: 24, marginBottom: 16 }}>
        <h5 className="h5" style={{ marginBottom: 16 }}>
          스펙 불러오기
        </h5>

        <div
          className={"drop-zone" + (over ? " over" : "")}
          onDragEnter={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void dropFiles(e.dataTransfer?.files ?? null);
          }}
        >
          <div style={{ font: "500 14px/22px var(--font-sans)", color: "var(--gray-700)" }}>
            여기에 <span className="font-mono">.yaml</span> ·{" "}
            <span className="font-mono">.yml</span> · <span className="font-mono">.json</span>{" "}
            파일을 끌어다 놓으세요
          </div>
          <div className="text-sm muted" style={{ margin: "6px 0 14px" }}>
            또는 파일을 직접 선택합니다.
          </div>
          <button className="btn sm outline" onClick={() => void pickFile()} disabled={busy}>
            파일 선택
          </button>
        </div>

        {/* 첨부한 파일 — 무엇으로 비교하고 있는지 밝히고, x 로 되돌릴 수 있게 한다. */}
        {fileName ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
            <div className="chip on" style={{ cursor: "default", maxWidth: "100%" }}>
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flex: "none" }}
              >
                <path d="M14 3v5h5" />
                <path d="M6 3h8l5 5v13H6z" />
              </svg>
              <span
                className="font-mono selectable"
                style={{ fontSize: 12, wordBreak: "break-all" }}
              >
                {fileName}
              </span>
              <span className="x" title="첨부 해제" onClick={() => void clearFile()}>
                ×
              </span>
            </div>
          </div>
        ) : (
          <div className="text-xs muted" style={{ marginTop: 14 }}>
            파일을 첨부하지 않으면 아래에서 고른 service 의{" "}
            <span className="font-mono">spec_url</span> 을 읽어 비교합니다.
          </div>
        )}

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            cursor: "pointer",
            font: "400 12px/18px var(--font-sans)",
            color: "var(--gray-600)",
          }}
        >
          <input
            type="checkbox"
            checked={noProxy}
            onChange={(e) => setNoProxy(e.target.checked)}
          />
          service 의 spec_url 도 시스템 프록시를 우회해 직접 호출 (기본값은 {envLabel} 서버 설정)
        </label>
        <div className="text-xs muted" style={{ marginTop: 4 }}>
          스펙이 사외 주소에 있고 사내에서 프록시를 거쳐야 한다면 이 체크를 해제하세요. 게이트웨이
          호출에는 영향을 주지 않습니다.
        </div>
      </div>

      {/* ── 비교 조건 ───────────────────────────────────────── */}
      <div className="card-surface" style={{ padding: 24, marginBottom: 16 }}>
        <h5 className="h5" style={{ marginBottom: 16 }}>
          비교 조건
        </h5>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 20px" }}>
          <div>
            <label className="field-label">service_id</label>
            <select
              className="text-input"
              value={service}
              onChange={(e) => setService(e.target.value)}
            >
              {!service && <option value="">— 선택 —</option>}
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.optionLabel}
                </option>
              ))}
            </select>
            <div className="text-xs muted" style={{ marginTop: 6 }}>
              {serviceMissing
                ? "등록된 Service 가 없습니다. Upstream · Service 화면에서 먼저 생성하세요."
                : fileName
                  ? "이 service 에 속한 라우트만 비교 대상입니다. 첨부한 스펙으로 비교합니다."
                  : selected?.specUrl
                    ? "이 service 의 spec_url 을 읽어 비교합니다."
                    : "이 service 에는 spec_url 이 없습니다. Service 화면에서 등록하거나 위에 파일을 첨부하세요."}
            </div>
            {!fileName && selected?.specUrl && (
              <div
                className="text-xs muted font-mono selectable"
                style={{ marginTop: 4, wordBreak: "break-all" }}
              >
                {selected.specUrl}
              </div>
            )}
          </div>

          <div>
            <label className="field-label">경로 접두사</label>
            <input
              className="text-input font-mono"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="/v1"
            />
            <div className="text-xs muted" style={{ marginTop: 6 }}>
              스펙의 <span className="font-mono">servers</span> 경로로 채워집니다. 게이트웨이
              uri 가 <span className="font-mono">/v1/pets</span> 처럼 접두사를 포함할 때 씁니다.
            </div>
            <div className="text-xs" style={{ marginTop: 6, color: "var(--gray-700)" }}>
              route 명 접두사{" "}
              <span className="font-mono" style={{ color: "var(--purple-700)" }}>
                {namePrefix || "(없음)"}
              </span>
              {" — 미등록 건을 신규 등록할 때 "}
              <span className="font-mono">name</span> 앞에 붙습니다.
            </div>
          </div>
        </div>
      </div>

      <ErrorBanner error={error} />

      {/* ── 2단계 · 비교 결과 ───────────────────────────────── */}
      {doc && (
        <>
          <div className="card-surface" style={{ padding: "18px 24px", marginBottom: 16 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 20,
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ font: "600 15px/22px var(--font-sans)", color: "var(--gray-900)" }}>
                  {doc.title || "(제목 없음)"}{" "}
                  {doc.version && <span className="muted">· {doc.version}</span>}
                </div>
                <div
                  className="text-xs muted font-mono selectable"
                  style={{ marginTop: 4, wordBreak: "break-all" }}
                >
                  {fileName || selected?.specUrl || "—"}
                </div>
                <div className="text-sm muted" style={{ marginTop: 6 }}>
                  스펙 API {doc.ops.length}건
                </div>
              </div>
              <div style={{ display: "flex", gap: 28 }}>
                {(
                  [
                    ["등록", counts.registered, "var(--green-700)"],
                    ["메서드 불일치", counts.methodMismatch, "var(--yellow-700)"],
                    ["미등록", counts.unregistered, "var(--gray-700)"],
                  ] as Array<[string, number, string]>
                ).map(([label, n, color]) => (
                  <div key={label} style={{ textAlign: "right" }}>
                    <div className="kpi-label">{label}</div>
                    <div className="kpi-value" style={{ fontSize: 24, lineHeight: "32px", color }}>
                      {n}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {doc.warning && (
            <div
              className="card-surface"
              style={{
                padding: "14px 20px",
                marginBottom: 16,
                background: "var(--yellow-50)",
                borderColor: "var(--yellow-200)",
              }}
            >
              <div
                className="text-sm"
                style={{ color: "var(--yellow-800)", wordBreak: "break-word" }}
              >
                {doc.warning}
              </div>
            </div>
          )}

          <div
            style={{
              display: "flex",
              gap: 8,
              marginBottom: 16,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {CHIPS.map(([k, label]) => (
              <div
                key={k}
                className={"chip" + (chip === k ? " on" : "")}
                onClick={() => setChip(k)}
              >
                {label}
                {k !== "all" && ` (${counts[k as MatchState]})`}
              </div>
            ))}
            <div style={{ flex: 1 }} />
            <div className="gnb-search" style={{ width: 240, height: 36 }}>
              <svg
                viewBox="0 0 24 24"
                width="15"
                height="15"
                fill="none"
                stroke="var(--gray-400)"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-4.2-4.2" />
              </svg>
              <input
                placeholder="path · operationId 검색"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>

          <table className="kw-table">
            <thead>
              <tr>
                {["method", "path", "operationId / summary", "판정", "대상 route"].map((c) => (
                  <th key={c} style={{ whiteSpace: "nowrap" }}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Row
                  key={`${r.method} ${r.fullPath}`}
                  row={r}
                  onOpen={openRoute}
                  onCreate={createRoute}
                />
              ))}

              {shown.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 0 }}>
                    <div className="state-block">
                      {busy ? (
                        <>
                          <div className="spinner" />
                          <div className="msg">비교하는 중…</div>
                        </>
                      ) : (
                        <div className="msg">
                          {!service.trim()
                            ? "비교할 service 를 선택하세요."
                            : rows.length === 0
                              ? "비교 결과가 없습니다."
                              : "조건에 맞는 항목이 없습니다."}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "14px 4px",
              font: "400 12px/16px var(--font-mono)",
              color: "var(--gray-500)",
            }}
          >
            <span>
              {shown.length}건 / 스펙 전체 {doc.ops.length}건
            </span>
            <span className="selectable">
              {settings?.[env]?.adminBase ?? ""}/routes · service_id {service || "—"}
            </span>
          </div>
        </>
      )}

      {!doc && !busy && (
        <div className="card-surface">
          <div className="state-block">
            <div className="msg">
              스펙 파일을 첨부하거나, spec_url 이 등록된 service 를 고르면 대조 결과가 여기에
              표시됩니다.
            </div>
          </div>
        </div>
      )}

      {!doc && busy && (
        <div className="card-surface">
          <div className="state-block">
            <div className="spinner" />
            <div className="msg">스펙을 읽는 중…</div>
          </div>
        </div>
      )}
    </div>
  );
}

interface RowProps {
  row: CompareRow;
  onOpen: (row: CompareRow) => Promise<void>;
  onCreate: (row: CompareRow) => void;
}

function Row({ row, onOpen, onCreate }: RowProps) {
  const meta = STATE_META[row.state];
  const registered = row.state !== "unregistered";

  return (
    <tr
      onClick={() => (registered ? void onOpen(row) : onCreate(row))}
      style={{ cursor: "pointer" }}
      title={
        registered
          ? "클릭하면 스펙을 적용한 본문과 게이트웨이에 저장된 본문을 비교합니다 (같으면 상세로 바로 이동합니다)"
          : "클릭하면 값이 채워진 신규 Route 등록 화면으로 이동합니다"
      }
    >
      <td style={{ padding: ROW_H }}>
        <span className="badge neutral" style={{ fontFamily: "var(--font-mono)" }}>
          {row.method}
        </span>
      </td>
      <td className="mono" style={{ padding: ROW_H }}>
        <div>{row.fullPath}</div>
        {row.fullPath !== row.path && (
          <div className="text-xs muted">스펙 원본 {row.path}</div>
        )}
      </td>
      <td style={{ padding: ROW_H }}>
        <div className="name">{row.operationId || "—"}</div>
        {row.summary && <div className="text-xs muted">{row.summary}</div>}
      </td>
      <td style={{ padding: ROW_H }}>
        <span className={"badge " + meta.cls}>
          <span className="dot" />
          {meta.label}
        </span>
        {row.wildcard && registered && (
          <div className="text-xs muted" style={{ marginTop: 4 }}>
            와일드카드 일치
          </div>
        )}
      </td>
      <td style={{ padding: ROW_H }}>
        {registered ? (
          <>
            <div className="name">{row.routeName || row.routeId}</div>
            <div className="mono text-xs muted">
              {row.routeUri}
              {row.routeStatus !== 1 && " · status 0(비활성)"}
            </div>
          </>
        ) : (
          <>
            <div className="name mono">{row.suggestedName}</div>
            <div className="mono text-xs muted">
              신규 등록 → {row.suggestedUri}
              <br />
              rewrite {row.suggestedRewrite}
            </div>
          </>
        )}
      </td>
    </tr>
  );
}
