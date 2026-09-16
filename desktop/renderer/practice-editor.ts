// 判题代码编辑器（CodeMirror 6 封装）——三态渲染层共用的唯一编辑器实现
// 为什么单独成文件 + esbuild IIFE 打包（同 speech-queue 的套路）：
//  原生面板的 panel-*.js 是**直接 <script src> 引入的非模块脚本**（file:// 下没有打包步骤），
//  而 CodeMirror 6 是纯 ESM 包 → 必须由 esbuild 打成 IIFE 暴露全局 window.PracticeEditor，
//  panel.html 在 panel-rest.js 之前引入 practice-editor.bundle.js。
// 兜底：产物缺失时 panel-rest.js 会退回原 textarea 实现（编辑器坏掉不能连带面板不可用）。
// 全量 TS 升级工单约定：实现写在 .ts；本文件不需要 .mjs 桶（唯一消费者是 esbuild 打包器）。
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

/** 创建选项（面板传初始骨架 + 运行时回调） */
export interface PracticeEditorOptions {
  /** 初始内容（题库的 skeleton） */
  initial?: string;
  /** 内容变化回调（用于「有改动」提示等） */
  onChange?: (value: string) => void;
  /** Ctrl/Cmd + Enter 触发（面板传判题函数）——比让调用方各自绑 keydown 更可靠 */
  onRun?: () => void;
  /** 高度（CSS 值，默认 200px） */
  height?: string;
}

/** 编辑器句柄（原生面板只依赖这几个方法，便于将来换实现） */
export interface PracticeEditorHandle {
  getValue: () => string;
  setValue: (value: string) => void;
  focus: () => void;
  destroy: () => void;
}

/** 版本标记（护栏/诊断用：面板可据此确认加载的是 CodeMirror 版而不是回退实现） */
export const kind = "codemirror6";

/**
 * 在 host 元素内创建 CodeMirror 6 编辑器
 * @param host 容器元素（会清空后挂载）
 */
export function create(host: HTMLElement, opts: PracticeEditorOptions = {}): PracticeEditorHandle {
  const { initial = "", onChange, onRun, height = "200px" } = opts;
  const runKeymap = onRun
    ? keymap.of([{ key: "Mod-Enter", preventDefault: true, run: () => { onRun(); return true; } }])
    : [];
  const changeListener = onChange
    ? EditorView.updateListener.of((u) => { if (u.docChanged) onChange(u.state.doc.toString()); })
    : [];
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: initial,
      extensions: [
        basicSetup,                       // 行号 / 历史 / 折叠 / 括号匹配 / 自动补全 / 搜索 一次到位
        javascript(),                     // JS/TS 语法高亮（题库是 JS 判题，词法用 JS 足矣）
        oneDark,                          // 深色主题（与判题结果区同色系）
        keymap.of([indentWithTab]),       // Tab 缩进（默认 Tab 会跳焦点）
        runKeymap,
        changeListener,
        EditorView.theme({
          "&": { fontSize: "12px", height, border: "1px solid rgba(109,79,216,.3)", borderRadius: "6px" },
          ".cm-scroller": { fontFamily: "Consolas, Menlo, monospace", lineHeight: "1.55", overflow: "auto" },
          ".cm-content": { caretColor: "#c7a6ff" },
          "&.cm-focused": { outline: "none", borderColor: "rgba(109,79,216,.55)" },
        }),
      ],
    }),
  });
  return {
    getValue: () => view.state.doc.toString(),
    setValue: (value: string) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(value ?? "") } }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
