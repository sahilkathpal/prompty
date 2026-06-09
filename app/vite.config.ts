import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "src"),
  base: "./",
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        overlay: resolve(__dirname, "src/overlay/index.html"),
        teleprompter: resolve(__dirname, "src/teleprompter/index.html"),
        "main-window": resolve(__dirname, "src/main-window/index.html"),
        onboarding: resolve(__dirname, "src/onboarding/index.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
