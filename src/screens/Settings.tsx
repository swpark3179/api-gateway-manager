/**
 * 설정 — 개발 / 운영 게이트웨이의 Admin API 접속 정보와 관리 권한.
 *
 * 화면에 토글이 없다: `프록시 강제 우회` · `인증서 검증 건너뛰기` 는 사내 환경에서 둘 다
 * 켜져 있어야만 게이트웨이에 닿으므로 Rust 가 항상 ON 으로 강제한다
 * (`src-tauri/src/config.rs` 모듈 주석). 고를 수 없는 값을 스위치로 보여 주면
 * "껐는데 왜 그대로냐" 는 질문만 남는다.
 *
 * 관리키(`secret$token`)는 Windows 자격 증명 관리자에 저장된다. 이 화면에 들어오면
 * `settings_reveal_token` 으로 원문을 받아 입력란에 채우고 `type="password"` 로 가려 둔다 —
 * `표시` 는 그 `type` 만 뒤집는다. 값을 채우지 않으면 미표시 모드가 **빈 칸**이 되어
 * 관리키가 등록돼 있는지조차 보이지 않는다. 손대지 않은 값은 저장에서 `null`(유지)로
 * 나가므로(`payload`) 화면을 열었다 닫는 것만으로 자격 증명이 다시 쓰이지는 않는다.
 * 관리 토큰이 담은 권한(시작일 · 종료일 · 권한 service)은 그 아래에 항상 펼친다.
 *
 * 게이트웨이로 나가는 `X-API-KEY` 는 관리키의 토큰 부분만이다 (Rust `config::resolve`).
 */

import { useEffect, useMemo, useState } from "react";

import { useStore, selectIsAdmin } from "../store";
import type { AdminTokenRequest, AdminTokenResult, EnvConfigView, EnvKey, PermView } from "../types";

/** 환경별 baseUrl 안내값. 초기값도 같아서(Rust `EnvConfig::default_for`) 비우면 이 값이 보인다. */
const BASE_URL_PLACEHOLDER: Record<EnvKey, string> = {
  dev: "http://60.101.107.90:9080",
  prod: "http://60.101.207.91:7096",
};

const TOKEN_PLACEHOLDER = "공통담당자에게 전달받은 관리키를 secret$token 형태로 입력하세요";

const envLabel = (env: EnvKey) => (env === "dev" ? "개발" : "운영");

const boxStyle: React.CSSProperties = {
  padding: "12px 14px",
  background: "var(--gray-25)",
  border: "1px solid var(--gray-200)",
  borderRadius: 8,
};

const noteStyle = (tone: "blue" | "yellow"): React.CSSProperties => ({
  padding: "10px 14px",
  background: `var(--${tone}-50)`,
  border: `1px solid var(--${tone}-200)`,
  borderRadius: 8,
  font: "400 12px/18px var(--font-sans)",
  color: `var(--${tone}-800)`,
});

/** `YYYY-MM-DD` → 로컬 시각의 unix 초. 종료일은 그 날 끝까지 유효해야 하므로 23:59:59 로 잡는다. */
function toUnix(date: string, edge: "start" | "end"): number | null {
  if (!date) return null;
  const ms = new Date(`${date}T${edge === "start" ? "00:00:00" : "23:59:59"}`).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** 오늘부터 n일 뒤의 `YYYY-MM-DD` (발급 폼의 기본값). */
function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  // toISOString 은 UTC 라 날짜가 하루 밀릴 수 있다 — 로컬 값으로 직접 만든다.
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── 토큰이 담은 권한 상세 ────────────────────────────────────

/**
 * 관리키가 등록돼 있으면 입력란 아래에 늘 펼치는 카드.
 *
 * 예전에는 `표시` 를 켰을 때만 보여 줬는데, 그 버튼이 원문을 가져오는 역할을 겸했기
 * 때문이다. 이제는 `type` 만 뒤집으므로 권한 상세를 숨길 이유가 없다 — 오히려 자기 토큰이
 * 무엇을 할 수 있는지는 이 화면에 들어오면 바로 보여야 한다.
 *
 * 기간이 지난 토큰도 시작일 · 종료일 · 권한 service 를 보여 준다 — 사용자가 "왜 막혔는지"
 * 를 이 화면에서 알아야 하기 때문이다 (Rust `perm::view` 주석).
 */
function PermDetail({ perm }: { perm: PermView }) {
  if (!perm.hasClaims) {
    return (
      <div style={noteStyle("yellow")}>
        {perm.message} 관리키는 <span className="font-mono">secret$token</span> 형태여야 하고,
        토큰은 그 secret 으로 서명된 JWT 여야 합니다.
      </div>
    );
  }

  const kindBadge =
    perm.kind === "admin" ? (
      <span className="badge primary">전체 관리자</span>
    ) : perm.kind === "scoped" ? (
      <span className="badge success">
        <span className="dot" />
        service {perm.services.length}개 관리
      </span>
    ) : (
      <span className="badge warning">
        <span className="dot" />
        사용 불가
      </span>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={boxStyle}>
          <div className="text-xs muted">시작일</div>
          <div className="font-mono" style={{ fontSize: 13, color: "var(--gray-900)" }}>
            {perm.nbfHuman || "—"}
          </div>
        </div>
        <div style={boxStyle}>
          <div className="text-xs muted">종료일</div>
          <div className="font-mono" style={{ fontSize: 13, color: "var(--gray-900)" }}>
            {perm.expHuman || "—"}
          </div>
        </div>
      </div>

      <div style={boxStyle}>
        <div className="row between" style={{ marginBottom: 8 }}>
          <div className="text-xs muted">권한</div>
          {kindBadge}
        </div>
        {perm.kind === "admin" ? (
          <div className="text-xs muted">모든 service · Upstream · Service 메뉴를 관리합니다.</div>
        ) : perm.services.length === 0 ? (
          <div className="text-xs muted">권한이 부여된 service 가 없습니다.</div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {/* 이름은 해당 환경의 로컬 캐시에서 찾는다. 아직 동기화하지 않은 환경이면
                Rust 가 id 를 그대로 준다 (`config::service_namer`). */}
            {perm.services.map((s) => (
              <span key={s.id} className="badge neutral" title={s.id}>
                {s.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {perm.kind === "none" && <div style={noteStyle("yellow")}>{perm.message}</div>}
    </div>
  );
}

// ── 환경 카드 ────────────────────────────────────────────────

function EnvCard({ env, cfg }: { env: EnvKey; cfg: EnvConfigView }) {
  const saveSettings = useStore((s) => s.saveSettings);
  const testSettings = useStore((s) => s.testSettings);
  const revealToken = useStore((s) => s.revealToken);

  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl);
  const [token, setToken] = useState("");
  /**
   * 방금 불러온 관리키 원문. `token` 이 이 값과 같으면 **사용자가 손대지 않았다**는 뜻이다.
   *
   * 입력란을 미리 채워 두는 순간 "빈 문자열 = 변경 없음" 규약을 쓸 수 없게 된다 — 그러면
   * 저장할 때마다 원문을 다시 써 보내게 되고, 삭제(`""`)와 유지(`null`)의 구별도 사라진다.
   * 그래서 원문 사본을 들고 비교한다 (`payload`).
   */
  const [loaded, setLoaded] = useState("");
  const [reveal, setReveal] = useState(false);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);

  // 저장 후 서버 상태가 갱신되면 로컬 입력값도 맞춰 준다.
  //
  // 관리키는 **비우지 않고 다시 불러온다** — 입력란이 `type="password"` 라 값이 있어야
  // 점으로 보인다. 값이 없으면 "미표시 모드" 가 빈 칸으로 나와 등록돼 있는지조차 알 수 없다.
  // `reveal` 은 되돌린다: 저장 직후에 원문이 그대로 보이고 있을 이유가 없다.
  useEffect(() => {
    let alive = true;
    setBaseUrl(cfg.baseUrl);
    setReveal(false);
    if (!cfg.hasToken) {
      setToken("");
      setLoaded("");
      return;
    }
    void (async () => {
      const raw = await revealToken(env);
      // 다른 환경 카드로 갈아탔거나 그새 저장이 한 번 더 돌았으면 이 응답은 버린다.
      if (!alive) return;
      setToken(raw);
      setLoaded(raw);
    })();
    return () => {
      alive = false;
    };
  }, [env, cfg.baseUrl, cfg.hasToken, cfg.tokenMasked, revealToken]);

  const payload = (tokenOverride?: string | null) => ({
    baseUrl,
    // 손대지 않았으면 `null` — 저장이 자격 증명 관리자를 건드리지 않는다.
    token: tokenOverride !== undefined ? tokenOverride : token === loaded ? null : token,
  });

  const onTest = async () => {
    setBusy(true);
    setResult("호출 중…");
    const r = await testSettings(env, payload());
    setResult(r.text);
    setBusy(false);
  };

  const onSave = async () => {
    setBusy(true);
    const ok = await saveSettings(env, payload());
    if (ok) setResult("");
    setBusy(false);
  };

  const onClearToken = async () => {
    setBusy(true);
    await saveSettings(env, payload(""));
    // 저장 후 효과가 `hasToken: false` 를 보고 입력란을 비우지만, 그 사이에 방금 지운 값이
    // 점으로 남아 있으면 삭제가 안 된 것처럼 보인다.
    setToken("");
    setLoaded("");
    setResult("");
    setBusy(false);
  };

  /**
   * 표시 ⇄ 가리기 — `type` 만 뒤집는다.
   *
   * 원문은 화면에 들어올 때 이미 받아 두었으므로(위 `useEffect`) 여기서 부를 것이 없다.
   * 예전에는 이 버튼이 원문을 가져오는 역할까지 했는데, 그러면 누르기 전까지 입력란이 빈 칸이라
   * 관리키가 등록돼 있는지도 보이지 않았다.
   */
  const onToggleReveal = () => setReveal((v) => !v);

  return (
    <div className="card-surface" style={{ padding: 24 }}>
      <div className="row between" style={{ marginBottom: 18 }}>
        <div className="row" style={{ gap: 10 }}>
          <h5 className="h5">{envLabel(env)} 서버</h5>
          <span className={"badge " + (cfg.perm.kind !== "none" ? "success" : "warning")}>
            <span className="dot" />
            {cfg.perm.kind === "admin"
              ? "전체 관리자"
              : cfg.perm.kind === "scoped"
                ? "부분 관리"
                : cfg.hasToken
                  ? "관리키 사용 불가"
                  : "관리키 미설정"}
          </span>
        </div>
        <span className="text-xs muted font-mono">
          {env === "dev" ? "DEVELOPMENT" : "PRODUCTION"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <label className="field-label">
            Admin API baseUrl <span style={{ color: "var(--red-600)" }}>*</span>
          </label>
          <input
            className="text-input font-mono"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={BASE_URL_PLACEHOLDER[env]}
          />
          <div className="text-xs muted" style={{ marginTop: 6 }}>
            경로 <span className="font-mono">/apisix/admin</span> 은 자동으로 붙습니다.
          </div>
        </div>

        <div>
          <label className="field-label">
            관리키 (secret$token) <span style={{ color: "var(--red-600)" }}>*</span>
          </label>
          <input
            className="text-input font-mono"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type={reveal ? "text" : "password"}
            placeholder={TOKEN_PLACEHOLDER}
          />
          <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
            <button className="btn sm outline" onClick={onToggleReveal} disabled={busy}>
              {reveal ? "가리기" : "표시"}
            </button>
            {cfg.hasToken && (
              <button className="btn sm ghost" onClick={() => void onClearToken()} disabled={busy}>
                관리키 삭제
              </button>
            )}
          </div>
          <div className="text-xs muted" style={{ marginTop: 6, lineHeight: "18px" }}>
            {cfg.hasToken
              ? "관리키는 Windows 자격 증명 관리자에 보관됩니다. 값을 고치지 않고 저장하면 기존 관리키가 그대로 유지됩니다."
              : "미입력 시 해당 환경은 관리할 수 없습니다. 게이트웨이로는 $ 뒤의 토큰만 나갑니다."}
          </div>
        </div>

        {cfg.hasToken && <PermDetail perm={cfg.perm} />}

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn md outline" onClick={() => void onTest()} disabled={busy}>
            연결 테스트
          </button>
          <button className="btn md solid-primary" onClick={() => void onSave()} disabled={busy}>
            저장
          </button>
          <span className="text-xs font-mono selectable" style={{ color: "var(--gray-500)" }}>
            {result}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── 관리키 발급 (전체 관리자 전용) ───────────────────────────

/**
 * 새 관리키(`secret$token`)를 만든다. **서명만 한다** — 실제로 쓰려면 게이트웨이에 같은
 * key·secret 의 consumer 가 등록돼 있어야 한다. 화면에 그 안내를 붙인다.
 *
 * secret 은 발급자가 직접 입력한다. 여기서 새로 만들어 주지 않는 이유는, 게이트웨이에
 * 등록된 `jwt-auth.secret` 과 달라지면 발급한 관리키가 게이트웨이에서 거부되기 때문이다.
 * secret 을 새로 만드는 자리는 Consumer 화면이다.
 *
 * 지금 보고 있는 환경의 service 목록에서 권한을 고른다. 개발과 운영의 service id 가
 * 다르므로, 어느 환경용 관리키인지가 카드 제목에 드러나야 한다.
 */
function AdminTokenCard({ env }: { env: EnvKey }) {
  const services = useStore((s) => s.services);
  const createAdminToken = useStore((s) => s.createAdminToken);
  const copyText = useStore((s) => s.copyText);

  const [secret, setSecret] = useState("");
  const [start, setStart] = useState(() => isoDate(0));
  const [end, setEnd] = useState(() => isoDate(365));
  const [admin, setAdmin] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [issued, setIssued] = useState<AdminTokenResult | null>(null);
  const [busy, setBusy] = useState(false);

  // 환경이 바뀌면 고른 service id 는 다른 게이트웨이의 것이라 의미가 없다.
  // secret 도 게이트웨이마다 다르므로 같이 비운다 — 개발 secret 으로 운영 관리키를
  // 발급하면 게이트웨이가 거부하는데, 그 사실은 배포한 뒤에야 드러난다.
  useEffect(() => {
    setSecret("");
    setPicked([]);
    setIssued(null);
  }, [env]);

  const nbf = toUnix(start, "start");
  const exp = toUnix(end, "end");
  const rangeError =
    nbf === null || exp === null
      ? "시작일과 종료일을 모두 고르세요."
      : exp <= nbf
        ? "종료일은 시작일보다 뒤여야 합니다."
        : "";
  const pickError = !admin && picked.length === 0 ? "권한을 줄 service 를 하나 이상 고르세요." : "";
  // `$` 는 관리키 구분자다 — 값에 섞이면 관리키가 어디서 갈리는지 모호해진다 (Rust `perm::SEP`).
  const secretError =
    secret.trim() === ""
      ? "secret 을 입력하세요."
      : secret.includes("$")
        ? "secret 에는 $ 를 넣을 수 없습니다."
        : "";
  const blocked = secretError || rangeError || pickError;

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));

  const onCreate = async () => {
    if (blocked || nbf === null || exp === null) return;
    setBusy(true);
    const req: AdminTokenRequest = {
      secret: secret.trim(),
      nbf,
      exp,
      admin,
      services: admin ? [] : picked,
    };
    setIssued(await createAdminToken(env, req));
    setBusy(false);
  };

  return (
    <div className="card-surface" style={{ padding: 24, marginTop: 16 }}>
      <div className="row between" style={{ marginBottom: 6 }}>
        <h5 className="h5">관리키 발급</h5>
        <span className="badge primary font-mono">{envLabel(env)} 서버 기준</span>
      </div>
      <p className="page-sub" style={{ margin: "0 0 16px" }}>
        기간과 권한을 담은 관리키(<span className="font-mono">secret$token</span>)를 만듭니다.
        권한 service 는 지금 보고 있는 {envLabel(env)} 서버의 목록에서 고릅니다.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <label className="field-label">
            secret <span style={{ color: "var(--red-600)" }}>*</span>
          </label>
          <input
            className="text-input font-mono"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="게이트웨이 관리 consumer 의 jwt-auth.secret"
          />
          <div className="text-xs muted" style={{ marginTop: 6, lineHeight: "18px" }}>
            {envLabel(env)} 게이트웨이에 등록된 관리 consumer 의{" "}
            <span className="font-mono">jwt-auth.secret</span> 과 같아야 발급한 관리키가
            통합니다. 값은 Consumer 화면에서 확인하고, 새로 만들 때도 거기서 바꿉니다.
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label className="field-label">시작일</label>
            <input
              className="text-input font-mono"
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label">종료일</label>
            <input
              className="text-input font-mono"
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="field-label">권한</label>
          <div className="row" style={{ gap: 8 }}>
            <div className={"chip " + (admin ? "on" : "")} onClick={() => setAdmin(true)}>
              전체 관리자
            </div>
            <div className={"chip " + (!admin ? "on" : "")} onClick={() => setAdmin(false)}>
              service 지정
            </div>
          </div>
        </div>

        {!admin && (
          <div>
            <label className="field-label">권한 service ({picked.length}개 선택)</label>
            {services.length === 0 ? (
              <div className="text-xs muted">
                등록된 Service 가 없습니다. Service 화면에서 먼저 생성하세요.
              </div>
            ) : (
              <div
                style={{
                  ...boxStyle,
                  maxHeight: 220,
                  overflow: "auto",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {services.map((s) => (
                  <label
                    key={s.id}
                    className="row"
                    style={{ gap: 8, cursor: "pointer", alignItems: "baseline" }}
                  >
                    <input
                      type="checkbox"
                      checked={picked.includes(s.id)}
                      onChange={() => toggle(s.id)}
                    />
                    <span style={{ font: "500 13px/18px var(--font-sans)" }}>{s.name || s.id}</span>
                    <span className="text-xs muted font-mono">{s.id}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn md solid-primary"
            onClick={() => void onCreate()}
            disabled={busy || blocked !== ""}
          >
            생성
          </button>
          {issued && (
            <button
              className="btn md outline"
              onClick={() => void copyText(issued.adminKey, "관리키")}
            >
              복사
            </button>
          )}
          <span className="text-xs" style={{ color: "var(--red-600)" }}>
            {blocked}
          </span>
        </div>

        {issued && (
          <>
            {/* 받는 사람이 붙여넣는 것은 관리키다 — 토큰만 건네면 secret 이 빠져 쓸 수 없다. */}
            <div>
              <label className="field-label">관리키 (이 값을 전달합니다)</label>
              <div
                className="selectable"
                style={{
                  padding: "14px 16px",
                  background: "var(--gray-900)",
                  borderRadius: 8,
                  font: "400 12px/20px var(--font-mono)",
                  color: "var(--green-300)",
                  wordBreak: "break-all",
                }}
              >
                {issued.adminKey}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={boxStyle}>
                <div className="text-xs muted">nbf (시작)</div>
                <div className="font-mono" style={{ fontSize: 13, color: "var(--gray-900)" }}>
                  {issued.nbfHuman}
                </div>
              </div>
              <div style={boxStyle}>
                <div className="text-xs muted">exp (종료)</div>
                <div className="font-mono" style={{ fontSize: 13, color: "var(--gray-900)" }}>
                  {issued.expHuman}
                </div>
              </div>
            </div>
            <pre
              className="selectable"
              style={{
                margin: 0,
                ...boxStyle,
                font: "400 12.5px/20px var(--font-mono)",
                color: "var(--gray-800)",
                overflow: "auto",
              }}
            >
              {issued.payload}
            </pre>
          </>
        )}

        <div style={noteStyle("blue")}>
          이 화면은 문자열만 만듭니다. 실제로 사용하려면 APISIX 서버에 위 secret 을 쓰는 관리
          consumer 가 등록되어 있어야 하며, 발급한 관리키를 사용자에게 전달해 설정 화면의
          관리키 란에 입력하도록 안내하세요.
        </div>
      </div>
    </div>
  );
}

// ── 화면 ─────────────────────────────────────────────────────

export default function Settings() {
  const settings = useStore((s) => s.settings);
  const env = useStore((s) => s.env);
  const isAdmin = useStore(selectIsAdmin);

  const callRules = useMemo(
    () => [
      { label: "인증 헤더", value: "X-API-KEY: <관리키의 토큰>" },
      { label: "프록시 우회 · 인증서 검증", value: "항상 우회 · 항상 건너뜀 (고정)" },
      { label: "요청 경로", value: "{baseUrl}/apisix/admin/{resource}" },
    ],
    [],
  );

  return (
    <div data-screen-label="설정" style={{ padding: "24px 28px 56px", maxWidth: 1120 }}>
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div>
          <h2 className="page-title" style={{ fontSize: 24, lineHeight: "32px" }}>
            설정
          </h2>
          <p className="page-sub">
            개발 · 운영 게이트웨이의 Admin API 접속 정보를 각각 등록합니다. 관리키가 담은
            기간과 권한이 각 환경에서 볼 수 있는 메뉴와 목록을 정합니다.
          </p>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        {settings && <EnvCard env="dev" cfg={settings.dev} />}
        {settings && <EnvCard env="prod" cfg={settings.prod} />}
      </div>

      {isAdmin && <AdminTokenCard env={env} />}

      <div className="card-surface" style={{ padding: "22px 24px", marginTop: 16 }}>
        <h5 className="h5" style={{ marginBottom: 10 }}>
          호출 규칙
        </h5>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
          {callRules.map((c) => (
            <div key={c.label} style={boxStyle}>
              <div
                style={{
                  font: "500 12px/16px var(--font-sans)",
                  color: "var(--gray-700)",
                  marginBottom: 6,
                }}
              >
                {c.label}
              </div>
              <div
                className="font-mono selectable"
                style={{
                  fontSize: 11.5,
                  lineHeight: "18px",
                  color: "var(--gray-600)",
                  wordBreak: "break-all",
                }}
              >
                {c.value}
              </div>
            </div>
          ))}
        </div>
        <div className="text-xs muted" style={{ marginTop: 12, lineHeight: "18px" }}>
          모든 게이트웨이 호출은 앱 백엔드(Rust)에서 나갑니다. 웹뷰는 외부로 직접 통신하지 않도록
          CSP 로 차단되어 있어, 시스템 프록시가 설정돼 있어도 우회 경로가 생기지 않습니다.
          프록시 우회와 인증서 검증 건너뛰기는 선택 항목이 아니라 항상 적용됩니다.
        </div>
      </div>
    </div>
  );
}
