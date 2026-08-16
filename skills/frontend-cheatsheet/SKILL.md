---
name: frontend-cheatsheet
description: 前端高频八股考点速查清单（JS/浏览器/React/工程化/安全/网络），讲解基础题时按清单覆盖高频追问点，防止漏讲
---

# 前端八股速查

当用户问前端基础知识点（事件循环、闭包、原型链、防抖节流、HTTP、浏览器缓存、React Hooks、
虚拟 DOM、diff、工程化、XSS/CSRF 等）时，讲解请按以下清单自查覆盖，避免漏掉面试官高频追问：

## 高频考点清单（按大类）

- **JS 核心**：事件循环（宏/微任务顺序）、闭包与内存、原型链与继承、this 绑定、Promise 与 async/await、
  防抖节流、深拷贝、柯里化、垃圾回收
- **浏览器**：渲染流程（CRP）、重排重绘、缓存策略（强缓存/协商缓存）、同源策略、跨域方案（CORS/JSONP/代理）、
  Web Storage、Service Worker、事件委托、事件冒泡捕获
- **React**：Hooks 原理（闭包陷阱/依赖数组）、虚拟 DOM 与 diff、Fiber 架构、状态管理选型、
  受控非受控、key 的作用、useMemo/useCallback、Render Props/HOC/自定义 Hook
- **工程化**：Webpack 构建流程、Loader/Plugin 区别、Vite 与 Webpack 对比、模块化（ESM/CJS）、
  代码分割、Tree Shaking、微前端方案
- **网络**：HTTP/1.1 vs HTTP/2 vs HTTP/3、TCP 三次握手、HTTPS 握手、DNS 解析、WebSocket
- **安全**：XSS（反射/存储/DOM）、CSRF、点击劫持、CSP、同源策略细节

## 讲解格式要求

每题严格按：**结论（一句话）→ 原理（机制）→ 实现JS（带注释代码）→ 边界（异常/性能/安全/兼容）→ 追问 2-3 个**。

## 使用时机

- 用户问"讲一下 XX"（基础题）→ 对照清单补全追问点
- 用户说"八股复习/过一遍考点"→ 按清单逐类过，结合记忆薄弱点优先
- 面试官场景（start_interview）追问基础题 → 按此清单出追问
