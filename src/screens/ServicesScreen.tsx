/**
 * Service 목록.
 *
 * `spec_url` 열을 앞에 두는 이유: 이 값이 비어 있으면 Import 화면에서 파일을 첨부해야만
 * 비교할 수 있다. 어느 service 가 자동 조회되는지 목록에서 바로 보여야 한다.
 */

import { useMemo, useState } from "react";

import { Cell, CellPair } from "../components/Cell";
import MetaList from "../components/MetaList";
import type { Col } from "../components/MetaList";
import { useStore } from "../store";
import type { ServiceView } from "../types";

const ROW = "12px 16px";

/** 열 폭 — `table-layout: fixed` 라 여기 값이 곧 잘림 기준이다 (ListScreen 의 `ROUTE_COLS` 주석 참조). */
const COLS: Col[] = [
  { label: "id", width: "10%" },
  { label: "name", width: "16%" },
  { label: "upstream", width: "14%" },
  // 스펙 주소는 이 표에서 가장 긴 값이라 가장 넓게 준다.
  { label: "spec_url", width: "20%" },
  { label: "log-key", width: "11%" },
  { label: "플러그인", width: "13%" },
  { label: "수정일시", width: "16%" },
];

function filter(items: ServiceView[], q: string): ServiceView[] {
  const n = q.trim().toLowerCase();
  if (!n) return items;
  return items.filter((s) =>
    [s.id, s.name, s.desc, s.upstreamId, s.specUrl, s.namePrefix, s.logKey].some((v) =>
      v.toLowerCase().includes(n),
    ),
  );
}

export default function ServicesScreen() {
  const services = useStore((s) => s.services);
  const syncServices = useStore((s) => s.syncServices);
  const openItem = useStore((s) => s.openItem);
  const syncedAt = useStore((s) => s.syncedAt[s.env]);

  const [q, setQ] = useState("");
  const shown = useMemo(() => filter(services, q), [services, q]);

  return (
    <MetaList
      title="Service"
      newLabel="신규 Service"
      searchPlaceholder="id · name · spec_url 검색"
      syncTitle="게이트웨이에서 Service 전체 목록을 다시 조회해 로컬 캐시를 갱신합니다"
      onSync={() => void syncServices()}
      columns={COLS}
      total={shown.length}
      emptyMessage={
        syncedAt === null
          ? "아직 게이트웨이와 동기화하지 않았습니다. 동기화 버튼을 누르세요."
          : services.length === 0
            ? "등록된 Service 가 없습니다."
            : "조건에 맞는 항목이 없습니다."
      }
      q={q}
      onQ={setQ}
    >
      {shown.map((s) => (
        <tr key={s.id} onClick={() => openItem(s.id)} style={{ cursor: "pointer" }}>
          <td className="mono" style={{ padding: ROW }}>
            <Cell text={s.id} />
          </td>
          <td style={{ padding: ROW }}>
            <CellPair main={s.name || "—"} sub={s.desc} />
          </td>
          <td style={{ padding: ROW }}>
            <CellPair main={s.upstreamId || "—"} sub={s.upstreamLabel} mono />
          </td>
          <td className="mono text-xs" style={{ padding: ROW }}>
            {s.specUrl ? <Cell text={s.specUrl} /> : <span className="muted">미등록</span>}
          </td>
          <td className="mono" style={{ padding: ROW }}>
            {s.logKey ? <Cell text={s.logKey} /> : <span className="muted">—</span>}
          </td>
          <td style={{ padding: ROW }}>
            {/* 저장할 때 jwt-auth 를 보장하지만, 다른 도구로 만든 service 는 없을 수 있다. */}
            <span className={"badge " + (s.hasJwtAuth ? "success" : "warning")}>
              <span className="dot" />
              {s.hasJwtAuth ? "jwt-auth" : "jwt-auth 없음"}
            </span>
          </td>
          <td className="mono text-xs muted" style={{ padding: ROW }}>
            <Cell text={s.updated} />
          </td>
        </tr>
      ))}
    </MetaList>
  );
}
