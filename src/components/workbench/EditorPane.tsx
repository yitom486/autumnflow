/**
 * 编辑器区：标签页（预览 / 固定 / 未保存圆点）+ CodeMirror 6 编辑器 + @codemirror/merge 对比视图。
 * 每个标签保留自己的 EditorState（撤销历史、光标、滚动），切换标签不丢。
 */
import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { X, Circle, GitCompare, Columns2, Rows2, AlertTriangle, Loader2, Sparkles, Check, MessageSquareShare } from "lucide-react";
import { useWorkbenchStore, isDirty, type EditorTab } from "@/stores/useWorkbenchStore";
import { saveTab, acceptDisk, openDiff } from "@/lib/workbench-actions";
import { baseExtensions, languageFor, setFlashLines } from "./codemirror-setup";
import { cn } from "@/lib/utils";
import { AcpStandaloneMarkdown } from "@/components/assistant/AcpMarkdown";
import { sendSnippetToComposer } from "@/lib/composer-bridge";
import { ACP_PATH_MIME, encodeDragRefs, setActiveDragRefs } from "@/lib/composer-drop";

const NotebookViewer = lazy(() => import("./NotebookViewer"));
const MarkdownWysiwyg = lazy(() => import("./MarkdownWysiwyg"));

export const isNotebook = (p: string) => /\.ipynb$/i.test(p);
export const isMarkdown = (p: string) => /\.(md|markdown)$/i.test(p);
export function viewOf(t: EditorTab): "preview" | "wysiwyg" | "source" | "notebook" {
  if (t.view) return t.view;
  if (isNotebook(t.path)) return "notebook";
  if (isMarkdown(t.path)) return "preview";
  return "source";
}

const states = new Map<string, EditorState>();
const langCompartment = new Compartment();

function buildState(tab: EditorTab, onChange: (text: string) => void): EditorState {
  return EditorState.create({
    doc: tab.text.replace(/\r\n/g, "\n"),
    extensions: [
      baseExtensions(),
      langCompartment.of([]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange(u.state.doc.toString());
      }),
    ],
  });
}

interface SelectionInfo {
  fromLine: number;
  toLine: number;
  code: string;
  top: number;
  left: number;
  visible: boolean;
}

function computeSelectionCoords(v: EditorView, hostEl: HTMLElement): { top: number; left: number; visible: boolean } {
  const sel = v.state.selection.main;
  if (sel.empty) return { top: 0, left: 0, visible: false };

  // 坐标基于选区尾部（光标所在行位置）
  const coords = v.coordsAtPos(sel.to) || v.coordsAtPos(sel.head);
  if (!coords) return { top: 0, left: 0, visible: false };

  const hostRect = hostEl.getBoundingClientRect();
  // 选区是否滚动到可视窗口外
  if (coords.bottom < hostRect.top || coords.top > hostRect.bottom) {
    return { top: 0, left: 0, visible: false };
  }

  const PILL_WIDTH = 220;
  const PILL_HEIGHT = 28;

  // 紧随选中代码行旁边浮动（就在旁边）
  const targetLeft = coords.right - hostRect.left + 12;
  const maxLeft = Math.max(16, hostRect.width - PILL_WIDTH - 16);

  if (targetLeft <= maxLeft) {
    const top = Math.max(8, Math.min(coords.top - hostRect.top - 2, hostRect.height - PILL_HEIGHT - 8));
    return { top, left: targetLeft, visible: true };
  }

  // 若右侧到达边界，浮动在选区下方或上方
  const left = Math.max(16, Math.min(coords.left - hostRect.left, maxLeft));
  if (coords.bottom - hostRect.top + PILL_HEIGHT + 8 < hostRect.height) {
    return { top: coords.bottom - hostRect.top + 6, left, visible: true };
  }
  return { top: Math.max(8, coords.top - hostRect.top - PILL_HEIGHT - 6), left, visible: true };
}

const FileEditor: React.FC<{ tab: EditorTab; cwd: string | null }> = ({ tab, cwd }) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const tabId = tab.id;
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [sentFeedback, setSentFeedback] = useState(false);

  const onSelectionRef = useRef(setSelection);
  onSelectionRef.current = setSelection;

  const sendToChat = (fromLine?: number, toLine?: number, code?: string) => {
    let actualFrom = fromLine;
    let actualTo = toLine;
    let actualCode = code;

    const v = view.current;
    if (v && actualCode == null) {
      const sel = v.state.selection.main;
      if (!sel.empty) {
        actualFrom = v.state.doc.lineAt(sel.from).number;
        actualTo = v.state.doc.lineAt(sel.to).number;
        actualCode = v.state.sliceDoc(sel.from, sel.to);
      } else {
        actualCode = v.state.doc.toString();
      }
    }

    const ext = tab.path.split(".").pop()?.toLowerCase() || "";
    const langMap: Record<string, string> = {
      ts: "typescript",
      tsx: "tsx",
      js: "javascript",
      jsx: "jsx",
      py: "python",
      rs: "rust",
      json: "json",
      md: "markdown",
      css: "css",
      html: "html",
      sh: "bash",
      yaml: "yaml",
      yml: "yaml",
    };
    const lang = langMap[ext] || ext;
    sendSnippetToComposer({
      path: tab.path,
      fromLine: actualFrom,
      toLine: actualTo,
      code: actualCode || tab.text,
      lang,
      cwd,
    });
    setSentFeedback(true);
    setTimeout(() => setSentFeedback(false), 2000);
  };

  const onSendRef = useRef<() => void>(() => {});
  onSendRef.current = () => sendToChat();

  useEffect(() => {
    if (!host.current) return;
    const onChange = (text: string) => {
      const st = useWorkbenchStore.getState();
      const cur = st.tabs.find((t) => t.id === tabId);
      if (!cur) return;
      const curNorm = cur.text.replace(/\r\n/g, "\n");
      const nextNorm = text.replace(/\r\n/g, "\n");
      if (curNorm === nextNorm) return;
      st.patchTab(tabId, { text, ...(cur.preview ? { preview: false } : {}) }); // 开始编辑 = 固定标签
    };
    const state =
      states.get(tabId) ??
      EditorState.create({
        doc: tab.text.replace(/\r\n/g, "\n"),
        extensions: [
          baseExtensions(),
          langCompartment.of([]),
          keymap.of([
            {
              key: "Mod-l",
              run: () => {
                onSendRef.current();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange(u.state.doc.toString());
            if (u.selectionSet || u.docChanged || u.geometryChanged) {
              const sel = u.state.selection.main;
              if (!sel.empty && host.current) {
                const fromLine = u.state.doc.lineAt(sel.from).number;
                const toLine = u.state.doc.lineAt(sel.to).number;
                const code = u.state.sliceDoc(sel.from, sel.to);
                const pos = computeSelectionCoords(u.view, host.current);
                onSelectionRef.current({ fromLine, toLine, code, ...pos });
              } else {
                onSelectionRef.current(null);
              }
            }
          }),
        ],
      });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;

    const scrollEl = v.scrollDOM;
    const handleScroll = () => {
      const curSel = v.state.selection.main;
      if (!curSel.empty && host.current) {
        const fromLine = v.state.doc.lineAt(curSel.from).number;
        const toLine = v.state.doc.lineAt(curSel.to).number;
        const code = v.state.sliceDoc(curSel.from, curSel.to);
        const pos = computeSelectionCoords(v, host.current);
        onSelectionRef.current({ fromLine, toLine, code, ...pos });
      }
    };
    scrollEl.addEventListener("scroll", handleScroll, { passive: true });

    let cancelled = false;
    void languageFor(tab.path).then((lang) => {
      if (!cancelled && lang) v.dispatch({ effects: langCompartment.reconfigure(lang) });
    });
    return () => {
      cancelled = true;
      scrollEl.removeEventListener("scroll", handleScroll);
      states.set(tabId, v.state);
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // 外部重载（磁盘 / AI 修改、冲突时选用磁盘版本）：文本和编辑器不一致时替换
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc.toString();
    const docNorm = doc.replace(/\r\n/g, "\n");
    const tabNorm = tab.text.replace(/\r\n/g, "\n");
    if (docNorm !== tabNorm) {
      v.dispatch({ changes: { from: 0, to: doc.length, insert: tab.text } });
    }
  }, [tab.text]);

  useEffect(() => {
    const v = view.current;
    if (!v || !tab.flashLines?.length) return;
    v.dispatch({ effects: setFlashLines.of(tab.flashLines) });
    const first = tab.flashLines[0];
    if (first <= v.state.doc.lines) v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(first).from, { y: "center" }) });
  }, [tab.flashAt, tab.flashLines]);

  return (
    <div className="relative h-full overflow-hidden group">
      <div ref={host} className="h-full overflow-hidden" />
      {selection && selection.visible && (
        <div
          style={{
            top: `${selection.top}px`,
            left: `${selection.left}px`,
          }}
          className="absolute z-20 flex items-center gap-1.5 animate-in fade-in zoom-in-95 duration-150 shadow-lg rounded-full border border-border bg-popover/95 backdrop-blur-md px-3 py-1.5 text-xs text-popover-foreground transition-[top,left] duration-75 select-none"
        >
          <Sparkles className="w-3.5 h-3.5 text-signal animate-pulse shrink-0" />
          <span className="font-mono text-[11px] text-muted-foreground mr-0.5">
            {selection.fromLine === selection.toLine ? `L${selection.fromLine}` : `L${selection.fromLine}-L${selection.toLine}`}
          </span>
          <button
            type="button"
            onClick={() => sendToChat(selection.fromLine, selection.toLine, selection.code)}
            className="flex items-center gap-1 font-medium hover:text-signal transition-colors cursor-pointer select-none"
            title="发送选中代码到 Agent 对话框 (Ctrl+L / ⌘+L)"
          >
            {sentFeedback ? (
              <>
                <Check className="w-3.5 h-3.5 text-success" />
                <span className="text-success font-medium">已发送到对话</span>
              </>
            ) : (
              <>
                <span>发送到对话</span>
                <kbd className="ml-1 text-[10px] font-mono opacity-70 bg-muted px-1.5 py-0.5 rounded border border-border">Ctrl+L</kbd>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

const DiffViewer: React.FC<{ tab: EditorTab; mode: "split" | "unified" }> = ({ tab, mode }) => {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    let destroy = () => {};
    let cancelled = false;
    void languageFor(tab.path).then((lang) => {
      if (cancelled || !host.current) return;
      const ext = [baseExtensions({ readOnly: true }), lang ?? []];
      const docA = tab.savedText.replace(/\r\n/g, "\n");
      const docB = tab.text.replace(/\r\n/g, "\n");
      if (mode === "split") {
        const mv = new MergeView({
          a: { doc: docA, extensions: ext },
          b: { doc: docB, extensions: ext },
          parent: host.current,
          collapseUnchanged: { margin: 3, minSize: 6 },
          gutter: true,
        });
        destroy = () => mv.destroy();
      } else {
        const v = new EditorView({
          state: EditorState.create({
            doc: docB,
            extensions: [ext, unifiedMergeView({ original: docA, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 6 } })],
          }),
          parent: host.current,
        });
        destroy = () => v.destroy();
      }
    });
    return () => {
      cancelled = true;
      destroy();
    };
  }, [tab.text, tab.savedText, tab.path, mode]);
  return <div ref={host} className="acp-merge h-full overflow-auto" />;
};

export const EditorPane: React.FC<{ cwd: string | null }> = ({ cwd }) => {
  const tabs = useWorkbenchStore((s) => s.tabs);
  const activeId = useWorkbenchStore((s) => s.activeId);
  const { setActive, closeTab, pinTab, closeOthers } = useWorkbenchStore.getState();
  // 窄屏默认统一视图，宽屏默认并排
  const [diffMode, setDiffMode] = useState<"split" | "unified">(() => (typeof window !== "undefined" && window.innerWidth < 1600 ? "unified" : "split"));
  const active = tabs.find((t) => t.id === activeId) ?? null;

  useEffect(() => {
    for (const id of [...states.keys()]) if (!tabs.some((t) => t.id === id)) states.delete(id);
  }, [tabs]);

  const requestClose = (t: EditorTab) => {
    if (isDirty(t) && !window.confirm(`${t.path} 有未保存的修改，确定关闭？`)) return;
    closeTab(t.id);
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <div role="tablist" className="flex h-9 shrink-0 items-end overflow-x-auto border-b border-border bg-muted/30">
        {tabs.map((t) => {
          const dirty = isDirty(t);
          const name = t.path.split("/").pop();
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === activeId}
              title={t.path}
              draggable={t.kind === "file"}
              onDragStart={(e) => {
                if (t.kind !== "file") return;
                const refs: import("@/lib/composer-drop").DragRef[] = [{ path: t.path, kind: "file" }];
                setActiveDragRefs(refs);
                e.dataTransfer.setData(ACP_PATH_MIME, encodeDragRefs(refs));
                e.dataTransfer.setData("text/plain", `@${t.path}`);
                e.dataTransfer.effectAllowed = "copyMove";
              }}
              onDragEnd={() => {
                setActiveDragRefs(null);
              }}
              onClick={() => setActive(t.id)}
              onDoubleClick={() => pinTab(t.id)}
              onAuxClick={(e) => e.button === 1 && requestClose(t)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (window.confirm("关闭其他标签页？（未保存的会保留）")) closeOthers(t.id);
              }}
              className={cn(
                "group flex h-full max-w-56 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 text-[12.5px]",
                t.id === activeId ? "bg-background text-foreground shadow-[inset_0_1px_0_hsl(var(--foreground))]" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.kind === "diff" && <GitCompare className="h-3.5 w-3.5 shrink-0" />}
              <span className={cn("truncate", t.preview && "italic")}>{name}{t.kind === "diff" ? " (对比)" : ""}</span>
              <button
                aria-label={dirty ? "未保存，点击关闭" : "关闭"}
                onClick={(e) => { e.stopPropagation(); requestClose(t); }}
                className="ml-0.5 flex h-4 w-4 items-center justify-center rounded hover:bg-accent"
              >
                {dirty ? (
                  <>
                    <Circle className="h-2 w-2 fill-current group-hover:hidden" />
                    <X className="hidden h-3 w-3 group-hover:block" />
                  </>
                ) : (
                  <X className={cn("h-3 w-3", t.id !== activeId && "opacity-0 group-hover:opacity-100")} />
                )}
              </button>
            </div>
          );
        })}
        <div className="flex-1" />
        {active?.kind === "diff" && (
          <div className="flex h-full items-center gap-1 px-2 text-muted-foreground">
            <button title="并排对比" onClick={() => setDiffMode("split")} className={cn("rounded p-1 hover:bg-accent", diffMode === "split" && "text-foreground bg-accent")}><Columns2 className="h-3.5 w-3.5" /></button>
            <button title="统一对比" onClick={() => setDiffMode("unified")} className={cn("rounded p-1 hover:bg-accent", diffMode === "unified" && "text-foreground bg-accent")}><Rows2 className="h-3.5 w-3.5" /></button>
          </div>
        )}
        {active?.kind === "file" && (isMarkdown(active.path) || isNotebook(active.path)) && (
          <div className="mr-1 flex h-6 items-center rounded-md border border-border p-0.5 text-[11px]" role="group" aria-label="视图">
            {(isNotebook(active.path) ? (["notebook", "source"] as const) : (["preview", "wysiwyg", "source"] as const)).map((v) => (
              <button
                key={v}
                onClick={() => useWorkbenchStore.getState().patchTab(active.id, { view: v })}
                className={cn("rounded px-2 py-0.5", viewOf(active) === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {v === "preview" ? "阅读" : v === "wysiwyg" ? "编辑" : v === "notebook" ? "笔记本" : "源码"}
              </button>
            ))}
          </div>
        )}
        {active?.kind === "file" && cwd && (
          <div className="flex h-full items-center gap-1 px-2 text-[11px] text-muted-foreground">
            <button
              className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground flex items-center gap-1"
              onClick={() => {
                const ext = active.path.split(".").pop()?.toLowerCase() || "";
                sendSnippetToComposer({
                  path: active.path,
                  code: active.text,
                  lang: ext,
                  cwd,
                });
              }}
              title="将文件/选中代码发送到对话 (Ctrl+L)"
            >
              <MessageSquareShare className="inline h-3.5 w-3.5" />
            </button>
            <button className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground" onClick={() => void openDiff(cwd, active.path)} title="与 HEAD 对比">
              <GitCompare className="inline h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {active?.conflict && cwd && (
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-warning/10 px-3 py-1.5 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 text-warning" />
          <span className="flex-1">磁盘上的文件已被修改（可能是 AI 改的），而你有未保存的改动。</span>
          <button className="rounded border border-border px-2 py-0.5 hover:bg-accent" onClick={() => acceptDisk(active.id)}>用磁盘版本</button>
          <button className="rounded border border-border px-2 py-0.5 hover:bg-accent" onClick={() => void saveTab(cwd, active.id, { force: true })}>覆盖保存</button>
          <button className="rounded border border-border px-2 py-0.5 hover:bg-accent" onClick={() => void openDiff(cwd, active.path)}>对比</button>
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        {!active ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">在文件树里单击预览、双击固定打开文件</div>
        ) : active.loading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在打开…</div>
        ) : active.error && active.kind === "file" && !active.text ? (
          <div className="flex h-full items-center justify-center text-xs text-destructive">{active.error}</div>
        ) : active.kind === "diff" ? (
          <DiffViewer key={active.id + diffMode} tab={active} mode={diffMode} />
        ) : viewOf(active) === "notebook" ? (
          <Suspense fallback={<div className="p-4 text-xs text-muted-foreground">正在加载笔记本查看器…</div>}>
            <NotebookViewer text={active.text} />
          </Suspense>
        ) : viewOf(active) === "preview" ? (
          <div className="h-full overflow-y-auto px-8 py-6 select-text">
            <div className="max-w-4xl mx-auto">
              <AcpStandaloneMarkdown content={active.text} className="text-sm leading-relaxed" />
            </div>
          </div>
        ) : viewOf(active) === "wysiwyg" ? (
          <Suspense fallback={<div className="p-4 text-xs text-muted-foreground">正在加载编辑器…</div>}>
            <MarkdownWysiwyg
              key={active.id + ":wysiwyg"}
              value={active.text}
              original={active.savedText}
              onChange={(text) => {
                const cur = useWorkbenchStore.getState().tabs.find((t) => t.id === active.id);
                if (cur) {
                  const curNorm = cur.text.replace(/\r\n/g, "\n");
                  const nextNorm = text.replace(/\r\n/g, "\n");
                  if (curNorm !== nextNorm) useWorkbenchStore.getState().patchTab(active.id, { text, preview: false });
                }
              }}
            />
          </Suspense>
        ) : (
          <FileEditor key={active.id} tab={active} cwd={cwd} />
        )}
      </div>

      {active && (
        <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-3 font-mono text-[11px] text-muted-foreground">
          <span className="truncate">{active.path}</span>
          <span className="flex-1" />
          {active.kind === "file" && (active.saving ? <span className="text-primary animate-pulse">保存中…</span> : isDirty(active) ? <span className="text-warning">● 未保存 · Ctrl/⌘+S 保存</span> : <span>已保存</span>)}
          {active.kind === "diff" && <span>HEAD ↔ 工作区（只读）</span>}
        </div>
      )}
    </div>
  );
};

export default EditorPane;
