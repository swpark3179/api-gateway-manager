/** Upstream 목록 — 노드·timeout 을 한눈에 보고 행을 눌러 편집한다. */

import { useMemo, useState } from "react";

import { Cell } from "../components/Cell";
import MetaList from "../components/MetaList";
import type { Col } from "../components/MetaList";
import { useStore } from "../store";
import type { UpstreamView } from "../types";

const ROW = "12px 16px";

/** 열 폭 — 잘리면 안 되는 id · name 에는 폭을 주지 않는다 (ListScreen 의 `ROUTE_COLS` 주석 참조). */
const COLS: Col[] = [
  { label: "id" },
  { label: "name" },
  { label: "nodes", width: "176px" },
  // 값(`1000 / 1000 / 1000` · 131px)이 아니라 헤더 라벨이 200px 라 그쪽이 기준이었다.
  // 라벨을 줄여 그 차이를 id · name 으로 돌리고, 원래 이름은 툴팁에 남긴다.
  { label: "timeout", width: "164px", title: "timeout (connect / send / read)" },
  { label: "type", width: "108px" },
  { label: "수정일시", width: "152px" },
];

/** 고정 열 합계(600) + id · name 바닥값 212px (ListScreen 의 `ROUTE_MIN` 주석 참조). */
const GRID_MIN = 600 + 212 * 2;

/** 건수가 적어 클라이언트 배열 필터를 쓴다 (MetaList 주석 참조). */
function filter(items: UpstreamView[], q: string): UpstreamView[] {
  const n = q.trim().toLowerCase();
  if (!n) return items;
  return items.filter((u) =>
    [u.id, u.name, u.desc, u.nodeLabel].some((v) => v.toLowerCase().includes(n)),
  );
}

export default function UpstreamsScreen() {
  const upstreams = useStore((s) => s.upstreams);
  const syncUpstreams = useStore((s) => s.syncUpstreams);
  const openItem = useStore((s) => s.openItem);
  const syncedAt = useStore((s) => s.syncedAt[s.env]);

  const [q, setQ] = useState("");
  // 새 배열을 만드는 계산이라 스토어 셀렉터가 아니라 useMemo 로 감싼다 (store.ts 주석 참조).
  const shown = useMemo(() => filter(upstreams, q), [upstreams, q]);

  return (
    <MetaList
      title="Upstream"
      newLabel="신규 Upstream"
      searchPlaceholder="id · name · host 검색"
      syncTitle="게이트웨이에서 Upstream 전체 목록을 다시 조회해 로컬 캐시를 갱신합니다 (Service 라벨도 함께 갱신)"
      onSync={() => void syncUpstreams()}
      columns={COLS}
      minWidth={GRID_MIN}
      total={shown.length}
      emptyMessage={
        syncedAt === null
          ? "아직 게이트웨이와 동기화하지 않았습니다. 동기화 버튼을 누르세요."
          : upstreams.length === 0
            ? "등록된 Upstream 이 없습니다."
            : "조건에 맞는 항목이 없습니다."
      }
      q={q}
      onQ={setQ}
    >
      {shown.map((u) => (
        <tr key={u.id} onClick={() => openItem(u.id)} style={{ cursor: "pointer" }}>
          <td className="mono" style={{ padding: ROW }}>
            <Cell text={u.id} />
          </td>
          {/* desc 는 같은 칸에 나란히 두지 않고 툴팁으로 내렸다 — 한 줄에 두면 name 의 폭을
              가져간다 (`CellPair` 주석 참조). */}
          <td className="name" style={{ padding: ROW }}>
            <Cell
              text={u.name || "—"}
              title={u.desc ? `${u.name || "—"} · ${u.desc}` : undefined}
            />
          </td>
          <td className="mono" style={{ padding: ROW }}>
            {u.nodeLabel ? (
              <Cell text={u.nodeLabel} />
            ) : (
              // 노드가 없으면 게이트웨이가 흘려보낼 데가 없다 — 조용히 빈 칸으로 두지 않는다.
              <span className="badge warning">
                <span className="dot" />
                노드 없음
              </span>
            )}
          </td>
          <td className="mono" style={{ padding: ROW }}>
            <Cell text={`${u.timeout.connect} / ${u.timeout.send} / ${u.timeout.read}`} />
          </td>
          <td className="mono text-xs muted" style={{ padding: ROW }}>
            <Cell text={u.type} />
          </td>
          <td className="mono text-xs muted" style={{ padding: ROW }}>
            <Cell text={u.updated} />
          </td>
        </tr>
      ))}
    </MetaList>
  );
}
