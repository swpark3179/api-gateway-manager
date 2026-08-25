/**
 * 앱 셸 — 디자인 원본의 최상위 그리드를 그대로 옮겼다.
 *   38px 타이틀바 / [64px 아이콘 레일 | 232px 사이드 패널(접으면 14px) | 본문]
 */

import { useEffect, useRef } from "react";

import { appReady } from "./api";
import BootProgress from "./components/BootProgress";
import IconRail from "./components/IconRail";
import SidePanel from "./components/SidePanel";
import TitleBar from "./components/TitleBar";
import Toast from "./components/Toast";
import Dashboard from "./screens/Dashboard";
import ImportDiffScreen from "./screens/ImportDiffScreen";
import ImportScreen from "./screens/ImportScreen";
import ListScreen from "./screens/ListScreen";
import LockedScreen from "./screens/LockedScreen";
import ServicesScreen from "./screens/ServicesScreen";
import Settings from "./screens/Settings";
import UpstreamsScreen from "./screens/UpstreamsScreen";
import EditScreen from "./screens/edit/EditScreen";
import { selectShowLock, useStore } from "./store";
import type { Section } from "./types";

export default function App() {
  const section = useStore((s) => s.section);
  const view = useStore((s) => s.view);
  const panelOpen = useStore((s) => s.panelOpen);
  const loadSettings = useStore((s) => s.loadSettings);
  const bootstrap = useStore((s) => s.bootstrap);
  const refresh = useStore((s) => s.refresh);
  const showLock = useStore(selectShowLock);
  const started = useRef(false);

  useEffect(() => {
    // StrictMode 는 개발 중 effect 를 두 번 실행하므로 한 번만 돌게 막는다.
    if (started.current) return;
    started.current = true;

    void (async () => {
      // 1) 로컬 설정부터 읽는다 — 네트워크 없음.
      //    selectLocked 는 settings 가 null 이면 true 라, 설정보다 창을 먼저 띄우면
      //    토큰이 있는 사용자도 잠금 화면을 한 프레임 보게 된다.
      await loadSettings();

      // 2) 페인트를 한 번 보장한 뒤 창을 띄운다 (흰 화면 깜빡임 방지).
      //    useEffect 는 페인트 이후 실행이 보장되지 않으므로 rAF 를 두 번 넘긴다.
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      );
      await appReady().catch(() => undefined);

      // 3) 게이트웨이 조회는 창이 뜬 뒤에. 토큰이 없으면 bootstrap 이 즉시 반환한다.
      await bootstrap();
      // 첫 화면은 대시보드다 — KPI 는 캐시에서 세지만 version·latency 는 라이브 값이다.
      await refresh();
    })();
  }, [loadSettings, bootstrap, refresh]);

  // 드롭존 밖에 파일을 떨어뜨리면 WebView2 가 그 파일로 내비게이션해 앱 화면이 사라진다.
  // (tauri.conf.json 의 dragDropEnabled 가 false 라 웹뷰 기본 동작이 그대로 온다.)
  // Import 화면의 드롭존은 자기 핸들러에서 stopPropagation 없이 preventDefault 만 하므로
  // 여기서 문서 전체의 기본 동작만 막아 두면 둘 다 성립한다.
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  const isImport = section === "routes" && view === "import";
  // Import 비교 결과 → 등록된 API 를 눌렀을 때의 중간 단계. 상세(EditScreen)와 같은 섹션에
  // 있으므로 아래 isEdit 에서 명시적으로 빼 준다.
  const isDiff = section === "routes" && view === "diff";
  // 목록 화면은 섹션마다 다르지만 편집 화면(EditScreen)은 네 형태가 공유한다 —
  // 저장·취소·삭제 헤더를 네 번 복붙하지 않기 위해서다.
  const EDITABLE: Section[] = ["routes", "consumers", "upstreams", "services"];
  const editable = EDITABLE.includes(section);
  const isList = (section === "routes" || section === "consumers") && view === "list";
  const isUpstreams = section === "upstreams" && view === "list";
  const isServices = section === "services" && view === "list";
  const isEdit = editable && view !== "list" && !isImport && !isDiff;

  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        gridTemplateRows: "38px 1fr",
        background: "#fff",
        overflow: "hidden",
      }}
    >
      <TitleBar />

      <div
        style={{
          display: "grid",
          // 좌측 패널을 접으면 232px 가 14px 띠로 줄고 본문 그리드가 그만큼 넓어진다.
          gridTemplateColumns: `64px ${panelOpen ? 232 : 14}px 1fr`,
          transition: "grid-template-columns var(--duration-fast) var(--ease-standard)",
          minHeight: 0,
          background: "var(--bg-canvas)",
        }}
      >
        <IconRail />
        <SidePanel />

        <div style={{ overflow: "auto", minHeight: 0, position: "relative" }}>
          {showLock ? (
            <LockedScreen />
          ) : (
            <>
              {section === "dash" && <Dashboard />}
              {section === "settings" && <Settings />}
              {isList && <ListScreen />}
              {isUpstreams && <UpstreamsScreen />}
              {isServices && <ServicesScreen />}
              {isImport && <ImportScreen />}
              {isDiff && <ImportDiffScreen />}
              {isEdit && <EditScreen />}
            </>
          )}
          {/* 본문 컬럼 안에 둔다 — 창 전체를 덮으면 커스텀 타이틀바의 드래그 영역과
              창 조작 버튼까지 가려진다. */}
          <BootProgress />
          <Toast />
        </div>
      </div>
    </div>
  );
}
