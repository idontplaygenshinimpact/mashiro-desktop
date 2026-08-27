// Vue 复习卡入口：挂载到面板的 #vue-review-root
import { createApp } from "vue";
import App from "./App.vue";

const el = document.getElementById("vue-review-root");
if (el) createApp(App).mount(el);
