// React 版面板的数据入口（前端三态并行展示工单任务 2）
// 复用渲染层统一 client（api-client.mjs）：端口解析单一来源（window.kanban.getApiBase + 兜底 8899），
// 不各自硬编码——三态（原生/React/Vue）连的是同一个后端。
// 说明：面试面板走 IPC 桥（window.kanban.invXxx，业务层 lib/interview.mjs）；驾驶舱/知识库的数据
// 只存在于 HTTP 路由（/api/dashboard、/api/knowledge/*），原生面板也是 fetch 这些路由——React 版从同一处取，保证三态数据一致。
export { api } from "../../api-client.mjs";
