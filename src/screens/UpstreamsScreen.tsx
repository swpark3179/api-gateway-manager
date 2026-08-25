/** Upstream 목록 — 노드·timeout 을 한눈에 보고 행을 눌러 편집한다. */

import { useMemo, useState } from "react";

import { Cell, CellPair } from "../components/Cell";
import MetaList from "../components/MetaList";
import type { Col } from "../components/MetaList";
import { useStore } from "../store";
import type { UpstreamView } from "../types";

const ROW = "12px 16px";

/** 열 폭 — `table-layout: fixed` 라 여기 값이 곧 잘림 기준이다 (ListScreen 의 `ROUTE_COLS` 주석 참조). */
const COLS: Col[] = [
  { label: "id", width: "14%" },
  { label: "name", width: "18%" },
  { label: "nodes", width: "20%" },
  // 값은 `1000 / 1000 / 1000` 로 짧지만 헤더 라벨이 200px 라 그쪽이 기준이 된다.
  { label: "timeout (connect/send/read)", width: "22%" },
  { label: "type", width: "10%" },
  { label: "수정일시", width: "16%" },
];

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
          <td style={{ padding: ROW }}>
            <CellPair main={u.name || "—"} sub={u.desc} />
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
