/**
 * Upstream · Service 목록의 공용 껍데기.
 *
 * `ListScreen` 을 두 번 복사하지 않기 위한 것이다. 다만 `ListScreen` 이 `isConsumer` 삼항으로
 * 두 엔티티를 분기하는 방식은 따르지 않는다 — 다른 부분(제목 · 컬럼 · 행)을 **props 로 받아**
 * 이 파일 안에 조건문이 생기지 않게 한다. 세 번째 엔티티가 붙어도 여기는 그대로다.
 *
 * Route 와 달리 검색은 클라이언트 배열 필터다. 두 목록은 건수가 적어 SQL 을 왕복할 이유가 없다
 * (Consumer 목록이 같은 판단을 한다 — db.rs 의 consumers 테이블 주석 참조).
 */

import type { ReactNode } from "react";

import ErrorBanner from "./ErrorBanner";
import { syncLabel } from "../lib/design";
import { useStore } from "../store";

/**
 * 열 하나. 그리드가 `table-layout: fixed` 라 열 폭이 곧 잘림 기준이다
 * (app.css 의 `.kw-table.one-line`).
 *
 * `width` 를 **비우는 것**이 이 표의 핵심 장치다. fixed 레이아웃은 폭을 못 박은 열을 먼저
 * 떼어 주고, **남는 폭은 폭이 없는 열들끼리 똑같이 나눈다** (CSS 2.1 §17.5.2.1 3단계 —
 * 1088px 표에서 실측 확인). 그래서 잘리면 안 되는 열은 폭을 주지 않고, 값의 최대 길이가
 * 정해져 있는 열(수정일시 · 뱃지 열 등)만 `px` 로 못 박는다. 그러면 창을 넓히거나 좌측
 * 패널을 접어서 생긴 여유가 전부 중요한 열로 간다.
 *
 * 폭을 **모든** 열에 주면 이 장치가 죽는다 — 나눠 줄 대상이 없어 남는 폭이 전 열에
 * 비례 분배되고, `px` 로 못 박은 열까지 같이 늘어난다.
 *
 * `%` 는 쓰지 않는다. 값 폭은 창 크기에 비례하지 않는다 (`2026-08-25 14:30` 은 언제나
 * 148px 다) — `%` 로 주면 좁은 창에서는 모자라고 넓은 창에서는 남는다.
 */
export interface Col {
  label: string;
  /** 값의 최대 폭이 정해진 열만. 잘리면 안 되는 열은 비워 둔다 (위 주석 참조) */
  width?: string;
  /** 헤더 툴팁 — 라벨을 줄여 단 열에서 원래 이름을 밝힌다 (기본값은 `label`) */
  title?: string;
}

interface Props {
  title: string;
  /** 신규 등록 버튼 라벨 */
  newLabel: string;
  searchPlaceholder: string;
  /** 동기화 버튼 툴팁 — 무엇을 다시 받는지 밝힌다 */
  syncTitle: string;
  onSync: () => void;
  columns: Col[];
  /** 표의 최소 폭 — 이보다 좁아지면 열을 더 누르지 않고 가로로 스크롤한다 (app.css 의 `.table-scroll`) */
  minWidth: number;
  /** 필터가 적용된 행 수 (하단 '총 N건') */
  total: number;
  /** 목록이 비었을 때 보여 줄 문구. 로딩·미동기화는 이 컴포넌트가 판단한다 */
  emptyMessage: string;
  children: ReactNode;
  q: string;
  onQ: (v: string) => void;
}

export default function MetaList({
  title,
  newLabel,
  searchPlaceholder,
  syncTitle,
  onSync,
  columns,
  minWidth,
  total,
  emptyMessage,
  children,
  q,
  onQ,
}: Props) {
  const env = useStore((s) => s.env);
  const settings = useStore((s) => s.settings);
  const loading = useStore((s) => s.loading);
  const booting = useStore((s) => s.booting);
  const error = useStore((s) => s.error);
  const syncedAt = useStore((s) => s.syncedAt[s.env]);
  const newItem = useStore((s) => s.newItem);

  const busy = loading || booting;

  return (
    <div data-screen-label={title} style={{ padding: "24px 28px 48px" }}>
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div>
          <h2 className="page-title" style={{ fontSize: 24, lineHeight: "32px" }}>
            {title}
          </h2>
        </div>
        <div className="page-actions">
          <span
            className="text-xs muted font-mono"
            title={
              syncedAt
                ? `마지막 동기화: ${new Date(syncedAt).toLocaleString("ko-KR")}`
                : "아직 게이트웨이와 동기화하지 않았습니다"
            }
            style={{ whiteSpace: "nowrap" }}
          >
            {syncLabel(syncedAt)}
          </span>
          <button className="icon-btn" title={syncTitle} onClick={onSync} disabled={busy}>
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>
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
              placeholder={searchPlaceholder}
              value={q}
              onChange={(e) => onQ(e.target.value)}
            />
          </div>
          <button className="btn md solid-primary" onClick={newItem}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            {newLabel}
          </button>
        </div>
      </div>

      <ErrorBanner error={error} />

      <div className="table-scroll">
        <table className="kw-table one-line" style={{ minWidth }}>
          <thead>
            <tr>
              {columns.map((c) => (
                // 헤더도 잘린다 — 좁은 창에서 긴 라벨이 `…` 가 되므로 툴팁을 건다.
                <th key={c.label} style={{ width: c.width }} title={c.title ?? c.label}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {children}

            {total === 0 && (
              <tr>
                <td colSpan={columns.length} style={{ padding: 0 }}>
                  <div className="state-block">
                    {busy ? (
                      <>
                        <div className="spinner" />
                        <div className="msg">조회하는 중…</div>
                      </>
                    ) : (
                      <div className="msg">{emptyMessage}</div>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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
        <span>총 {total}건</span>
        <span className="selectable">
          GET {settings?.[env]?.adminBase ?? ""}/{title.toLowerCase()}s
        </span>
      </div>
    </div>
  );
}
