// Vue 版面板的数据入口（任务 3）：复用渲染层统一 client（api-client.mjs，端口解析单一来源）。
// 三态（原生/React/Vue）连同一个后端——Vue 侧不各自硬编码端口。
export { api } from "../../api-client.mjs";