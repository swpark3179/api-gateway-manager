/** Route / Consumer 목록 — 디자인의 '목록' 화면. */

import { useMemo } from "react";

import { syncLabel } from "../lib/design";
import { filterConsumers, kindOf, NO_GROUP, useStore } from "../store";
import BadgeList from "../components/BadgeList";
import { Cell } from "../components/Cell";
import GroupCombo from "../components/GroupCombo";
import type { Col } from "../components/MetaList";
import { ALL_ROUTES, rewriteText, scopeLabel } from "../types";

const ROW_H = "14px 16px";

/**
 * 열 폭 — `table-layout: fixed` 라 여기 값이 곧 잘림 기준이다 (MetaList 의 `Col` 주석 참조).
 *
 * 잘리면 안 되는 열(name · uri)에는 폭을 **주지 않는다**. fixed 레이아웃이 남는 폭을
 * 폭 없는 열들끼리 똑같이 나눠 주므로, 창을 넓히거나 좌측 패널을 접어서 생긴 여유가
 * 전부 이 두 열로 간다. 나머지는 값의 최대 폭을 실측해 `px` 로 못 박았다 (헤더 라벨이 아니라
 * **값**이 기준이다 — 값보다 라벨이 길면 라벨을 줄이고 원래 이름은 `title` 로 내린다).
 *
 * 기본 창 1440 · 패널 펼침(표 폭 1088px)이면 name · uri 가 각 214px 다. 패널을 접으면
 * 323px, 1920 최대화면 455px 로 늘어난다 (실측). 반대로 창 최소폭(1120)까지 줄이면
 * `ROUTE_MIN` 에서 멈추고 가로 스크롤로 넘어간다 — 더 눌러서 토막을 내지 않는다.
 */
const ROUTE_COLS: Col[] = [
  { label: "name" },
  { label: "uri" },
  // 뱃지 하나(`OPTIONS` 63px) + `+N`(29px) + gap 이 들어가는 값이다. 더 줄이면 `+N` 이 잘려
  // 몇 개가 숨었는지를 알 수 없게 된다 (BadgeList 주석 참조).
  { label: "methods", width: "128px" },
  { label: "proxy-rewrite", width: "120px" },
  // 게이트웨이 키 이름(`allowed_groups`)보다 화면에서 부르는 이름을 쓴다 — 편집 화면의
  // 카드 제목(`GroupsCard`)·좌측 패널과 같은 말이어야 같은 것으로 읽힌다. 키는 툴팁에 남긴다.
  { label: "권한그룹", width: "152px", title: "allowed_groups" },
  { label: "status", width: "108px" },
  { label: "수정일시", width: "152px" },
];

/**
 * Consumer 열.
 *
 * secret · key 는 뺐다. 목록에서 훑을 값이 아니고(마스킹된 secret 은 행마다 같은 모양이다)
 * 편집 화면에 그대로 있다. 대신 desc 와 username 을 **각자의 열**로 떼어 둘 다 온전히 보이게
 * 한다 — 한 칸에 나란히 두면 둘이 서로의 폭을 가져간다 (`CellPair` 주석 참조).
 *
 * plugins 열도 뺐다. 값이 `jwt-auth` 하나뿐이라 행을 구별해 주지 못한다. 그 자리를 권한그룹이
 * 쓴다 — 컨슈머 목록에서 실제로 확인해야 하는 것은 인가 범위다.
 */
const CONSUMER_COLS: Col[] = [
  { label: "desc" },
  { label: "username" },
  { label: "권한그룹", width: "152px", title: "auth_groups" },
  { label: "상태", width: "96px" },
  { label: "수정일시", width: "152px" },
];

/**
 * 표의 최소 폭 — 고정 열 합계 + (잘리면 안 되는 열 × 212px).
 *
 * 212px 은 `/api/v1/orders/{orderId}` 정도가 잘리지 않고 들어가는 폭이다. 여기까지 좁아지면
 * 열을 더 누르지 않고 가로 스크롤로 넘긴다 (app.css 의 `.table-scroll`). 기본 창(표 폭 1088px)
 * 에서는 둘 다 이 값보다 넓으므로 스크롤바가 뜨지 않는다.
 */
const ROUTE_MIN = 660 + 212 * 2;
const CONSUMER_MIN = 400 + 212 * 2;

interface ReleaseChipProps {
  /** 어느 축인지 (`consumer` · `권한그룹`) */
  label: string;
  value: string;
  title: string;
  onClear: () => void;
}

/** 지금 걸린 필터를 알려 주고 × 로 풀어 주는 칩. */
function ReleaseChip({ label, value, title, onClear }: ReleaseChipProps) {
  return (
    <div className="chip on" style={{ cursor: "default" }}>
      <span style={{ fontSize: 12 }}>{label}: </span>
      <span className="font-mono" style={{ fontSize: 12 }}>
        {value}
      </span>
      <span className="x" onClick={onClear} style={{ cursor: "pointer" }} title={title}>
        <svg
          viewBox="0 0 24 24"
          width="11"
          height="11"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </span>
    </div>
  );
}

export default function ListScreen() {
  const section = useStore((s) => s.section);
  const env = useStore((s) => s.env);
  const chip = useStore((s) => s.chip);
  const q = useStore((s) => s.q);
  const setQ = useStore((s) => s.setQ);
  const setChip = useStore((s) => s.setChip);
  const newItem = useStore((s) => s.newItem);
  const openItem = useStore((s) => s.openItem);
  const openImport = useStore((s) => s.openImport);
  const hardRefresh = useStore((s) => s.hardRefresh);
  const loading = useStore((s) => s.loading);
  const booting = useStore((s) => s.booting);
  const error = useStore((s) => s.error);
  const settings = useStore((s) => s.settings);
  const syncedAt = useStore((s) => s.syncedAt[s.env]);
  const routeScope = useStore((s) => s.routeScope);
  const setRouteScope = useStore((s) => s.setRouteScope);
  const namePrefix = useStore((s) => s.namePrefix);
  const setNamePrefix = useStore((s) => s.setNamePrefix);
  // 접두사 후보는 Service 의 `labels.name_prefix` 다 — 이미 메모리에 있어 새 IPC 가 없다.
  const services = useStore((s) => s.services);
  // Route 는 내장 SQLite 가 이미 필터링해 준 결과다 (store.ts 모듈 주석 참조).
  const routes = useStore((s) => s.routes);
  const routesTotal = useStore((s) => s.routesTotal);
  const routeCounts = useStore((s) => s.routeCounts);
  const allConsumers = useStore((s) => s.consumers);

  const kind = kindOf(section);
  const isConsumer = kind === "consumer";

  // 새 배열을 만드는 계산이라 스토어 셀렉터가 아니라 useMemo 로 감싼다.
  const consumers = useMemo(
    () => filterConsumers(allConsumers, chip, q),
    [allConsumers, chip, q],
  );

  const cols = isConsumer ? CONSUMER_COLS : ROUTE_COLS;
  const rowCount = isConsumer ? consumers.length : routes.length;

  /**
   * 상단 chip 은 Route 의 status 축 전용이다.
   *
   * Consumer 의 권한그룹 버킷은 좌측 패널이 이미 같은 값을 같은 건수로 보여 주고 있어서,
   * 화면에 두 번 두면 어느 쪽이 켜져 있는지가 오히려 헷갈린다. 대신 고른 그룹만 아래의
   * 해제 칩으로 남긴다 (Route 의 consumer 칩과 같은 이유 — 그 주석 참조).
   */
  /**
   * name 접두사 후보 — Service 에 등록된 `labels.name_prefix` 를 모은다.
   *
   * route 명에서 역산하지 않는다. 접두어는 service 단위로 **정해 둔 규약**이고
   * (`ServiceForm` 의 'name 접두어'), 이름에서 첫 구분자 앞을 잘라 모으면 규약이 아닌
   * 우연한 조각까지 후보로 올라온다. 규약에 없는 값이 필요하면 직접 입력하면 된다.
   */
  const prefixOptions = useMemo(
    () =>
      Array.from(
        new Set(services.map((v) => v.namePrefix.trim()).filter(Boolean)),
      ).sort(),
    [services],
  );

  const chipKeys: Array<[string, string]> = useMemo(
    () =>
      isConsumer
        ? []
        : [
            // 건수는 캐시가 돌려준 값이다 — 검색어는 반영하고 chip 은 빼서 계산한다.
            ["all", `전체 (${routeCounts.all})`],
            ["on", `status 1 (${routeCounts.on})`],
            ["off", `status 0 (${routeCounts.off})`],
          ],
    [isConsumer, routeCounts],
  );

  // 좌측 패널에서 걸어 둔 조건을 본문에도 남긴다. 두 화면이 서로 다른 축을 쓰지만
  // (Consumer 는 chip, Route 는 조회 범위) 사용자에게는 같은 "지금 걸린 필터" 다.
  const release: ReleaseChipProps | null = isConsumer
    ? chip === "all"
      ? null
      : {
          label: "권한그룹",
          value: chip === NO_GROUP ? "(그룹 없음)" : chip,
          title: "권한그룹 필터 해제",
          onClear: () => setChip("all"),
        }
    : scopeLabel(routeScope)
      ? {
          // 컨슈머 한 명이면 그 이름을, '그룹 제한 없음' 이면 그 이름을 그대로 보여 준다.
          label: routeScope.kind === "consumer" ? "consumer" : "범위",
          value: scopeLabel(routeScope)!,
          title: "조회 범위 해제",
          onClear: () => setRouteScope(ALL_ROUTES),
        }
      : null;

  // 접두사는 조회 범위와 별개 축이라 해제 칩도 따로 낸다 (둘 다 켜질 수 있다).
  const prefixRelease: ReleaseChipProps | null =
    !isConsumer && namePrefix.trim() !== ""
      ? {
          label: "name 접두사",
          value: namePrefix.trim(),
          title: "name 접두사 필터 해제",
          onClear: () => setNamePrefix(""),
        }
      : null;

  const adminBase = settings?.[env]?.adminBase ?? "";
  const listApiPath = `${adminBase}/${isConsumer ? "consumers" : "routes"}`;

  // 화면 진입이 더 이상 게이트웨이를 부르지 않으므로 "등록된 …가 없습니다" 만으로는
  // "게이트웨이에 없다" 와 "캐시를 아직 못 채웠다" 를 구별할 수 없다. 네 경우를 나눈다.
  // 조건 판정에 조회 범위를 반드시 포함해야 한다 — 빠뜨리면 컨슈머를 골라 0건이 됐을 때
  // "등록된 Route가 없습니다" 가 뜬다.
  const filtered =
    q.trim() !== "" ||
    chip !== "all" ||
    (!isConsumer && (routeScope.kind !== "all" || namePrefix.trim() !== ""));
  const emptyState =
    loading || booting ? (
      <>
        <div className="spinner" />
        <div className="msg">동기화 중…</div>
      </>
    ) : error ? (
      <div className="msg">목록을 불러오지 못했습니다. 새로고침으로 다시 시도하세요.</div>
    ) : syncedAt == null ? (
      <>
        <div className="msg">아직 게이트웨이와 동기화하지 않았습니다.</div>
        <button className="btn sm outline" onClick={() => void hardRefresh()}>
          새로고침
        </button>
      </>
    ) : filtered ? (
      <div className="msg">조건에 맞는 항목이 없습니다.</div>
    ) : (
      <div className="msg">등록된 {isConsumer ? "Consumer" : "Route"}가 없습니다.</div>
    );

  return (
    <div data-screen-label="목록" style={{ padding: "24px 28px 48px" }}>
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div>
          <h2 className="page-title" style={{ fontSize: 24, lineHeight: "32px" }}>
            {isConsumer ? "Consumer" : "Route"}
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
          <button
            className="icon-btn"
            title="게이트웨이에서 Route · Consumer 전체 목록을 다시 조회해 로컬 캐시를 갱신합니다"
            onClick={() => void hardRefresh()}
            disabled={loading || booting}
          >
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
          {!isConsumer && (
            <button className="btn md outline" onClick={openImport}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 3v12M7 10l5 5 5-5" />
                <path d="M4 19h16" />
              </svg>
              Import
            </button>
          )}
          {!isConsumer && (
            // 검색어와 **다른 축**이라 검색창과 나란히 둔다 — 하나로 합치면 '포함' 과
            // '시작' 두 규칙이 한 칸에 섞인다.
            <div style={{ display: "flex", width: 200, height: 36 }}>
              <GroupCombo
                className="text-input font-mono"
                value={namePrefix}
                onChange={setNamePrefix}
                onCommit={setNamePrefix}
                options={prefixOptions}
                placeholder="name 접두사"
                ariaLabel="name 접두사로 필터"
                // 옆의 검색창 · Import 버튼과 같은 36px 로 맞춘다 (.text-input 기본은 40px).
                inputStyle={{ height: 36 }}
              />
            </div>
          )}
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
              placeholder={isConsumer ? "desc · username · key 검색" : "name · uri 검색"}
              value={q}
              onChange={(e) => setQ(e.target.value)}
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
            {isConsumer ? "신규 Consumer" : "신규 Route"}
          </button>
        </div>
      </div>

      {(chipKeys.length > 0 || release || prefixRelease) && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {chipKeys.map(([k, label]) => (
            <div
              key={k}
              className={"chip" + (chip === k ? " on" : "")}
              onClick={() => setChip(k)}
            >
              {label}
            </div>
          ))}

          {/* 좌측 패널을 스크롤로 지나친 사용자가 목록이 왜 짧은지 알 수 없으면 안 된다. */}
          {release && <ReleaseChip {...release} />}
          {prefixRelease && <ReleaseChip {...prefixRelease} />}
        </div>
      )}

      {error && (
        <div
          className="card-surface"
          style={{
            padding: "16px 20px",
            marginBottom: 16,
            background: "var(--red-50)",
            borderColor: "var(--red-200)",
          }}
        >
          <div style={{ font: "500 13px/20px var(--font-sans)", color: "var(--red-700)" }}>
            {error.message}
          </div>
          {error.hint && (
            <div
              className="text-sm"
              style={{ color: "var(--red-700)", opacity: 0.85, marginTop: 4 }}
            >
              {error.hint}
            </div>
          )}
        </div>
      )}

      {/* 표만 감싼다 — 좁은 창에서 가로 스크롤이 나도 위의 제목·검색 줄은 제자리에 있다. */}
      <div className="table-scroll">
        <table
          className="kw-table one-line"
          style={{ minWidth: isConsumer ? CONSUMER_MIN : ROUTE_MIN }}
        >
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.label} style={{ width: c.width }} title={c.title ?? c.label}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          {/* 두 엔티티의 열이 더는 같은 모양이 아니라 행도 각자 그린다 — 한 벌의 `<td>` 에
              양쪽 값을 끼워 맞추면 열을 하나 옮길 때마다 두 화면을 같이 봐야 한다. */}
          <tbody>
            {isConsumer
              ? consumers.map((c) => (
                  <tr
                    key={c.username}
                    onClick={() => openItem(c.username)}
                    style={{ cursor: "pointer" }}
                  >
                    {/* 사람이 목록에서 찾는 것은 식별자가 아니라 설명이다 — 앞자리에 둔다. */}
                    <td className="name" style={{ padding: ROW_H }}>
                      <Cell text={c.desc || "(설명 없음)"} />
                    </td>
                    {/* username 은 APISIX 식별자이자 상세 화면의 열쇠라 온전히 보여야 한다. */}
                    <td className="mono" style={{ padding: ROW_H }}>
                      <Cell text={c.username} />
                    </td>
                    <td style={{ padding: ROW_H }}>
                      <BadgeList items={c.groups} variant="primary" />
                    </td>
                    <td style={{ padding: ROW_H }}>
                      <span className="badge success">
                        <span className="dot" />
                        사용 중
                      </span>
                    </td>
                    <td className="mono" style={{ padding: ROW_H }}>
                      <Cell text={c.updated} />
                    </td>
                  </tr>
                ))
              : routes.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => openItem(r.id)}
                    style={{ cursor: "pointer" }}
                  >
                    {/* service_id 는 뺐다 — 같은 칸에 두면 name 의 폭을 가져간다. 어느 service
                        소속인지는 name 접두사 필터와 편집 화면이 답해 준다. */}
                    <td className="name" style={{ padding: ROW_H }}>
                      <Cell text={r.name || "(이름 없음)"} />
                    </td>
                    <td className="mono" style={{ padding: ROW_H }}>
                      <Cell text={r.uri} />
                    </td>
                    <td style={{ padding: ROW_H }}>
                      <BadgeList items={r.methods} mono />
                    </td>
                    {/* regex_uri 를 그리지 않으면 그 route 만 빈칸으로 보인다 (`rewriteText`). */}
                    <td className="mono" style={{ padding: ROW_H }}>
                      <Cell text={rewriteText(r) || "—"} />
                    </td>
                    <td style={{ padding: ROW_H }}>
                      {/* 빈 칸으로 두면 "아무도 접근 못 하는 라우트"(권한그룹 0건)와
                          "누구나 접근하는 라우트"(권한 플러그인 없음)가 같아 보인다.
                          목록에서 반드시 구별돼야 하는 차이라 뱃지로 말한다. */}
                      {r.hasAuth ? (
                        <BadgeList items={r.groups} variant="primary" />
                      ) : (
                        <span
                          className="badge warning"
                          title="plugins · shi-auth 가 없습니다 — 권한 검사 없이 호출할 수 있습니다"
                        >
                          <span className="dot" />
                          전체 허용
                        </span>
                      )}
                    </td>
                    <td style={{ padding: ROW_H }}>
                      <span className={"badge " + (r.status === 1 ? "success" : "neutral")}>
                        <span className="dot" />
                        {r.status === 1 ? "1 · 활성" : "0 · 비활성"}
                      </span>
                    </td>
                    <td className="mono" style={{ padding: ROW_H }}>
                      <Cell text={r.updated} />
                    </td>
                  </tr>
                ))}

            {rowCount === 0 && (
              <tr>
                <td colSpan={cols.length} style={{ padding: 0 }}>
                  <div className="state-block">{emptyState}</div>
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
        <span>총 {isConsumer ? consumers.length : routesTotal}건</span>
        <span className="selectable">GET {listApiPath}</span>
      </div>
    </div>
  );
}
