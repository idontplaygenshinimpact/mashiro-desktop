// tests/speech-terms.test.mjs —— 语音识别术语纠错（中文 ASR 对英文术语识别差的补偿）
// 背景：sherpa paraformer-zh 是纯中文模型，英文技术词会被识别成小写/拆分/近似拼写
//       （如 "web pack"、"node js"、"react"），直接进对话会影响 LLM 理解。
//       后处理 fixTerms 做确定性归一：复合词合并 → 术语标准写法，不碰中文。
import { fixTerms } from "../lib/speech.mjs";
import test from "node:test";
import assert from "node:assert/strict";

test("复合词合并：被拆的英文词还原为标准术语", () => {
  assert.equal(fixTerms("web pack 打包"), "Webpack 打包");
  assert.equal(fixTerms("node js 项目"), "Node.js 项目");
  assert.equal(fixTerms("java script 基础"), "JavaScript 基础");
  assert.equal(fixTerms("type script 类型"), "TypeScript 类型");
  assert.equal(fixTerms("next js 服务端渲染"), "Next.js 服务端渲染");
  assert.equal(fixTerms("async await 用法"), "async/await 用法");
  assert.equal(fixTerms("ci cd 流程"), "CI/CD 流程");
  assert.equal(fixTerms("k8s 部署"), "Kubernetes 部署");
  assert.equal(fixTerms("nodejs 生态"), "Node.js 生态");
  assert.equal(fixTerms("postgre sql 索引"), "PostgreSQL 索引");
});

test("大小写归一：常见英文术语 → 标准写法", () => {
  assert.equal(fixTerms("react 和 vue 哪个好"), "React 和 Vue 哪个好");
  assert.equal(fixTerms("promise 解决异步"), "Promise 解决异步");
  assert.equal(fixTerms("fiber 架构"), "Fiber 架构");
  assert.equal(fixTerms("http 请求 https 加密"), "HTTP 请求 HTTPS 加密");
  assert.equal(fixTerms("mysql 与 redis 缓存"), "MySQL 与 Redis 缓存");
  assert.equal(fixTerms("git 提交 docker 镜像"), "Git 提交 Docker 镜像");
  assert.equal(fixTerms("tcp 三次握手 udp 区别"), "TCP 三次握手 UDP 区别");
  assert.equal(fixTerms("浏览器 dom 操作 css 动画"), "浏览器 DOM 操作 CSS 动画");
  assert.equal(fixTerms("websocket 长连接 cors 跨域"), "WebSocket 长连接 CORS 跨域");
});

test("中文原样保留（不误伤普通句子）", () => {
  const zh = "今天学习了事件循环和闭包，感觉收获很大";
  assert.equal(fixTerms(zh), zh);
  const mixed = "我打算用 react 写简历里的项目，重点讲 promise 和性能优化";
  assert.equal(fixTerms(mixed), "我打算用 React 写简历里的项目，重点讲 Promise 和性能优化");
});

test("连续多个术语同时纠正", () => {
  assert.equal(
    fixTerms("用了 web pack 打包 node js 项目，react 做 ui，api 用 graphql"),
    "用了 Webpack 打包 Node.js 项目，React 做 UI，API 用 GraphQL"
  );
});
