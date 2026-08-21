/**
 * 권한그룹 입력 콤보박스 — 등록된 그룹에서 고르거나 직접 입력한다.
 *
 * # 왜 `<datalist>` 가 아닌가
 *
 * Chromium 의 datalist 팝업은 브라우저 UI라, 하이라이트된 항목을 Enter 로 확정할 때 그 Enter
 * 가 `onKeyDown` 까지 오는지가 버전·플랫폼마다 다르다. 이 카드의 핵심 조작이 "Enter 로 칩
 * 추가" 라서 사용자 PC 의 WebView2 런타임에 따라 동작이 갈리게 된다. 마우스로 항목을 골라도
 * `input` 이벤트만 나서 칩이 생기지 않는 문제도 있고, 시스템 폰트로 그려지는 팝업을 손으로
 * 맞춰 둔 나머지 UI 와 어울리게 만들 방법도 없다. 이 저장소는 `.chip` · `.tab` · `.lnb-item`
 * 을 전부 직접 만들어 두었으므로 여기서도 같은 선택을 한다.
 */

import { useMemo, useRef, useState } from "react";

/** 팝업에 한 번에 그리는 최대 행 수. 넘치면 '…외 N개' 로 알린다. */
const MAX_ROWS = 50;

export interface GroupComboProps {
  value: string;
  onChange: (v: string) => void;
  /** 값을 확정한다 (Enter · 항목 클릭). 호출부가 칩으로 만든 뒤 입력칸을 비운다. */
  onCommit: (v: string) => void;
  /** 고를 수 있는 그룹. 이미 선택된 값은 호출부에서 걸러 넘긴다. */
  options: string[];
  className?: string;
}

export default function GroupCombo({
  value,
  onChange,
  onCommit,
  options,
  className,
}: GroupComboProps) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const n = value.trim().toLowerCase();
    return n ? options.filter((o) => o.toLowerCase().includes(n)) : options;
  }, [options, value]);

  const shown = matches.slice(0, MAX_ROWS);
  const hidden = matches.length - shown.length;

  const commit = (v: string) => {
    const t = v.trim();
    if (!t) return;
    onCommit(t);
    setOpen(false);
    setHi(-1);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setHi(shown.length > 0 ? 0 : -1);
        } else if (shown.length > 0) {
          setHi((i) => (i + 1) % shown.length);
        }
        return;
      case "ArrowUp":
        e.preventDefault();
        if (open && shown.length > 0) setHi((i) => (i <= 0 ? shown.length - 1 : i - 1));
        return;
      case "Enter":
        e.preventDefault();
        // 하이라이트된 항목이 있으면 그것을, 없으면 입력한 원문을 확정한다.
        commit(open && hi >= 0 && hi < shown.length ? shown[hi] : value);
        return;
      case "Escape":
        // 닫기만 한다 — 입력한 값을 지우지 않는다.
        setOpen(false);
        setHi(-1);
        return;
      case "Tab":
        setOpen(false);
        setHi(-1);
        return;
      default:
    }
  };

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <input
        ref={inputRef}
        className={className}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls="group-combo-list"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHi(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setHi(-1);
        }}
        onKeyDown={onKeyDown}
      />

      {open && shown.length > 0 && (
        <div
          id="group-combo-list"
          role="listbox"
          className="combo-pop"
          // 마우스로 고를 때 blur 가 먼저 일어나 팝업이 닫히는 것을 막는다.
          // (blur 에 setTimeout 을 거는 흔한 방식은 클릭을 놓치는 경우가 생긴다.)
          onMouseDown={(e) => e.preventDefault()}
        >
          {shown.map((o, i) => (
            <div
              key={o}
              role="option"
              aria-selected={i === hi}
              className={"combo-item" + (i === hi ? " on" : "")}
              onMouseEnter={() => setHi(i)}
              onClick={() => commit(o)}
            >
              {o}
            </div>
          ))}
          {hidden > 0 && <div className="combo-more">…외 {hidden}개</div>}
        </div>
      )}
    </div>
  );
}
