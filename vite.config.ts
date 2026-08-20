import { readFileSync } from "node:fs";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 타이틀바에 찍히는 버전은 package.json 에서 빌드 시점에 주입한다.
// 하드코딩해 두면 릴리스마다 잊고 어긋나므로 소스를 하나로 묶는다.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string };

// Tauri expects a fixed port and no clearScreen so cargo errors stay visible.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // WebView2 on Windows 10/11 is evergreen Chromium.
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
  },
});
