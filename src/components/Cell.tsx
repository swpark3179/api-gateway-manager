/**
 * 목록 그리드의 한 줄 셀.
 *
 * 그리드는 `.kw-table.one-line` 으로 `table-layout: fixed` 를 쓴다 (app.css 참조).
 * 열 폭이 확정되므로 셀은 **무조건 한 줄**이고, 넘치는 값은 `…` 로 잘린다.
 * 잘린 부분을 확인할 방법은 남겨야 하므로 툴팁을 함께 건다.
 *
 * 툴팁은 앱의 기존 관례인 네이티브 `title` 이다 (`SidePanel` · `IconRail` 과 같다).
 * 잘렸는지를 재서 조건부로 달지 않는다 — 폭이 바뀔 때마다 실측해야 하고, 안 잘린 값에
 * 툴팁이 떠도 해가 없다. `SidePanel` 의 항목 라벨이 이미 같은 판단을 하고 있다.
 *
 * 글꼴·색은 `<td>` 의 클래스(`mono` · `text-xs muted`)가 그대로 정한다 — 여기서 다시
 * 정하면 열마다 두 군데를 맞춰야 한다.
 */

/** 한 줄 텍스트 셀 — 넘치면 … 로 자르고 툴팁에 전체를 보여준다. */
export function Cell({ text }: { text: string }) {
  return (
    <span className="cell-1" title={text}>
      {text}
    </span>
  );
}

interface CellPairProps {
  /** 사람이 목록에서 눈으로 찾는 값 (name · desc) */
  main: string;
  /** 그 값을 특정해 주는 보조 식별자 (service_id · username · desc) */
  sub?: string;
  /** 주값이 식별자라 고정폭이 읽기 편할 때 (`.name` 대신 `.mono`) */
  mono?: boolean;
}

/**
 * 주값 + 보조값을 **한 줄에 나란히**.
 *
 * 예전에는 위아래 두 줄로 쌓았는데, 그것만으로 행 높이가 두 배가 된다. 보조값을 버리면
 * 목록에서 service_id 를 훑을 수 없으니 (ListScreen 의 c1sub 주석 참조) 같은 줄로 옮긴다.
 * 폭이 모자라면 보조값부터 `…` 로 줄고, 툴팁에는 둘을 이어 붙여 보여 준다.
 */
export function CellPair({ main, sub, mono }: CellPairProps) {
  return (
    <span className="cell-line" title={sub ? `${main} · ${sub}` : main}>
      <span className={"t " + (mono ? "mono" : "name")}>{main}</span>
      {sub && <span className="t sub">{sub}</span>}
    </span>
  );
}
