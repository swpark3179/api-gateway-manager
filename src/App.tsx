/**
 * 앱 셸 — 디자인 원본의 최상위 그리드를 그대로 옮겼다.
 *   38px 타이틀바 / [64px 아이콘 레일 | 232px 사이드 패널 | 본문]
 */

import { useEffect, useRef } from "react";

import { appReady } from "./api";
import IconRail from "./components/IconRail";
import SidePanel from "./components/SidePanel";
import TitleBar from "./components/TitleBar";
import Toast from "./components/Toast";
import Dashboard from "./screens/Dashboard";
import ImportScreen from "./screens/ImportScreen";
import ListScreen from "./screens/ListScreen";
import LockedScreen from "./screens/LockedScreen";
import Settings from "./screens/Settings";
import EditScreen from "./screens/edit/EditScreen";
import { selectShowLock, useStore } from "./store";

export default function App() {
  const section = useStore((s) => s.section);
  const view = useStore((s) => s.view);
  const init = useStore((s) => s.init);
  const showLock = useStore(selectShowLock);
  const started = useRef(false);

  useEffect(() => {
    // StrictMode 는 개발 중 effect 를 두 번 실행하므로 한 번만 돌게 막는다.
    if (started.current) return;
    started.current = true;

    void (async () => {
      await init();
      // 첫 렌더가 끝난 뒤 창을 보여준다 (흰 화면 깜빡임 방지)
      await appReady().catch(() => undefined);
    })();
  }, [init]);

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
  const isList = (section === "routes" || section === "consumers") && view === "list";
  const isEdit =
    (section === "routes" || section === "consumers") && view !== "list" && !isImport;

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
          gridTemplateColumns: "64px 232px 1fr",
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
              {isImport && <ImportScreen />}
              {isEdit && <EditScreen />}
            </>
          )}
          <Toast />
        </div>
      </div>
    </div>
  );
}
