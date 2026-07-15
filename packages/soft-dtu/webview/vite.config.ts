/**
 * Vite 配置 — 软 DTU WebView
 *
 * Phase 1 dev 工作流：
 *   1. `deno task dev` 启动软 DTU 后端（HTTP serve on 127.0.0.1:8080，暴露 /api/* 包装 bindings）
 *   2. `npm run dev`（在这个目录）启动 Vite dev server on 127.0.0.1:5173
 *   3. Vite 把 /api/* 代理到后端 (8080)
 *   4. 浏览器开 http://127.0.0.1:5173
 *
 * Phase 2 切 Deno Desktop bindings SDK 时，bindings.ts 切到 window.bindings.*，
 * Vite proxy 可以删掉（WebView 直接 IPC 调 Deno runtime）。
 */

import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],

  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // 软 DTU 后端 HTTP serve 端点
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },

  // 用 'preact' 别名替换 'react'，省体积
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
    },
  },
});
