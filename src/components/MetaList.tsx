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

interface Props {
  title: string;
  sub: string;
  /** 신규 등록 버튼 라벨 */
  newLabel: string;
  searchPlaceholder: string;
  /** 동기화 버튼 툴팁 — 무엇을 다시 받는지 밝힌다 */
  syncTitle: string;
  onSync: () => void;
  columns: string[];
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
  sub,
  newLabel,
  searchPlaceholder,
  syncTitle,
  onSync,
  columns,
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
          <p className="page-sub">{sub}</p>
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

      <table className="kw-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} style={{ whiteSpace: "nowrap" }}>
                {c}
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
