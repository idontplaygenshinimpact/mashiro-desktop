// 独立 Vite 项目（React 版模拟面试面板）
// 生产构建：vite build → dist/（固定产物名 react-panel.js 便于主项目引用/测试）
// 开发模式：vite dev（HMR）；浏览器打开时 window.kanban 不存在 → 注入 dev mock（仅 DEV）
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/react-panel.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
