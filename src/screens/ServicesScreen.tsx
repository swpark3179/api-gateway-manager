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

/** 열 폭 — 잘리면 안 되는 id · name 에는 폭을 주지 않는다 (ListScreen 의 `ROUTE_COLS` 주석 참조). */
const COLS: Col[] = [
  { label: "id" },
  { label: "name" },
  { label: "upstream", width: "160px" },
  // 스펙 주소는 이 표에서 가장 긴 값(45자면 333px)이지만 어차피 다 담을 수 없다. 등록됐는지를
  // 알아보는 것이 목적이라 앞부분만 보여 주고 전체는 툴팁에 맡긴다.
  { label: "spec_url", width: "160px" },
  { label: "log-key", width: "104px" },
  { label: "플러그인", width: "124px" },
  { label: "수정일시", width: "152px" },
];

/**
 * 고정 열 합계(700) + id · name 바닥값 190px (ListScreen 의 `ROUTE_MIN` 주석 참조).
 *
 * 바닥값이 route 목록(212px)보다 낮은 이유: service 의 id · name 은 `svc-order` · `order-api`
 * 처럼 짧다. 열이 일곱이라 여기서 212 를 쓰면 기본 창(표 폭 1088px)에서도 가로 스크롤이 뜬다.
 */
const GRID_MIN = 700 + 190 * 2;

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
      minWidth={GRID_MIN}
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
          {/* desc 는 같은 칸에 나란히 두지 않고 툴팁으로 내렸다 — 한 줄에 두면 name 의 폭을
              가져간다 (`CellPair` 주석 참조). */}
          <td className="name" style={{ padding: ROW }}>
            <Cell
              text={s.name || "—"}
              title={s.desc ? `${s.name || "—"} · ${s.desc}` : undefined}
            />
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
            {/*
              jwt-auth 는 폼의 토글이라 "없음"도 정상 설정이다 — warning(노란색)으로 두면
              멀쩡한 service 가 문제처럼 읽힌다. 사실만 말하는 중립색을 쓴다.
            */}
            <span className={"badge " + (s.hasJwtAuth ? "success" : "neutral")}>
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
