import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and no clearScreen so cargo errors stay visible.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
