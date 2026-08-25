/**
 * Import 비교 결과의 "스펙 적용본 vs 게이트웨이 저장분".
 *
 * 두 곳이 같은 함수를 쓴다:
 *   · 비교 결과 표 — 등록된 건이 스펙과 값까지 같은지 (`rowVerdict` · `changedKeys`)
 *   · diff 화면    — 필드별 차이와 무엇을 적용할지 (`diffFields` · `applySelection`)
 * 두 판정이 갈리면 표에는 `일치` 인데 눌러 보니 diff 가 있는(또는 그 반대) 일이 벌어진다.
 *
 * # 무엇을 비교하는가
 *
 * 스펙 쪽 후보값은 **전부 Rust 가 계산해 `CompareRow` 에 실어 보낸 것**을 그대로 쓴다
 * (`oas::suggested_name_for` · `oas::to_apisix_uri`). 여기서 uri·이름 규칙을 다시 구현하면
 * 반드시 어긋난다 — `types.ts` 의 `routeFormFromOas` 주석과 같은 이유다.
 *
 * 기존 쪽(`RouteAttrs`)은 두 경로로 들어온다. 표는 `CompareRow` 의 `route*` 값
 * (Rust 가 캐시의 `RouteView` 를 그대로 옮긴 것), diff 화면은 `routeToForm(RouteView)` 다.
 * 같은 캐시의 같은 값이라 두 경로가 어긋나지 않는다.
 *
 * diff 화면의 두 본문은 `design.routeJson` 이라는 **같은 직렬화 함수**를 통과한다.
 * 그래서 키 순서가 같고 줄 단위 diff 가 깨끗하다.
 *
 * # API 의 단위는 (path, method) 다
 *
 * `GET /test` 와 `POST /test` 는 서로 다른 API 이고 각각 따로 처리한다 (`CompareRow` 가 이미
 * 그 단위다). 그래서 `methods` 는 이 화면의 비교 대상이 **아니다** — 이 메서드를 받지 않는
 * route 는 애초에 이 API 의 대상 route 가 아니라 `미등록` 으로 판정된다 (`db::compare`).
 * 대상 route 에 남는 다른 메서드는 옆 API 의 몫이다.
 *
 * # 손대지 않는 값
 *
 * `methods` · `status` · `service_id` · `allowed_groups`(+`groupsLocation`) 는 스펙에 없거나
 * 이 API 의 차이가 아니라 후보를 만들지 않는다. 두 본문에 똑같이 실려 diff 에서 조용히 지나간다.
 */

import { rewriteText, specDesc, specRewrite } from "../types";
import type { CompareRow, RewriteMode, RouteFormState } from "../types";

/** 스펙과 대조하는 네 필드. 체크박스 하나가 한 필드다. */
export type FlagKey = "name" | "uri" | "rewrite" | "desc";

export const FLAG_KEYS: FlagKey[] = ["name", "uri", "rewrite", "desc"];

export type DiffSelection = Record<FlagKey, boolean>;

export type DiffKey = FlagKey;

/** **아무것도 적용하지 않는다** — '전부 해제' 버튼과 화면을 벗어날 때의 초기값. */
export const NO_SELECTION: DiffSelection = {
  name: false,
  uri: false,
  rewrite: false,
  desc: false,
};

/**
 * 대조에 쓰는 route 속성값.
 *
 * `RouteFormState` 가 구조적으로 이 모양을 만족하므로 diff 화면은 폼을 그대로 넘긴다.
 * 비교 결과 표는 `attrsOfRow` 로 `CompareRow` 에서 만든다.
 */
export interface RouteAttrs {
  name: string;
  uri: string;
  /** `proxy-rewrite.uri` — regex 모드면 빈 문자열이다 */
  rewrite: string;
  /** `proxy-rewrite.regex_uri` — uri 모드면 빈 배열이다 */
  rewriteRegex: string[];
  desc: string;
}

/** 대상 route 에 **지금 저장돼 있는** 값 (Rust 가 캐시에서 실어 보낸 것). */
export const attrsOfRow = (row: CompareRow): RouteAttrs => ({
  name: row.routeName,
  uri: row.routeUri,
  rewrite: row.routeRewrite,
  rewriteRegex: row.routeRewriteRegex,
  desc: row.routeDesc,
});

/** 스펙이 제안하는 값. `desc` 만 여기서 만들고 나머지는 Rust 가 계산한 것이다. */
export const specAttrs = (row: CompareRow): RouteAttrs => {
  // 프리필(`routeFormFromOas`)과 **같은 함수**로 모드를 정한다. 두 곳에서 각자 정하면
  // "신규로 만든 값" 과 "적용하겠다고 보여 준 값" 이 달라진다.
  const rw = specRewrite(row);
  return {
    name: row.suggestedName,
    uri: row.suggestedUri,
    rewrite: rw.rewrite,
    rewriteRegex: rw.rewriteRegex,
    desc: specDesc(row),
  };
};

/**
 * `rewrite` 한 축의 비교 — `uri` 와 `regex_uri` 를 **함께** 본다.
 *
 * 체크박스는 계속 하나다. 두 키는 게이트웨이에서 한쪽만 살아 있는 값이라 서로 갈아 끼우는
 * 관계이지 나란한 필드가 아니다. 따로 두면 "uri 만 지우고 regex 는 안 넣는" 선택이 가능해져
 * rewrite 가 통째로 사라지는 상태를 만들 수 있다.
 */
const sameRewrite = (a: RouteAttrs, b: RouteAttrs): boolean =>
  a.rewrite === b.rewrite &&
  a.rewriteRegex.length === b.rewriteRegex.length &&
  a.rewriteRegex.every((v, i) => v === b.rewriteRegex[i]);

/** 스펙과 다른 필드. 표의 판정과 diff 화면이 **이 한 함수**만 본다. */
export const changedKeys = (row: CompareRow, cur: RouteAttrs): FlagKey[] => {
  const next = specAttrs(row);
  return FLAG_KEYS.filter((k) =>
    k === "rewrite" ? !sameRewrite(cur, next) : cur[k] !== next[k],
  );
};

/** 어느 키로 저장되는가 — diff 행의 label 에 쓴다. */
const rewriteModeIn = (a: Pick<RouteAttrs, "rewriteRegex">): RewriteMode =>
  a.rewriteRegex.length >= 2 ? "regex" : "uri";

/**
 * 비교 결과 표의 판정.
 *
 * Rust 의 `state`(등록/미등록) 위에 '속성 차이' 를 얹은 것이다. 등록됐다고만 알려 주면
 * "그래서 스펙과 같은가"를 행마다 눌러 봐야 알 수 있어서, 그 답을 표에서 바로 보여 준다.
 */
export type RowVerdict = "same" | "attrDiff" | "unregistered";

export function rowVerdict(row: CompareRow): RowVerdict {
  if (row.state === "unregistered") return "unregistered";
  return changedKeys(row, attrsOfRow(row)).length > 0 ? "attrDiff" : "same";
}

export interface DiffField {
  key: FlagKey;
  /** 요청 본문에서의 자리 (`plugins.proxy-rewrite.uri` 처럼 실제 경로로 적는다) */
  label: string;
  current: string;
  next: string;
  same: boolean;
  /** 차이의 성격을 설명하는 안내 */
  note?: string;
  /** 적용하면 무언가를 잃는다는 경고 */
  warn?: string;
}

const NONE = "(없음)";

const show = (v: string): string => (v.trim() === "" ? NONE : v);

/**
 * 같은 route 를 가리키는 **다른** 스펙 API 들.
 *
 * 게이트웨이 route 하나가 여러 스펙 API 를 처리하고 있으면 uri 를 좁히는 순간 그 API 들이
 * 끊긴다. 경고를 붙이기 위해 세어 둔다.
 */
export function siblingOps(row: CompareRow, rows: CompareRow[]): CompareRow[] {
  if (!row.routeId) return [];
  return rows.filter(
    (r) => r.routeId === row.routeId && !(r.path === row.path && r.method === row.method),
  );
}

/** `GET /pets · POST /pets` — 경고 문구에 끼워 넣을 목록 (길면 줄인다). */
function opsLabel(ops: CompareRow[]): string {
  const head = ops.slice(0, 3).map((o) => `${o.method} ${o.fullPath}`).join(" · ");
  return ops.length > 3 ? `${head} 외 ${ops.length - 3}건` : head;
}

/** 필드별 차이 — diff 화면의 표와 '적용 후' 본문이 이것을 쓴다. */
export function diffFields(
  row: CompareRow,
  cur: RouteAttrs,
  rows: CompareRow[],
): DiffField[] {
  const siblings = siblingOps(row, rows);
  const next = specAttrs(row);

  const uriSame = cur.uri === next.uri;
  // uri 가 달라도 '등록' 으로 판정됐다는 것은 현재 uri 가 이미 이 경로를 매칭한다는 뜻이다.
  // 그 사실을 말해 주지 않으면 `:petId` 를 쓰는 멀쩡한 route 가 전부 '고쳐야 할 것' 처럼 보인다.
  const uriNote = uriSame
    ? undefined
    : row.wildcard
      ? "표기 차이 — 현재 uri 가 와일드카드로 이 경로를 이미 매칭하고 있습니다."
      : "표기 차이 — 현재 uri 도 이 경로에 매칭됩니다 (그래서 '등록' 으로 판정됐습니다).";

  const rewriteSame = !changedKeys(row, cur).includes("rewrite");
  const curMode = rewriteModeIn(cur);
  const nextMode = rewriteModeIn(next);
  const rewriteEmpty = cur.rewrite.trim() === "" && cur.rewriteRegex.length < 2;
  const rewriteNote = rewriteSame
    ? undefined
    : rewriteEmpty
      ? "현재 proxy-rewrite 가 없습니다 — 적용하면 새로 추가됩니다."
      : curMode !== nextMode
        ? nextMode === "regex"
          ? "`uri` 에서 `regex_uri` 로 바뀝니다 — 경로 파라미터를 upstream 으로 넘기려면 " +
            "정규식 캡처가 필요합니다 (`uri` 는 정적 문자열이라 `{}` 를 치환하지 못합니다)."
          : "`regex_uri` 에서 `uri` 로 바뀝니다 — 이 경로에는 파라미터가 없습니다."
        : undefined;

  const uriWarns: string[] = [];
  if (cur.uri.includes(",")) {
    const n = cur.uri.split(",").filter((s) => s.trim()).length;
    uriWarns.push(`현재 route 는 uri 를 ${n}개 갖고 있습니다 (uris 배열). 적용하면 하나로 줄어듭니다.`);
  }
  if (!uriSame && siblings.length > 0) {
    uriWarns.push(`이 route 는 스펙의 다른 API (${opsLabel(siblings)}) 도 매칭하고 있습니다. uri 를 바꾸면 그 매칭이 깨질 수 있습니다.`);
  }

  return [
    {
      key: "name",
      label: "name",
      current: show(cur.name),
      next: show(next.name),
      same: cur.name === next.name,
    },
    {
      key: "uri",
      label: "uri",
      current: show(cur.uri),
      next: show(next.uri),
      same: uriSame,
      note: uriNote,
      warn: uriWarns.length > 0 ? uriWarns.join(" ") : undefined,
    },
    {
      key: "rewrite",
      // 저장되는 키가 무엇인지 label 이 말해 준다 — 둘은 나란한 필드가 아니라 배타적이다.
      label: `plugins.proxy-rewrite.${rewriteModeIn(next) === "regex" ? "regex_uri" : "uri"}`,
      current: show(rewriteText(cur)),
      next: show(rewriteText(next)),
      same: rewriteSame,
      note: rewriteNote,
    },
    {
      key: "desc",
      label: "desc",
      current: show(cur.desc),
      next: show(next.desc),
      same: cur.desc === next.desc,
    },
  ];
}

export const hasDiff = (fields: DiffField[]): boolean => fields.some((f) => !f.same);

/** 선택이 하나라도 있는가 — 없으면 저장할 것이 없다 (빈 PUT 을 보내지 않는다). */
export const hasSelection = (sel: DiffSelection): boolean => FLAG_KEYS.some((k) => sel[k]);

/**
 * "차이 전부 선택".
 *
 * diff 화면에 처음 들어갈 때의 기본값이기도 하다 (`store.openRouteFromImport`) —
 * 이 화면까지 온 이유가 "스펙대로 맞추겠다" 라서, 빼고 싶은 것만 해제하는 편이 짧다.
 * 무엇을 잃는지에 대한 경고는 해당 행에 그대로 남는다.
 */
export function allChanges(fields: DiffField[]): DiffSelection {
  const changed = (k: DiffKey): boolean => fields.some((f) => f.key === k && !f.same);
  return { name: changed("name"), uri: changed("uri"), rewrite: changed("rewrite"), desc: changed("desc") };
}

/**
 * 고른 것만 기존 폼에 얹는다.
 *
 * `...base` 로 시작하므로 `id` · `methods` · `serviceId` · `status` · `groups` ·
 * `groupsLocation` 은 그대로 남는다 — 결과가 곧 `store.save()` 가 그대로 쓰는
 * `RouteFormState` 다.
 */
export function applySelection(
  base: RouteFormState,
  row: CompareRow,
  sel: DiffSelection,
): RouteFormState {
  const next = specAttrs(row);
  return {
    ...base,
    name: sel.name ? next.name : base.name,
    uri: sel.uri ? next.uri : base.uri,
    // 세 값을 **함께** 얹는다. 하나만 바꾸면 `uri` 와 `regex_uri` 가 공존하는 폼이 되고,
    // APISIX 는 `uri` 를 우선하므로 화면에 보이는 regex 가 조용히 죽는다.
    ...(sel.rewrite
      ? specRewrite(row)
      : {
          rewrite: base.rewrite,
          rewriteMode: base.rewriteMode,
          rewriteRegex: base.rewriteRegex,
        }),
    desc: sel.desc ? next.desc : base.desc,
  };
}

// ── 줄 단위 diff ─────────────────────────────────────────────
//
// 라이브러리를 넣지 않는다. 이 저장소의 프런트 의존성은 9개뿐이고 오프라인 단일 exe 로
// 배포되므로, 40줄이면 되는 것을 위해 패키지를 늘리는 것은 명백한 이탈이다.
// 두 본문은 같은 `routeJson` 이 만든 수십 줄짜리라 O(n·m) LCS 로 충분하다.

export type DiffLineKind = "same" | "del" | "add";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = a[i..] 와 b[j..] 의 최장 공통 부분수열 길이
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      // 지운 줄을 먼저 내보낸다 — 같은 자리의 -/+ 가 붙어 보인다.
      out.push({ kind: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: "del", text: a[i] });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: "add", text: b[j] });
    j += 1;
  }
  return out;
}
