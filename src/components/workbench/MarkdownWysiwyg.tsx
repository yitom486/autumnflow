/**
 * Markdown 可视化编辑（Milkdown：CommonMark + GFM + 历史 + 监听）。随 EditorPane 再懒加载一层，
 * 只有用户切到"编辑"视图时才下载。保存走 preserveUnchangedBlocks，避免只有格式变化的 diff。
 */
import React, { useEffect, useRef, useState } from "react";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { preserveUnchangedBlocks } from "@/lib/markdown-roundtrip";

export const MarkdownWysiwyg: React.FC<{
  value: string;
  original: string;
  onChange: (text: string) => void;
}> = ({ value, original, onChange }) => {
  const host = useRef<HTMLDivElement>(null);
  const [reformatted, setReformatted] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const originalRef = useRef(original);
  originalRef.current = original;

  useEffect(() => {
    if (!host.current) return;
    let baseline = "";
    let editor: Editor | null = null;
    let disposed = false;
    void Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, host.current!);
        ctx.set(defaultValueCtx, value);
        ctx.get(listenerCtx).markdownUpdated((_ctx, md) => {
          if (disposed || !baseline) return;
          const r = preserveUnchangedBlocks(originalRef.current, baseline, md);
          setReformatted(r.reformatted);
          // 当前标签文本若是在源码模式下改过的，以编辑器内容为准
          onChangeRef.current(r.text);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .create()
      .then((ed) => {
        if (disposed) {
          void ed.destroy();
          return;
        }
        editor = ed;
        ed.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          baseline = ctx.get(serializerCtx)(view.state.doc);
        });
      });
    return () => {
      disposed = true;
      void editor?.destroy();
    };
    // 只在挂载时用初始 value 建编辑器（切回源码再切过来会重建）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col">
      {reformatted && (
        <div className="shrink-0 border-b border-border bg-warning/10 px-3 py-1 text-[11px] text-foreground">
          这份文档无法逐块保留原格式，保存时会按编辑器的 Markdown 风格统一格式（可切回“源码”检查）。
        </div>
      )}
      <div ref={host} className="acp-wysiwyg acp-md flex-1 overflow-y-auto px-8 py-6 text-sm leading-relaxed" />
    </div>
  );
};

export default MarkdownWysiwyg;
