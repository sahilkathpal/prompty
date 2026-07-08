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
    // Emit external source maps so field crashes (always minified for remote
    // users) can be symbolicated. The maps are uploaded to PostHog at release
    // time (scripts/upload-sourcemaps.mjs) and excluded from the shipped app
    // (electron-builder `!**/*.map`) — they live in PostHog only, never ship.
    sourcemap: true,
    rollupOptions: {
      input: {
        overlay: resolve(__dirname, "src/overlay/index.html"),
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
