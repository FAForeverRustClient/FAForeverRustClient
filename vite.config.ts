import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend source lives in `ui/`. Output goes to `ui/dist`, which Tauri serves
// (see src-tauri/tauri.conf.json `frontendDist`).
export default defineConfig({
  root: "ui",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
  },
});
