// 独立 Vite 项目（Vue 版复习卡：FSRS 调度可视化）
// 生产构建：vite build → dist/（固定产物名 assets/vue-review.js 便于主项目引用）
// 开发模式：vite dev（HMR）；端口 5174（React 版占 5173）
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/vue-review.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
