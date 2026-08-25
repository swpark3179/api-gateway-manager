/**
 * 뱃지 여러 개를 **한 줄에** 그린다 (methods · allowed_groups · plugins).
 *
 * 예전에는 `flexWrap: wrap` 이라 값이 많은 행만 두 줄, 세 줄로 늘어났다. 목록을 위아래로
 * 훑을 때 행 높이가 제각각이면 눈이 걸린다. 그래서 줄바꿈을 막고, 넘치는 만큼은 `+N` 뱃지
 * 하나로 접은 뒤 툴팁에 전체를 나열한다.
 *
 * 폭을 실측하지 않고 **개수 상한**으로 자른다. 여기 오는 값은 methods(최대 7개, GET·POST 처럼
 * 짧다) · allowed_groups(보통 한둘) · plugins(jwt-auth 하나)라 상한만으로 충분하고,
 * ResizeObserver 로 열 폭을 따라다닐 만큼의 이득이 없다.
 *
 * 기본 1개인 이유: 이 열들은 헤더 라벨 폭에 맞춰 100~160px 로 잡혀 있다. 둘을 넣으면
 * 창이 좁을 때 둘 다 `G…` `PO…` 처럼 읽을 수 없는 토막이 되는데, 그럴 바에는 하나를
 * 온전히 보여 주고 나머지를 `+N` 으로 세는 편이 낫다. 값이 하나뿐인 흔한 경우
 * (methods 한 개 · jwt-auth 하나)에는 예전과 똑같이 보인다.
 *
 * 그래도 폭이 모자라면 값 뱃지가 먼저 `…` 로 줄고 `+N` 은 남는다 (app.css 의 `.badge-row`).
 * 여유가 있는 열이면 호출부에서 `max` 를 올리면 된다.
 */

interface Props {
  items: string[];
  /** kit.css 의 뱃지 색 (`badge neutral` · `badge primary`) */
  variant?: "neutral" | "primary";
  /** methods 처럼 고정폭이 읽기 편한 값 */
  mono?: boolean;
  /** 이 개수를 넘으면 나머지는 `+N` 으로 접는다 (기본 1 — 위 주석 참조) */
  max?: number;
}

export default function BadgeList({ items, variant = "neutral", mono, max = 1 }: Props) {
  if (items.length === 0) return null;

  const shown = items.slice(0, max);
  const hidden = items.length - shown.length;

  return (
    <span className="badge-row" title={items.join(", ")}>
      {shown.map((v) => (
        <span
          key={v}
          className={"badge " + variant}
          style={mono ? { fontFamily: "var(--font-mono)" } : undefined}
        >
          {v}
        </span>
      ))}
      {hidden > 0 && <span className="badge neutral more">+{hidden}</span>}
    </span>
  );
}
