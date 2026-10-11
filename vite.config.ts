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
    // Licence comments (`/*! ... */`, `@license`) stay in the shipped code.
    // The minifier dropped them all by default, which took the notices of
    // the libraries and icon drawings the client ships out of the copy that
    // ships, where their licences ask for them to be.
    rolldownOptions: {
      output: {
        comments: { legal: true },
      },
    },
  },
});
