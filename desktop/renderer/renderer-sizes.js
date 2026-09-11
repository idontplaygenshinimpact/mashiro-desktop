// 自动生成，请勿手改——node scripts/gen-renderer-sizes.mjs 重新实测
// 前端三态并行展示工单任务 4：三态对比卡的包体积数据（dist 产物实测 + gzip）
window.__RENDERER_SIZES = {
  "measuredAt": "2026-09-11",
  "unit": "KB（1KB = 1024 字节；gzip = zlib 压缩后大小，与浏览器传输量同口径）",
  "native": {
    "bytes": 353325,
    "gzip": 107638,
    "files": 6,
    "note": "panel-*.js 直引，无打包无依赖"
  },
  "react": {
    "bytes": 245837,
    "gzip": 77433,
    "note": "Vite 构建的 react-panel.js（含 React 运行时）"
  },
  "vue": {
    "bytes": 161754,
    "gzip": 57994,
    "note": "Vite 构建的 vue-review.js（含 Vue 运行时）"
  }
};
