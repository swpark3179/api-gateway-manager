/**
 * Service 목록.
 *
 * `spec_url` 열을 앞에 두는 이유: 이 값이 비어 있으면 Import 화면에서 파일을 첨부해야만
 * 비교할 수 있다. 어느 service 가 자동 조회되는지 목록에서 바로 보여야 한다.
 */

import { useMemo, useState } from "react";

import MetaList from "../components/MetaList";
import { useStore } from "../store";
import type { ServiceView } from "../types";

const ROW = "12px 16px";

function filter(items: ServiceView[], q: string): ServiceView[] {
  const n = q.trim().toLowerCase();
  if (!n) return items;
  return items.filter((s) =>
    [s.id, s.name, s.desc, s.upstreamId, s.specUrl, s.logKey].some((v) =>
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
      sub="upstream 연결 · jwt-auth · shi-log 와 API 스펙 주소(spec_url)를 관리합니다."
      newLabel="신규 Service"
      searchPlaceholder="id · name · spec_url 검색"
      syncTitle="게이트웨이에서 Service 전체 목록을 다시 조회해 로컬 캐시를 갱신합니다"
      onSync={() => void syncServices()}
      columns={["id", "name", "upstream", "spec_url", "log-key", "플러그인", "수정일시"]}
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
            {s.id}
          </td>
          <td style={{ padding: ROW }}>
            <div className="name">{s.name || "—"}</div>
            {s.desc && <div className="text-xs muted">{s.desc}</div>}
          </td>
          <td className="mono" style={{ padding: ROW }}>
            <div>{s.upstreamId || "—"}</div>
            {s.upstreamLabel && <div className="text-xs muted">{s.upstreamLabel}</div>}
          </td>
          <td
            className="mono text-xs"
            style={{ padding: ROW, maxWidth: 260, wordBreak: "break-all" }}
          >
            {s.specUrl || <span className="muted">미등록</span>}
          </td>
          <td className="mono" style={{ padding: ROW }}>
            {s.logKey || <span className="muted">—</span>}
          </td>
          <td style={{ padding: ROW }}>
            {/* 저장할 때 jwt-auth 를 보장하지만, 다른 도구로 만든 service 는 없을 수 있다. */}
            <span className={"badge " + (s.hasJwtAuth ? "success" : "warning")}>
              <span className="dot" />
              {s.hasJwtAuth ? "jwt-auth" : "jwt-auth 없음"}
            </span>
          </td>
          <td className="mono text-xs muted" style={{ padding: ROW, whiteSpace: "nowrap" }}>
            {s.updated}
          </td>
        </tr>
      ))}
    </MetaList>
  );
}
