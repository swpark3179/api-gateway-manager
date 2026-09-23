/**
 * Upstream 목록 — 노드·timeout·헬스체크를 한눈에 보고 행을 눌러 편집한다.
 *
 * `헬스체크` 열은 두 겹이다. 캐시에 있는 **설정**(`http /health`)은 늘 보이고, 헤더의
 * `헬스 상태` 버튼을 누르면 Control API(`GET /v1/healthcheck`) 한 번으로 받은 **판정**
 * (`2/2 정상`)이 그 앞에 붙는다. 목록을 열 때마다 자동으로 부르지 않는 이유는 Control API 가
 * 닿지 않는 환경이 흔해서다 — 기본 설정이면 게이트웨이 내부(127.0.0.1)에서만 열린다.
 */

import { useMemo, useState } from "react";

import { Cell } from "../components/Cell";
import MetaList from "../components/MetaList";
import type { Col } from "../components/MetaList";
import { checksLabel, isUp } from "../lib/checks";
import { useStore } from "../store";
import type { AppError, HealthChecker, UpstreamView } from "../types";

const ROW = "12px 16px";

/** 열 폭 — 잘리면 안 되는 id · name 에는 폭을 주지 않는다 (ListScreen 의 `ROUTE_COLS` 주석 참조). */
const COLS: Col[] = [
  { label: "id" },
  { label: "name" },
  { label: "nodes", width: "176px" },
  // 값(`1000 / 1000 / 1000` · 131px)이 아니라 헤더 라벨이 200px 라 그쪽이 기준이었다.
  // 라벨을 줄여 그 차이를 id · name 으로 돌리고, 원래 이름은 툴팁에 남긴다.
  { label: "timeout", width: "164px", title: "timeout (connect / send / read)" },
  // 뱃지 하나(`체커 없음` 약 76px)가 들어가는 폭. 설정 한 줄(`http /actuator/health`)은
  // 툴팁으로 내렸다 — 칸에 같이 두면 기본 창에서 가로 스크롤이 뜬다 (아래 GRID_MIN).
  { label: "헬스체크", width: "112px", title: "헬스체크 (checks) · 헬스 상태 조회 결과" },
  { label: "type", width: "108px" },
  { label: "수정일시", width: "152px" },
];

/**
 * 고정 열 합계(712) + id · name 바닥값 188px (ListScreen 의 `ROUTE_MIN` 주석 참조).
 *
 * 바닥값이 route 목록(212px)보다 낮은 이유는 ServicesScreen 과 같다 — upstream 의 id · name 은
 * `ups-order` · `order-upstream` 처럼 짧고, 212 를 쓰면 기본 창(표 폭 1088px)에서 가로 스크롤이
 * 뜬다. 712 + 188 × 2 가 정확히 1088 이다.
 */
const GRID_MIN = 712 + 188 * 2;

/** 조회한 헬스 상태 — id → 체커. 체커가 없는 upstream 은 키가 없다. */
interface HealthSnapshot {
  at: Date;
  url: string;
  byId: Map<string, HealthChecker>;
}

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
  const checkUpstreamsHealth = useStore((s) => s.checkUpstreamsHealth);

  const [q, setQ] = useState("");
  // 새 배열을 만드는 계산이라 스토어 셀렉터가 아니라 useMemo 로 감싼다 (store.ts 주석 참조).
  const shown = useMemo(() => filter(upstreams, q), [upstreams, q]);

  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [healthErr, setHealthErr] = useState<AppError | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const anyChecks = upstreams.some((u) => u.checks);

  const onHealth = async () => {
    setHealthBusy(true);
    setHealthErr(null);
    const r = await checkUpstreamsHealth();
    if (r.ok) {
      setHealth({
        at: new Date(),
        url: r.value.url,
        byId: new Map(r.value.checkers.map((c) => [c.srcId, c])),
      });
    } else {
      setHealth(null);
      setHealthErr(r.error);
    }
    setHealthBusy(false);
  };

  return (
    <MetaList
      actions={
        anyChecks && (
          <button
            className="btn md outline"
            onClick={() => void onHealth()}
            disabled={healthBusy}
            title="Control API 에서 헬스체커 상태를 한 번에 조회합니다 (GET /v1/healthcheck)"
          >
            {healthBusy ? "조회 중…" : "헬스 상태"}
          </button>
        )
      }
      notice={<HealthNotice error={healthErr} health={health} />}
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
          <td className="mono" style={{ padding: ROW }}>
            <HealthCell u={u} health={health} />
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

/**
 * `헬스체크` 열. 설정이 없으면 대시, 있으면 검사 방식 뱃지(`http`) — 상태를 조회했으면 그
 * 자리가 판정 뱃지(`1/2 정상`)로 바뀐다. 설정 한 줄과 노드별 상태는 툴팁에 있다.
 *
 * 조회는 했는데 체커가 없으면 `체커 없음` 이다. 에러가 아니다: APISIX 는 요청이 처음 흘러들 때
 * 체커를 만든다 (UpstreamHealthCard 주석).
 */
function HealthCell({ u, health }: { u: UpstreamView; health: HealthSnapshot | null }) {
  const label = checksLabel(u.checks);
  if (!label) return <span className="muted">—</span>;

  if (!health) {
    return (
      <span className="badge neutral" title={label}>
        {label.split(" ")[0]}
      </span>
    );
  }

  const c = health.byId.get(u.id);
  const up = c ? c.nodes.filter(isUp).length : 0;
  const total = c ? c.nodes.length : 0;
  const tone = !c ? "neutral" : up === total ? "success" : up === 0 ? "error" : "warning";
  const text = !c ? "체커 없음" : `${up}/${total} 정상`;
  const detail = c
    ? c.nodes.map((n) => `${n.host}${n.port !== null ? `:${n.port}` : ""} ${n.status}`).join("\n")
    : "헬스체커가 아직 없습니다 — 요청이 처음 들어올 때 만들어집니다.";

  return (
    <span className={"badge " + tone} title={`${label}\n${detail}`}>
      <span className="dot" />
      {text}
    </span>
  );
}

/** 목록 위의 한 줄 — 조회 실패는 빨갛게, 성공은 어디에 물었는지만. */
function HealthNotice({ error, health }: { error: AppError | null; health: HealthSnapshot | null }) {
  if (error) {
    return (
      <div
        className="card-surface"
        style={{
          padding: "12px 16px",
          marginBottom: 16,
          background: "var(--red-50)",
          borderColor: "var(--red-200)",
        }}
      >
        <div style={{ font: "500 13px/20px var(--font-sans)", color: "var(--red-700)" }}>
          헬스 상태를 조회하지 못했습니다 — {error.message}
        </div>
        {error.hint && (
          <div className="text-sm" style={{ color: "var(--red-700)", opacity: 0.85, marginTop: 4 }}>
            {error.hint}
          </div>
        )}
      </div>
    );
  }
  if (!health) return null;
  return (
    <div
      className="text-xs muted font-mono selectable"
      style={{ margin: "-6px 0 12px", textAlign: "right" }}
    >
      헬스 상태 {health.at.toLocaleTimeString("ko-KR")} 조회 · GET {health.url}
    </div>
  );
}
