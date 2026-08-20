import React from "react";
import ReactDOM from "react-dom/client";

// 폰트 — 패밀리명이 디자인 토큰(--font-sans / --font-mono)과 정확히 일치한다.
// 전부 로컬 번들이라 앱은 네트워크 없이 뜬다.
import "@fontsource/noto-sans-kr/400.css";
import "@fontsource/noto-sans-kr/500.css";
import "@fontsource/noto-sans-kr/600.css";
import "@fontsource/noto-sans-kr/700.css";
import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/700.css";

// 순서 주의: 디자인 원본의 <helmet> 순서와 동일해야 한다.
// (app.css 의 html/body 규칙이 kit.css 를 덮어써야 함)
import "./styles/colors_and_type.css";
import "./styles/kit.css";
import "./styles/app.css";

import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
