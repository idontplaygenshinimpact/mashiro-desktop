// Vue 复习卡入口：独立窗口挂 #app；兼容旧嵌入方式（#vue-review-root）
import { createApp } from "vue";
import App from "./App.vue";

const el = document.getElementById("vue-review-root") || document.getElementById("app");
if (el) createApp(App).mount(el);
