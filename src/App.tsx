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

  const isList = (section === "routes" || section === "consumers") && view === "list";
  const isEdit = (section === "routes" || section === "consumers") && view !== "list";

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
              {isEdit && <EditScreen />}
            </>
          )}
          <Toast />
        </div>
      </div>
    </div>
  );
}
