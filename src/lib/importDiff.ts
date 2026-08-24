/**
 * Import 비교 결과에서 **등록된 API 한 건**을 눌렀을 때의 "스펙 적용본 vs 게이트웨이 저장분".
 *
 * # 무엇을 비교하는가
 *
 * 스펙 쪽 후보값은 **전부 Rust 가 계산해 `CompareRow` 에 실어 보낸 것**을 그대로 쓴다
 * (`oas::suggested_name` · `oas::to_apisix_uri`). 여기서 uri·이름 규칙을 다시 구현하면
 * 반드시 어긋난다 — `types.ts` 의 `routeFormFromOas` 주석과 같은 이유다.
 *
 * 기존 쪽은 `routeToForm(RouteView)` 이고, 양쪽 모두 최종적으로 `design.routeJson` 이라는
 * **같은 직렬화 함수**를 통과한다. 그래서 두 본문의 키 순서가 같고 줄 단위 diff 가 깨끗하다.
 *
 * # API 의 단위는 (path, method) 다
 *
 * `GET /test` 와 `POST /test` 는 서로 다른 API 이고 각각 따로 처리한다 (`CompareRow` 가 이미
 * 그 단위다). 다만 게이트웨이의 route 객체 하나가 두 API 를 함께 처리할 수 있으므로,
 * `methods` 는 **포함 여부**로 판정한다 — "이 API 가 이 route 에 올라와 있는가". route 에
 * 남는 다른 메서드는 옆 API 의 몫이지 이 API 의 차이가 아니다. (게이트웨이가 `methods` 키를
 * 아예 갖고 있지 않으면 APISIX 는 전 메서드를 허용하므로 이것도 '올라와 있음' 이다 —
 * `db::compare` 의 `method_ok` 와 같은 규칙이다.)
 *
 * # 손대지 않는 값
 *
 * `status` · `service_id` · `allowed_groups`(+`groupsLocation`) 는 스펙에 없는 값이라
 * 후보를 만들지 않는다. 두 본문에 똑같이 실려 diff 에서 조용히 지나간다.
 */

import { sortMethods } from "./design";
import { specDesc } from "../types";
import type { CompareRow, RouteFormState } from "../types";

/** `methods` 만 3지 선택이다 — 왜인지는 아래 `diffFields` 주석 참조. */
export type MethodChoice = "keep" | "add" | "replace";

export interface DiffSelection {
  name: boolean;
  uri: boolean;
  rewrite: boolean;
  desc: boolean;
  methods: MethodChoice;
}

/** 체크박스로 다루는 키 — `methods` 만 3지 선택이라 빠져 있다. */
export type FlagKey = "name" | "uri" | "rewrite" | "desc";

export type DiffKey = keyof DiffSelection;

/** 기본값 — **아무것도 적용하지 않는다.** */
export const NO_SELECTION: DiffSelection = {
  name: false,
  uri: false,
  rewrite: false,
  desc: false,
  methods: "keep",
};

export interface DiffField {
  key: FlagKey | "methods";
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

/** 이 API 가 route 에 올라와 있는가 — `db::compare` 의 `method_ok` 와 같은 규칙. */
export const methodOnRoute = (base: RouteFormState, method: string): boolean =>
  base.methods.length === 0 || base.methods.includes(method);

/**
 * 같은 route 를 가리키는 **다른** 스펙 API 들.
 *
 * 게이트웨이 route 하나가 여러 스펙 API 를 처리하고 있으면 uri 를 좁히거나 methods 를
 * 교체하는 순간 그 API 들이 끊긴다. 경고를 붙이기 위해 세어 둔다.
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

/**
 * 필드별 차이.
 *
 * `methods` 만 체크박스가 아니라 3지 선택인 이유: (path, method) = API 라는 원칙을 그대로
 * 따르면 `GET /test` 의 후보는 `["GET"]` 인데, 같은 route 가 스펙의 `POST /test` 도 처리하고
 * 있으면 그걸 그대로 덮어쓰는 순간 옆 API 가 조용히 끊긴다. 그래서 '이 메서드 추가'(옆 API 를
 * 지키면서 이 API 를 올린다) 와 '스펙대로 교체'(정말로 이 메서드만 남긴다) 를 나눠 두고,
 * 교체 쪽에는 무엇을 잃는지 경고를 붙인다.
 */
export function diffFields(
  row: CompareRow,
  base: RouteFormState,
  rows: CompareRow[],
): DiffField[] {
  const siblings = siblingOps(row, rows);
  const nextDesc = specDesc(row);

  const uriSame = base.uri === row.suggestedUri;
  // uri 가 달라도 '등록' 으로 판정됐다는 것은 현재 uri 가 이미 이 경로를 매칭한다는 뜻이다.
  // 그 사실을 말해 주지 않으면 `:petId` 를 쓰는 멀쩡한 route 가 전부 '고쳐야 할 것' 처럼 보인다.
  const uriNote = uriSame
    ? undefined
    : row.wildcard
      ? "표기 차이 — 현재 uri 가 와일드카드로 이 경로를 이미 매칭하고 있습니다."
      : "표기 차이 — 현재 uri 도 이 경로에 매칭됩니다 (그래서 '등록' 으로 판정됐습니다).";

  const uriWarns: string[] = [];
  if (base.uri.includes(",")) {
    const n = base.uri.split(",").filter((s) => s.trim()).length;
    uriWarns.push(`현재 route 는 uri 를 ${n}개 갖고 있습니다 (uris 배열). 적용하면 하나로 줄어듭니다.`);
  }
  if (!uriSame && siblings.length > 0) {
    uriWarns.push(`이 route 는 스펙의 다른 API (${opsLabel(siblings)}) 도 매칭하고 있습니다. uri 를 바꾸면 그 매칭이 깨질 수 있습니다.`);
  }

  const methodsSame = methodOnRoute(base, row.method);
  const methodsWarn =
    siblings.length > 0
      ? `'스펙대로 교체' 를 고르면 이 route 가 처리하던 다른 API (${opsLabel(siblings)}) 가 게이트웨이에서 끊깁니다.`
      : undefined;

  const fields: DiffField[] = [
    {
      key: "name",
      label: "name",
      current: show(base.name),
      next: show(row.suggestedName),
      same: base.name === row.suggestedName,
    },
    {
      key: "uri",
      label: "uri",
      current: show(base.uri),
      next: show(row.suggestedUri),
      same: uriSame,
      note: uriNote,
      warn: uriWarns.length > 0 ? uriWarns.join(" ") : undefined,
    },
    {
      key: "rewrite",
      label: "plugins.proxy-rewrite.uri",
      current: show(base.rewrite),
      next: show(row.suggestedRewrite),
      same: base.rewrite === row.suggestedRewrite,
      note:
        base.rewrite.trim() === "" && row.suggestedRewrite.trim() !== ""
          ? "현재 proxy-rewrite 가 없습니다 — 적용하면 새로 추가됩니다."
          : undefined,
    },
    {
      key: "methods",
      label: "methods",
      current:
        base.methods.length > 0
          ? base.methods.join(", ")
          : "(없음 — APISIX 가 전 메서드를 허용합니다)",
      next: row.method,
      same: methodsSame,
      note: methodsSame
        ? undefined
        : "이 API 의 메서드가 route 에 올라와 있지 않습니다 ('메서드 불일치').",
      warn: methodsWarn,
    },
    {
      key: "desc",
      label: "desc",
      current: show(base.desc),
      next: show(nextDesc),
      same: base.desc === nextDesc,
    },
  ];

  return fields;
}

export const hasDiff = (fields: DiffField[]): boolean => fields.some((f) => !f.same);

/** 선택이 하나라도 있는가 — 없으면 저장할 것이 없다 (빈 PUT 을 보내지 않는다). */
export const hasSelection = (sel: DiffSelection): boolean =>
  sel.name || sel.uri || sel.rewrite || sel.desc || sel.methods !== "keep";

/**
 * "차이 전부 선택".
 *
 * `methods` 는 **`add`** 를 고른다 — 이 API 를 올리면서 옆 API 를 지키는 쪽이고,
 * `replace` 는 무엇을 잃는지 읽고 나서 고르는 선택지다.
 */
export function allChanges(fields: DiffField[]): DiffSelection {
  const changed = (k: DiffKey): boolean => fields.some((f) => f.key === k && !f.same);
  return {
    name: changed("name"),
    uri: changed("uri"),
    rewrite: changed("rewrite"),
    desc: changed("desc"),
    methods: changed("methods") ? "add" : "keep",
  };
}

/**
 * 고른 것만 기존 폼에 얹는다.
 *
 * `...base` 로 시작하므로 `id` · `serviceId` · `status` · `groups` · `groupsLocation` 은
 * 그대로 남는다 — 결과가 곧 `store.save()` 가 그대로 쓰는 `RouteFormState` 다.
 */
export function applySelection(
  base: RouteFormState,
  row: CompareRow,
  sel: DiffSelection,
): RouteFormState {
  return {
    ...base,
    name: sel.name ? row.suggestedName : base.name,
    uri: sel.uri ? row.suggestedUri : base.uri,
    rewrite: sel.rewrite ? row.suggestedRewrite : base.rewrite,
    desc: sel.desc ? specDesc(row) : base.desc,
    methods:
      sel.methods === "add"
        ? // 표준 외 메서드를 떨어뜨리지 않고 표준 순서로 정렬한다 (design.sortMethods).
          sortMethods([...base.methods, row.method])
        : sel.methods === "replace"
          ? [row.method]
          : [...base.methods],
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
