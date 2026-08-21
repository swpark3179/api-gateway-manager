/**
 * JSON 탭.
 *
 * 두 가지 보기가 있다:
 *  · **앱 관리 키** — 편집 가능. 앱이 다루는 키만 담은 축약형이다.
 *    실제 저장은 Rust 가 게이트웨이 원본을 GET 해 이 키들만 덮어쓰는 머지 방식이라,
 *    여기 보이지 않는 플러그인(limit-count 등)도 그대로 보존된다.
 *  · **게이트웨이 원본** — 읽기 전용. Admin API 가 돌려준 객체 그대로다.
 *    `auth-groups` 가 어느 플러그인의 어떤 키에 들어 있는지 눈으로 확인할 때 쓴다.
 */

import { useState } from "react";

import { useStore } from "../../store";

type Mode = "managed" | "raw";

export default function JsonTab({ sub }: { sub: string }) {
  const jsonDraft = useStore((s) => s.jsonDraft);
  const jsonErr = useStore((s) => s.jsonErr);
  const jsonOk = useStore((s) => s.jsonOk);
  const rawJson = useStore((s) => s.rawJson);
  const form = useStore((s) => s.form);
  const setJsonDraft = useStore((s) => s.setJsonDraft);
  const applyJson = useStore((s) => s.applyJson);
  const resetJson = useStore((s) => s.resetJson);

  const [mode, setMode] = useState<Mode>("managed");
  const showRaw = mode === "raw" && rawJson !== null;

  // groupsLocation 은 route·consumer 에만 있다.
  const loc =
    form && (form.kind === "route" || form.kind === "consumer") ? form.groupsLocation : null;
  const locLabel = loc
    ? loc.plugin
      ? `plugins.${loc.plugin}.${loc.key}${loc.asCsv ? " (콤마 구분 문자열)" : ""}`
      : `${loc.key} (최상위)${loc.asCsv ? " · 콤마 구분 문자열" : ""}`
    : null;

  return (
    <div className="card-surface" style={{ padding: "20px 22px" }}>
      <div className="row between" style={{ marginBottom: 12, gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h5 className="h5">{showRaw ? "게이트웨이 원본" : "요청 본문"}</h5>
          <div className="text-sm muted font-mono selectable" style={{ marginTop: 2 }}>
            {sub}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flex: "0 0 auto" }}>
          {!showRaw && (
            <>
              <button className="btn sm outline" onClick={resetJson}>
                폼 기준으로 되돌리기
              </button>
              <button className="btn sm solid-neutral" onClick={applyJson}>
                폼에 적용
              </button>
            </>
          )}
        </div>
      </div>

      {/* 보기 전환 — 원본은 조회한 항목에만 존재한다(신규 등록에는 없음) */}
      {rawJson !== null && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <div
            className={"chip" + (mode === "managed" ? " on" : "")}
            onClick={() => setMode("managed")}
          >
            앱 관리 키
          </div>
          <div className={"chip" + (mode === "raw" ? " on" : "")} onClick={() => setMode("raw")}>
            게이트웨이 원본
          </div>
        </div>
      )}

      {showRaw ? (
        <pre
          className="selectable"
          style={{
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
          }}
        >
          {rawJson}
        </pre>
      ) : (
        <textarea
          value={jsonDraft}
          onChange={(e) => setJsonDraft(e.target.value)}
          spellCheck={false}
          style={{
            width: "100%",
            height: 430,
            padding: 16,
            border: "1px solid var(--gray-300)",
            borderRadius: 8,
            background: "var(--gray-25)",
            font: "400 12.5px/20px var(--font-mono)",
            color: "var(--gray-800)",
            resize: "vertical",
          }}
        />
      )}

      {!showRaw && jsonErr && (
        <div
          style={{
            marginTop: 10,
            padding: "10px 12px",
            background: "var(--red-50)",
            border: "1px solid var(--red-200)",
            borderRadius: 8,
            font: "400 12px/18px var(--font-mono)",
            color: "var(--red-700)",
          }}
        >
          {jsonErr}
        </div>
      )}

      {!showRaw && jsonOk && (
        <div
          style={{
            marginTop: 10,
            padding: "10px 12px",
            background: "var(--green-50)",
            border: "1px solid var(--green-200)",
            borderRadius: 8,
            font: "400 12px/18px var(--font-sans)",
            color: "var(--green-700)",
          }}
        >
          {jsonOk}
        </div>
      )}

      <div className="text-xs muted" style={{ marginTop: 10, lineHeight: "18px" }}>
        {showRaw ? (
          <>Admin API 가 돌려준 객체 그대로입니다. 이 화면에서는 수정할 수 없습니다.</>
        ) : (
          <>
            이 화면은 앱이 관리하는 키만 보여줍니다. 게이트웨이에 이미 설정된 다른 플러그인은
            저장 시 그대로 보존됩니다.
          </>
        )}
        {locLabel && (
          <>
            <br />
            그룹 필드 위치: <span className="font-mono">{locLabel}</span> — 저장 시 이 자리에
            그대로 되씁니다.
          </>
        )}
        {/* 폼에 없는 키는 이 화면에도 없다. "왜 안 보이지" 를 화면에서 답한다. */}
        {!showRaw && form?.kind === "upstream" && (
          <>
            <br />
            <span className="font-mono">type</span> · <span className="font-mono">checks</span>{" "}
            처럼 폼에 없는 키는 여기에 적어도 저장되지 않습니다. 게이트웨이에 설정된 값은 그대로
            보존됩니다.
          </>
        )}
        {!showRaw && form?.kind === "service" && (
          <>
            <br />
            <span className="font-mono">{"plugins.jwt-auth: {}"}</span> — 게이트웨이에 이미 설정이
            있으면 그 값을 유지합니다. <span className="font-mono">labels</span> 는{" "}
            <span className="font-mono">spec_url</span> 만 보여 주며, 나머지 라벨은 보존됩니다.
          </>
        )}
      </div>
    </div>
  );
}
