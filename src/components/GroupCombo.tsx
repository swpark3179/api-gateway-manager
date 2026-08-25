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

import { useLayoutEffect, useMemo, useRef, useState } from "react";

/** 팝업에 한 번에 그리는 최대 행 수. 넘치면 '…외 N개' 로 알린다. */
const MAX_ROWS = 50;

/** `.combo-pop` 의 CSS max-height. 여유가 넉넉할 때의 상한이다. */
const POP_MAX = 220;
/** 이보다 더 조이지 않는다 — 두 줄만 남은 팝업은 목록이 아니다. 남으면 내부 스크롤이 받는다. */
const POP_MIN = 96;
/** 입력칸·컨테이너 경계와 띄우는 간격. */
const GAP = 8;

/** 팝업을 어디에 얼마나 크게 그릴지. */
interface Placement {
  up: boolean;
  maxHeight: number;
}

/** 스크롤이 실제로 일어나는 조상. 팝업이 잘리는 경계는 뷰포트가 아니라 이쪽이다. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

export interface GroupComboProps {
  value: string;
  onChange: (v: string) => void;
  /** 값을 확정한다 (Enter · 항목 클릭). 호출부가 칩으로 만든 뒤 입력칸을 비운다. */
  onCommit: (v: string) => void;
  /** 고를 수 있는 그룹. 이미 선택된 값은 호출부에서 걸러 넘긴다. */
  options: string[];
  className?: string;
  placeholder?: string;
  /** 라벨이 붙지 않는 자리(목록 상단의 필터 등)에서 쓴다. */
  ariaLabel?: string;
  /** 입력칸에 그대로 얹는다 — 툴바처럼 높이를 옆 컨트롤에 맞춰야 하는 자리를 위한 것. */
  inputStyle?: React.CSSProperties;
}

export default function GroupCombo({
  value,
  onChange,
  onCommit,
  options,
  className,
  placeholder,
  ariaLabel,
  inputStyle,
}: GroupComboProps) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [place, setPlace] = useState<Placement>({ up: false, maxHeight: POP_MAX });
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const n = value.trim().toLowerCase();
    return n ? options.filter((o) => o.toLowerCase().includes(n)) : options;
  }, [options, value]);

  const shown = matches.slice(0, MAX_ROWS);
  const hidden = matches.length - shown.length;

  /**
   * 방향과 높이를 **함께** 정한다.
   *
   * 아래로만 여는 것이 원래 문제였다 — 카드가 창 하단에 있으면 팝업이 본문 컬럼의 스크롤
   * 높이를 늘려 스크롤바를 만들고 목록이 화면 밖으로 밀린다. 그렇다고 뒤집기만 하면 위쪽이
   * 좁을 때 컨테이너 위로 잘려 나가 **스크롤로도 닿을 수 없는** 팝업이 된다. 그래서 넓은 쪽을
   * 고르고, 어느 쪽이든 남은 공간에 맞춰 높이를 조인다 (`.combo-pop` 이 `overflow: auto` 라
   * 넘치는 항목은 팝업 내부 스크롤이 받는다).
   *
   * 행 높이를 가정해 계산하지 않는다 — `.combo-item` 32px 를 코드에 박으면 CSS 를 고치는
   * 순간 어긋난다. 그려 놓고 실측한 뒤 페인트 전에 배치를 바꾼다.
   */
  useLayoutEffect(() => {
    if (!open) return;

    const measure = () => {
      const input = inputRef.current;
      const pop = popRef.current;
      if (!input || !pop) return;

      const box = input.getBoundingClientRect();
      // 기준은 뷰포트가 아니라 스크롤 조상이다. 본문 컬럼의 아래끝은 뷰포트와 같지만
      // 위끝은 커스텀 타이틀바 때문에 0 이 아니다 (App.tsx 의 38px 그리드 행).
      const clip = scrollParent(input)?.getBoundingClientRect();
      const top = clip?.top ?? 0;
      const bottom = clip?.bottom ?? window.innerHeight;

      const below = bottom - box.bottom - GAP;
      const above = box.top - top - GAP;
      // 실제로 필요한 높이. 이보다 여유가 크면 뒤집을 이유가 없다.
      const want = Math.min(pop.scrollHeight, POP_MAX);
      const up = below < want && above > below;
      const room = up ? above : below;

      const next = { up, maxHeight: Math.max(POP_MIN, Math.min(POP_MAX, room)) };
      setPlace((prev) =>
        prev.up === next.up && prev.maxHeight === next.maxHeight ? prev : next,
      );
    };

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // 후보 수가 바뀌면 필요한 높이도 바뀐다. 스크롤 리스너는 필요 없다 — absolute 라
    // 팝업이 입력칸을 그냥 따라간다.
  }, [open, shown.length, hidden]);

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
        aria-label={ariaLabel}
        placeholder={placeholder}
        style={inputStyle}
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
          ref={popRef}
          id="group-combo-list"
          role="listbox"
          className="combo-pop"
          // 마우스로 고를 때 blur 가 먼저 일어나 팝업이 닫히는 것을 막는다.
          // (blur 에 setTimeout 을 거는 흔한 방식은 클릭을 놓치는 경우가 생긴다.)
          onMouseDown={(e) => e.preventDefault()}
          style={{
            maxHeight: place.maxHeight,
            ...(place.up ? { top: "auto", bottom: "calc(100% + 4px)" } : null),
          }}
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
