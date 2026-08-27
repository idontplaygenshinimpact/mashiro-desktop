// React 版面板入口（渲染层可替换性验证）：同一 preload IPC 桥（window.kanban），只换渲染层
import { createRoot } from "react-dom/client";
import { InterviewPanel } from "./panel.jsx";

createRoot(document.getElementById("root")).render(<InterviewPanel />);
