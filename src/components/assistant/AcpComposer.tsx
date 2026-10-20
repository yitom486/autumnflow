import React, { useEffect, useMemo, useRef, useState } from "react";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import {
  Brain,
  Command,
  Cpu,
  ImagePlus,
  AtSign,
  LayoutGrid,
  Paperclip,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  X,
  ChevronDown,
  ArrowUp,
  Laptop,
  FolderOpen,
  FileDiff,
  Terminal,
  ExternalLink,
  Folder,
  Clock,
  Check,
  FileText,
  Zap,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { configCurrentValue, findConfigOption, extractModelThinking, searchWorkspaceFiles, readWorkspaceFile, type Attachment, type ConfigOptionLike, type ModelCatalogEntry, type WorkspaceFileEntry } from "@/lib/universal-api";
import { matchMentionToken, applyMentionInsert, buildMentionAttachment, formatFileSize } from "@/lib/mention";
import { ACP_PATH_MIME, decodeDragRefs, getActiveDragRefs, relativeToWorkspace, classifyOutsideFile, collectFolderFiles, stripMentionText, FOLDER_FILE_CAP, OUTSIDE_FILE_MAX, type DragRef } from "@/lib/composer-drop";
import { fsList } from "@/lib/fs-api";
import { matchSlashToken, replaceSlashToken, mergeCommands, filterCommands, type SlashCommand } from "@/lib/slash-commands";
import { ACP_INSERT_SNIPPET_EVENT, ACP_COMPOSER_DROP_EVENT, formatSnippetPrompt, type CodeSnippetPayload, type ComposerDropPayload } from "@/lib/composer-bridge";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";
import { getWorkspaceEnv, type QueuedPrompt } from "@/stores/useStudioStore";

export interface AcpComposerProps {
  onSendAttachmentOnly: () => void;
  onClear: () => void;
  isStreaming: boolean;
  /** Agent-advertised commands (ACP available_commands_update); local built-ins are merged in here. */
  commands: SlashCommand[];
  supportImage: boolean;
  attachments: Attachment[];
  setAttachments: (a: Attachment[]) => void;
  agentTitle: string;
  configOptions?: ConfigOptionLike[] | null;
  onSetConfig?: (configId: string, value: unknown) => void;
  onBrowseModels?: () => void;
  hasModelCatalog?: boolean;
  connected?: boolean;
  fallbackModels?: ModelCatalogEntry[] | null;
  fallbackCurrentModel?: string;
  onFallbackModel?: (modelId: string) => void;
  onEnsureSession?: () => void;
  /** session/new 在途：模型区显示加载态而非“点击加载”。 */
  sessionLoading?: boolean;
  /** 中断当前生成（插队发送用；需等待其落定再发送）。 */
  onStop?: () => Promise<void>;
  /** Prompts typed while the agent was working; shown so they can be withdrawn. */
  queuedPrompts?: QueuedPrompt[];
  /** Withdraw a queued prompt before it is sent. */
  onWithdraw?: (id: string) => void;
  /** Queue a prompt typed while the agent is working. */
  onQueue?: (text: string) => void;
  /** Interrupt the running turn and send this prompt right away. */
  onSteer?: (text: string) => Promise<void>;
  /** Text the app hands back after a failed send (the composer cleared it). */
  restoredText?: string;
  currentWorkspace?: string | null;
  recentWorkspaces?: Array<{ path: string; name: string; lastOpened: number }>;
  onSelectWorkspace?: (path: string, name?: string) => void;
  onOpenChanges?: () => void;
  onToggleTerminal?: () => void;
}

const TEXTISH = /^(text\/|application\/(json|javascript|typescript|xml|x-www-form-urlencoded)|.*\+(json|xml)$)/;

function readFile(file: File, supportImage: boolean): Promise<{ text?: string; dataUrl?: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("读取文件失败"));
    if (file.type.startsWith("image/") && supportImage) {
      r.onload = () => resolve({ dataUrl: String(r.result || "") });
      r.readAsDataURL(file);
    } else if (TEXTISH.test(file.type) || file.type === "") {
      r.onload = () => resolve({ text: String(r.result || "") });
      r.readAsText(file);
    } else if (file.size < 512 * 1024) {
      r.onload = () => resolve({ text: String(r.result || "") });
      r.readAsText(file);
    } else {
      r.onload = () => resolve({ dataUrl: String(r.result || "") });
      r.readAsDataURL(file);
    }
  });
}

function curVal(opt: ConfigOptionLike): string {
  return configCurrentValue(opt);
}

function pickRole(options: ConfigOptionLike[] | null | undefined, role: "model" | "thinking" | "permission"): ConfigOptionLike | undefined {
  return findConfigOption(options, role);
}

/**
 * 大图发送前客户端压缩：最长边 >1600px 时等比缩放 (canvas)，jpeg/webp
 * 质量 0.85。失败时抛给调用方 fallback 原图 (best-effort，不阻断发送)。
 */
async function downscaleImage(dataUrl: string, mimeType: string): Promise<string> {
  const MAX_DIM = 1600;
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  if (bitmap.width <= MAX_DIM && bitmap.height <= MAX_DIM) {
    bitmap.close();
    return dataUrl;
  }
  const scale = MAX_DIM / Math.max(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return dataUrl;
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const quality = mimeType === "image/jpeg" || mimeType === "image/webp" ? 0.85 : undefined;
  return canvas.toDataURL(mimeType, quality);
}

export const AcpComposer: React.FC<AcpComposerProps> = (p) => {
  const aui = useAui();
  const composerText = useAuiState((s) => s.composer.text);
  const canCancel = useAuiState((s) => s.composer.canCancel);
  const fileRef = useRef<HTMLInputElement>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const h = (e: MouseEvent) => moreRef.current && !moreRef.current.contains(e.target as Node) && setMoreOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setMoreOpen(false);
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [moreOpen]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  // @-mention workspace files (gateway search, debounced)
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionItems, setMentionItems] = useState<WorkspaceFileEntry[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionTruncated, setMentionTruncated] = useState(false);
  const mentionReqRef = useRef(0);
  const [localMenuOpen, setLocalMenuOpen] = useState(false);
  const localMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (localMenuRef.current && !localMenuRef.current.contains(e.target as Node)) {
        setLocalMenuOpen(false);
      }
    };
    if (localMenuOpen) document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [localMenuOpen]);

  const handleOpenFolder = () => {
    setLocalMenuOpen(false);
    useWorkbenchStore.getState().openWorkspacePicker();
  };

  const handleRevealInExplorer = async () => {
    setLocalMenuOpen(false);
    if (p.currentWorkspace && window.autumnflow?.openPath) {
      await window.autumnflow.openPath(p.currentWorkspace);
    }
  };

  const token = matchSlashToken(composerText);
  const allCommands = useMemo(() => mergeCommands(p.commands), [p.commands]);
  const filtered = filterCommands(allCommands, token);
  // Open whenever a `/` token is typed — even with no agent commands (empty-state hint)
  // and while streaming (browse only; Enter fills in, never sends).
  const showSlash = !!token;
  // Argument hint for an already-inserted command: "/name " or "/name partial-arg".
  const activeHint = (() => {
    const m = composerText.match(/^\s*\/(\S+)\s([\s\S]*)$/);
    if (!m) return null;
    const c = allCommands.find((x) => x.name === m[1]);
    return c?.hint && !m[2].trim() ? c : null;
  })();

  useEffect(() => {
    setSlashIdx(0);
    setSlashOpen(showSlash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, allCommands.length]);

  const applyCommand = (name: string) => {
    aui.composer.setText(replaceSlashToken(composerText, name));
    setSlashOpen(false);
  };

  const mentionToken = matchMentionToken(composerText);
  const mentionQuery = mentionToken ? mentionToken.slice(1) : null;

  // Debounced gateway file search for the trailing @-token.
  useEffect(() => {
    setMentionIdx(0);
    if (!mentionToken || p.isStreaming) {
      setMentionOpen(false);
      setMentionItems([]);
      return;
    }
    setMentionOpen(true);
    const cwd = p.currentWorkspace;
    if (!cwd) {
      setMentionItems([]);
      return;
    }
    setMentionLoading(true);
    const myReq = ++mentionReqRef.current;
    const t = setTimeout(() => {
      searchWorkspaceFiles(cwd, mentionQuery || "", 8)
        .then((res) => {
          if (mentionReqRef.current !== myReq) return;
          setMentionItems(res.files);
          setMentionTruncated(res.truncated);
        })
        .catch((err) => {
          if (mentionReqRef.current !== myReq) return;
          console.debug("[AcpComposer] @ 文件搜索失败 (已忽略):", err);
          setMentionItems([]);
        })
        .finally(() => {
          if (mentionReqRef.current === myReq) setMentionLoading(false);
        });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionToken, p.currentWorkspace, p.isStreaming]);

  const applyMention = async (filePath: string) => {
    const cwd = p.currentWorkspace;
    if (!cwd) return;
    setMentionOpen(false);
    try {
      const f = await readWorkspaceFile(cwd, filePath);
      p.setAttachments([...p.attachments, { ...buildMentionAttachment(f), mention: { path: filePath, kind: "file" } }]);
      aui.composer.setText(applyMentionInsert(composerText, filePath));
    } catch (err: any) {
      alert(`引用 ${filePath} 失败: ${err.message}`);
    }
  };

  // The runtime keeps the composer inside the thread scope, and it rebuilds
  // that scope whenever the app restores its session. The text the user just
  // typed lived only in that scope and was gone. Keep a copy here and put it
  // back; the copy is dropped as soon as the text is sent, queued or steered.
  const draftRef = useRef("");
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    draftRef.current = e.target.value;
  };
  const clearDraft = () => {
    draftRef.current = "";
  };
  useEffect(() => {
    // Whatever the composer holds now (typed or filled in by the app) is the
    // text to keep. An empty composer is either cleared by the user — the
    // input handler already dropped the copy — or dropped by the runtime.
    if (composerText) {
      draftRef.current = composerText;
      return;
    }
    if (draftRef.current) aui.composer.setText(draftRef.current);
  }, [composerText]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the agent is working, assistant-ui's own send() is a no-op
    // (canSend is false while a message is in flight), so a typed prompt
    // would never reach the app. Route it to the queue instead.
    if (p.isStreaming && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      const text = composerText.trim();
      if (!text) return;
      e.preventDefault();
      clearDraft();
      p.onQueue?.(text);
      aui.composer.setText("");
      return;
    }
    if (slashOpen && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        applyCommand(filtered[slashIdx].name);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        const sel = filtered[slashIdx];
        if (token !== `/${sel.name}` || p.isStreaming) {
          // Fill in the command instead of sending (always while streaming).
          e.preventDefault();
          applyCommand(sel.name);
          return;
        }
      }
      if (e.key === "Escape") {
        setSlashOpen(false);
        return;
      }
    }
    if (slashOpen && e.key === "Escape") {
      setSlashOpen(false);
      return;
    }
    if (slashOpen && p.isStreaming && e.key === "Enter" && !e.shiftKey) {
      // Browsing the (empty) menu while streaming must never send.
      e.preventDefault();
      return;
    }
    if (mentionOpen && mentionItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      // Tab 选中文件 (Enter 始终发送，与 primitive 发送不冲突)。
      if (e.key === "Tab") {
        e.preventDefault();
        void applyMention(mentionItems[mentionIdx].path);
        return;
      }
      if (e.key === "Escape") {
        setMentionOpen(false);
        return;
      }
    }
  };

  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const next = [...p.attachments];
    const rejectedImages: string[] = [];
    const tooBig: string[] = [];
    for (const file of Array.from(files)) {
      const kind = classifyOutsideFile(file, p.supportImage);
      if (kind === "reject-image") { rejectedImages.push(file.name || "图片"); continue; }
      if (kind === "reject-size") { tooBig.push(file.name); continue; }
      try {
        const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        if (kind === "image") {
          const { dataUrl } = await readFile(file, true);
          if (!dataUrl) continue;
          let payload = dataUrl.split(",")[1] || "";
          let size = file.size;
          const preview: string | undefined = URL.createObjectURL(file);
          try {
            const small = await downscaleImage(dataUrl, file.type);
            payload = small.split(",")[1] || payload;
            size = Math.round((payload.length * 3) / 4);
          } catch (err) {
            console.debug("[AcpComposer] 图片压缩失败，已回退原图 (已忽略):", err);
          }
          next.push({ id, name: file.name, mimeType: file.type, size, preview, block: { type: "image", data: payload, mimeType: file.type } });
        } else if (kind === "text") {
          const { text } = await readFile(file, false);
          next.push({ id, name: file.name, mimeType: file.type || "text/plain", size: file.size, block: { type: "resource", resource: { uri: `file:///${file.name}`, mimeType: file.type || "text/plain", text: text ?? "" } } });
        } else {
          next.push({ id, name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, block: { type: "resource_link", name: file.name, uri: `file:///${file.name}`, mimeType: file.type || undefined, size: file.size } });
        }
      } catch (err: any) {
        alert(`附件 ${file.name} 读取失败: ${err.message}`);
      }
    }
    p.setAttachments(next);
    if (fileRef.current) fileRef.current.value = "";
    const msgs: string[] = [];
    if (rejectedImages.length) msgs.push(`${p.agentTitle || "当前智能体"} 不支持图片输入（未声明 image 能力），已忽略：${rejectedImages.join("、")}。可换用支持图片的智能体，或把图片保存到工作区后用 @ 引用路径。`);
    if (tooBig.length) msgs.push(`超过 ${OUTSIDE_FILE_MAX / 1024 / 1024}MB 的文件未添加：${tooBig.join("、")}`);
    if (msgs.length) setNotice(msgs.join(" "));
  };

  /** 工作区内的文件 / 文件夹 → @ 引用（文件夹最多展开 FOLDER_FILE_CAP 个文件）。 */
  const addRefs = async (refs: DragRef[]) => {
    const cwd = p.currentWorkspace;
    if (!cwd || refs.length === 0) return;
    const added: Attachment[] = [];
    let text = aui.composer.getState().text;
    const notes: string[] = [];
    const have = new Set(p.attachments.map((a) => a.mention?.path).filter(Boolean));

    for (const r of refs) {
      // 保证用户拖入的 @引用 文本一定被记录进输入框
      const label = r.kind === "dir" ? `${r.path.replace(/\/$/, "")}/` : r.path;
      text = `${text}${text && !/\s$/.test(text) ? " " : ""}@${label} `;

      try {
        if (r.kind === "dir") {
          let files: string[] = [];
          try {
            const res = await collectFolderFiles(r.path, (d) => fsList(cwd, d));
            files = res.files;
            if (res.truncated) notes.push(`文件夹 ${r.path || "."} 只引用了前 ${FOLDER_FILE_CAP} 个文件`);
          } catch (e: any) {
            notes.push(`遍历文件夹 ${r.path} 失败：${e.message}`);
          }
          for (const fp of files) {
            if (have.has(fp)) continue;
            try {
              const f = await readWorkspaceFile(cwd, fp);
              have.add(fp);
              added.push({ ...buildMentionAttachment(f), mention: { path: fp, kind: "file" } });
            } catch {
              // 二进制/超限文件无法作为文本附件，已保留 @ 引用
            }
          }
        } else {
          if (!have.has(r.path)) {
            try {
              const f = await readWorkspaceFile(cwd, r.path);
              have.add(r.path);
              added.push({ ...buildMentionAttachment(f), mention: { path: r.path, kind: "file" } });
            } catch {
              // 读取失败不阻塞 @ 引用文本
            }
          }
        }
      } catch (err: any) {
        notes.push(`引用 ${r.path} 失败：${err.message}`);
      }
    }

    if (added.length) p.setAttachments([...p.attachments, ...added]);
    aui.composer.setText(text);
    if (notes.length) setNotice(notes.join("；"));

    // 自动聚焦输入框
    requestAnimationFrame(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"], textarea');
      textarea?.focus();
    });
  };

  const processDropData = async (payload: ComposerDropPayload) => {
    const internal = (payload.internalRefs && payload.internalRefs.length) ? payload.internalRefs : getActiveDragRefs();
    if (internal && internal.length) {
      await addRefs(internal);
      return;
    }
    const cwd = p.currentWorkspace;
    const refs: DragRef[] = [];
    const outside: File[] = [];
    let outsideDirs = 0;
    (payload.files || []).forEach((file) => {
      const isDir = !!(file as any).isDirectory;
      const abs = (file as any).path || window.autumnflow?.workbench?.pathForFile?.(file) || "";
      const rel = cwd && abs ? relativeToWorkspace(cwd, abs) : null;
      if (rel !== null && rel !== "") refs.push({ path: rel, kind: isDir ? "dir" : "file" });
      else if (isDir) outsideDirs++;
      else outside.push(file);
    });
    if (refs.length) await addRefs(refs);
    if (outside.length) await handleFiles(outside);
    if (outsideDirs) setNotice(`工作区外的文件夹不能直接拖入（${outsideDirs} 个已忽略），请拖入其中的文件。`);
    if (payload.text && !refs.length && !outside.length) {
      const plain = payload.text.trim();
      const match = plain.match(/^@([^\s]+)$/);
      if (match && cwd) {
        const rawPath = match[1].replace(/\/$/, "");
        const isDir = plain.endsWith("/");
        await addRefs([{ path: rawPath, kind: isDir ? "dir" : "file" }]);
        return;
      }
      const cur = aui.composer.getState().text;
      aui.composer.setText(cur ? `${cur} ${payload.text}` : payload.text);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dt = e.dataTransfer;
    if (!dt) return;

    // 1. 优先提取内部拖拽引用（自定义 MIME 或全局活动引用）
    const internal = decodeDragRefs(dt.getData(ACP_PATH_MIME));
    const activeRefs = internal.length ? internal : getActiveDragRefs();
    if (activeRefs && activeRefs.length) {
      await addRefs(activeRefs);
      return;
    }

    // 2. 检查从 OS 拖入的文件/目录（通过 DataTransfer.files / webkitGetAsEntry）
    const cwd = p.currentWorkspace;
    const refs: DragRef[] = [];
    const outside: File[] = [];
    const items = Array.from(dt.items || []);
    let outsideDirs = 0;
    Array.from(dt.files || []).forEach((file, i) => {
      const entry = (items[i] as any)?.webkitGetAsEntry?.();
      const isDir = !!entry?.isDirectory;
      const abs = (file as any).path || window.autumnflow?.workbench?.pathForFile?.(file) || "";
      const rel = cwd && abs ? relativeToWorkspace(cwd, abs) : null;
      if (rel !== null && rel !== "") refs.push({ path: rel, kind: isDir ? "dir" : "file" });
      else if (isDir) outsideDirs++;
      else outside.push(file);
    });
    if (refs.length) await addRefs(refs);
    if (outside.length) await handleFiles(outside);
    if (outsideDirs) setNotice(`工作区外的文件夹不能直接拖入（${outsideDirs} 个已忽略），请拖入其中的文件。`);

    // 3. 兜底纯文本拖拽（如由别处拖来的 @文件路径）
    if (!refs.length && !outside.length) {
      const plain = dt.getData("text/plain")?.trim();
      if (plain) {
        const match = plain.match(/^@([^\s]+)$/);
        if (match && cwd) {
          const rawPath = match[1].replace(/\/$/, "");
          const isDir = plain.endsWith("/");
          await addRefs([{ path: rawPath, kind: isDir ? "dir" : "file" }]);
          return;
        }
        const cur = aui.composer.getState().text;
        aui.composer.setText(cur ? `${cur} ${plain}` : plain);
      }
    }
  };

  useEffect(() => {
    const handleInsertSnippet = async (e: Event) => {
      const detail = (e as CustomEvent<CodeSnippetPayload>).detail;
      if (!detail) return;
      const formatted = formatSnippetPrompt(detail);
      const curText = aui.composer.getState().text;
      const newText = curText ? `${curText}\n\n${formatted}\n` : `${formatted}\n`;
      aui.composer.setText(newText);

      // 如果有当前工作区并且尚未关联附件，补充附件引用
      const cwd = detail.cwd || p.currentWorkspace;
      if (cwd && detail.path) {
        const have = new Set(p.attachments.map((a) => a.mention?.path).filter(Boolean));
        if (!have.has(detail.path)) {
          try {
            const f = await readWorkspaceFile(cwd, detail.path);
            p.setAttachments([...p.attachments, { ...buildMentionAttachment(f), mention: { path: detail.path, kind: "file" } }]);
          } catch {
            // 附件添加失败不阻塞文本插入
          }
        }
      }

      // 自动聚焦输入框
      requestAnimationFrame(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer-input"], textarea');
        textarea?.focus();
        if (textarea) textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      });
    };

    const handleComposerDrop = (e: Event) => {
      const detail = (e as CustomEvent<ComposerDropPayload>).detail;
      if (!detail) return;
      void processDropData(detail);
    };

    window.addEventListener(ACP_INSERT_SNIPPET_EVENT, handleInsertSnippet);
    window.addEventListener(ACP_COMPOSER_DROP_EVENT, handleComposerDrop);
    return () => {
      window.removeEventListener(ACP_INSERT_SNIPPET_EVENT, handleInsertSnippet);
      window.removeEventListener(ACP_COMPOSER_DROP_EVENT, handleComposerDrop);
    };
  }, [aui, p.attachments, p.setAttachments, p.currentWorkspace]);

  const handlePaste = (e: React.ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  };

  const removeAttachment = (id: string) => {
    const target = p.attachments.find((a) => a.id === id);
    if (target?.preview) URL.revokeObjectURL(target.preview);
    p.setAttachments(p.attachments.filter((x) => x.id !== id));
    if (target?.mention) aui.composer.setText(stripMentionText(aui.composer.getState().text, target.mention.path));
  };

  const modelOpt = pickRole(p.configOptions, "model");
  const thinkOpt = pickRole(p.configOptions, "thinking");
  const permOpt = pickRole(p.configOptions, "permission");
  const otherOpts = (p.configOptions || []).filter((o) => o !== modelOpt && o !== thinkOpt && o !== permOpt);
  const currentModelValue = modelOpt ? curVal(modelOpt) : (p.fallbackCurrentModel || "");
  const modelThinking = extractModelThinking(currentModelValue);

  const muted = (text: string, title?: string) => (
    <span className="text-[11px] text-muted-foreground font-mono" title={title}>{text}</span>
  );

  const renderFallbackModel = () => {
    const list = p.fallbackModels || [];
    if (list.length === 0) {
      if (p.sessionLoading) {
        return (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title="正在创建会话以加载可用模型">
            <Cpu className="w-3.5 h-3.5 text-signal animate-pulse shrink-0" />
            <span className="inline-flex items-center text-muted-foreground text-[11px]">模型加载中…</span>
          </span>
        );
      }
      return (
        <button type="button" onClick={() => p.onEnsureSession?.()} title="点击创建会话以加载可用模型" className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors cursor-pointer">
          <Cpu className="w-3.5 h-3.5" />点击加载模型
        </button>
      );
    }
    return (
      <label className="flex items-center gap-1 text-xs text-muted-foreground" title="该 Agent 未提供模型配置项，使用会话模型目录切换">
        <Cpu className="w-3.5 h-3.5 text-primary shrink-0" />
        <select value={p.fallbackCurrentModel || ""} disabled={p.isStreaming} onChange={(e) => e.target.value && p.onFallbackModel?.(e.target.value)} className="bg-transparent border-0 rounded-lg px-1 py-1 text-xs font-medium text-foreground outline-none cursor-pointer max-w-[170px] @max-md:max-w-[96px] @max-xs:max-w-[52px] truncate disabled:opacity-50 hover:bg-muted/80">
          {list.map((m) => (
            <option key={m.modelId} value={m.modelId} className="bg-card" title={m.description}>{m.name || m.modelId}</option>
          ))}
        </select>
      </label>
    );
  };

  const renderOptionItem = (o: any) => {
    if (o && Array.isArray(o.options)) {
      return (
        <optgroup key={o.group || o.name} label={o.name || o.group} className="bg-card font-semibold text-muted-foreground">
          {o.options.map((sub: any) => (
            <option key={String(sub.value)} value={String(sub.value)} className="bg-card font-normal text-foreground" title={sub.description}>{sub.name || sub.value}</option>
          ))}
        </optgroup>
      );
    }
    return (
      <option key={String(o.value)} value={String(o.value)} className="bg-card font-normal text-foreground" title={o.description}>{o.name || o.value}</option>
    );
  };

  const renderSelect = (opt: ConfigOptionLike, icon: React.ReactNode) => (
    <label key={opt.id} className="flex items-center gap-1 text-xs text-muted-foreground" title={opt.description || opt.name}>
      {icon}
      <select value={curVal(opt)} disabled={p.isStreaming} onChange={(e) => p.onSetConfig?.(opt.id, e.target.value)} className="bg-transparent border-0 rounded-lg px-1 py-1 text-xs font-medium text-foreground outline-none cursor-pointer max-w-[170px] @max-md:max-w-[96px] @max-xs:max-w-[52px] truncate disabled:opacity-50 hover:bg-muted/80">
        {(opt.options || []).map(renderOptionItem)}
      </select>
    </label>
  );

  const canSendText = composerText.trim().length > 0;
  const canSendAny = canSendText || p.attachments.length > 0;

  // The composer clears its text on submit. When a send fails the app hands
  // the prompt back, and it has to land in the composer — not in a field
  // nobody shows. Only when the composer is empty, so a message the user
  // typed in the meantime is never overwritten.
  useEffect(() => {
    if (p.restoredText && !composerText) aui.composer.setText(p.restoredText);
  }, [p.restoredText, composerText]);

  const handleSendClick = () => {
    if (canSendText) {
      clearDraft();
      aui.composer.send();
    } else if (p.attachments.length > 0) p.onSendAttachmentOnly();
  };

  // 插队发送：中断当前生成，清空跑道后立即发送（排队中的旧消息随后继续）。
  const handleSteer = async () => {
    if (!canSendText) return;
    const text = composerText.trim();
    clearDraft();
    await p.onSteer?.(text);
    aui.composer.setText("");
  };

  return (
    <div className="p-4 md:p-6 bg-background shrink-0 select-none">
      <div className="max-w-3xl xl:max-w-4xl 2xl:max-w-5xl mx-auto space-y-2">
        {notice && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-foreground">
            <ImagePlus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span className="flex-1">{notice}</span>
            <button aria-label="关闭提示" onClick={() => setNotice(null)} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
          </div>
        )}
        {p.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1">
            {p.attachments.map((a) =>
              a.mention ? (
                <span
                  key={a.id}
                  data-mention-chip
                  className="inline-flex items-center gap-1 h-6 pl-1.5 pr-1 rounded-full border border-border bg-accent/60 text-[11.5px] font-mono text-foreground"
                  title={`@${a.mention.path} · ${formatFileSize(a.size)}（引用的文件内容随消息发送）`}
                >
                  <AtSign className="w-3 h-3 text-muted-foreground" />
                  <span className="max-w-[220px] truncate">{a.mention.path}</span>
                  <button aria-label={`移除引用 ${a.mention.path}`} onClick={() => removeAttachment(a.id)} className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-destructive">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ) : (
              <span key={a.id} className="flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-md bg-muted/70 border border-border text-[11px] font-mono text-muted-foreground">
                {a.preview ? (
                  <img src={a.preview} alt={a.name} className="w-6 h-6 rounded object-cover" />
                ) : String((a.block as any).type) === "image" ? (
                  <ImagePlus className="w-3.5 h-3.5 text-primary" />
                ) : (
                  <Paperclip className="w-3.5 h-3.5 text-primary" />
                )}
                <span className="max-w-[160px] truncate" title={`${a.name} (${a.mimeType}, ${(a.size / 1024).toFixed(1)}KB)`}>{a.name}</span>
                <button onClick={() => removeAttachment(a.id)} className="text-muted-foreground hover:text-destructive ml-0.5">
                  <X className="w-3 h-3" />
                </button>
              </span>
              ),
            )}
          </div>
        )}

        {p.queuedPrompts && p.queuedPrompts.length > 0 && (
          <ul data-testid="composer-queue" className="mb-2 flex flex-col gap-1">
            {p.queuedPrompts.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 text-[12px] text-foreground"
              >
                <Clock className="w-3 h-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate" title={item.text}>{item.text}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">排队中</span>
                <button
                  type="button"
                  onClick={() => p.onWithdraw?.(item.id)}
                  title="撤回这条排队消息"
                  aria-label={`撤回排队消息: ${item.text.slice(0, 40)}`}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <ComposerPrimitive.Root className="@container" onSubmit={clearDraft}>
          <div
            className={`relative flex flex-col rounded-xl border bg-card transition-colors ${
              dragOver
                ? "border-ring border-dashed"
                : canCancel
                ? "border-signal/60"
                : "border-input focus-within:border-ring/70"
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              if (!dragOver) setDragOver(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDragOver(false);
            }}
            onDrop={(e) => void handleDrop(e)}
          >
            {dragOver && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-muted/90 text-xs text-foreground pointer-events-none">
                松开以引用文件（工作区内变为 @ 引用，工作区外作为附件）
              </div>
            )}
            {slashOpen && (
              <div data-testid="slash-menu" className="absolute bottom-full mb-1.5 left-2 right-2 rounded-lg border border-border bg-popover shadow-lg overflow-hidden z-20 text-xs">
                {p.commands.length === 0 && (
                  <div className="px-3 py-2 text-muted-foreground border-b border-border/60">
                    该智能体暂未提供命令
                    <span className="ml-1 text-muted-foreground/70">{p.connected === false ? "（未连接）" : "（会话建立后智能体可能稍后推送）"}</span>
                  </div>
                )}
                {filtered.length === 0 ? (
                  <div className="px-3 py-2 text-muted-foreground">无匹配命令</div>
                ) : (
                  <div className="max-h-72 overflow-y-auto">
                    {filtered.slice(0, 12).map((c, i) => (
                      <div
                        key={(c.local ? "local:" : "agent:") + c.name}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyCommand(c.name)}
                        onMouseEnter={() => setSlashIdx(i)}
                        className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer ${i === slashIdx ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                      >
                        <Command className="w-3 h-3 shrink-0 text-muted-foreground" />
                        <span className="font-mono font-semibold text-foreground">/{c.name}</span>
                        {c.hint && <span className="font-mono text-muted-foreground/70 shrink-0">&lt;{c.hint}&gt;</span>}
                        <span className="truncate flex-1 min-w-0">{c.description || ""}</span>
                        {c.local && (
                          <span title="由 AutumnFlow 本地处理，不发送给智能体" className="shrink-0 rounded border border-border px-1 py-px text-[10px] text-muted-foreground">本地</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="px-3 py-1 border-t border-border/60 text-[10px] text-muted-foreground/80 flex justify-between gap-2">
                  <span>↑↓ 选择 · Tab/回车 填入 · Esc 关闭</span>
                  {p.isStreaming ? <span className="text-amber-600 dark:text-amber-400">生成中：仅浏览/填入，不会发送</span> : <span>智能体命令以 /命令 文本发送</span>}
                </div>
              </div>
            )}
            {!slashOpen && activeHint && (
              <div className="absolute bottom-full mb-1.5 left-2 rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-muted-foreground shadow z-20">
                <span className="font-mono text-foreground">/{activeHint.name}</span> 参数：<span className="font-mono">{activeHint.hint}</span>
              </div>
            )}
            {mentionOpen && (
              <div className="absolute bottom-full mb-1.5 left-2 right-2 rounded-lg border border-border bg-popover shadow-lg overflow-hidden z-20">
                {!p.currentWorkspace ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">先选择工作区，才能引用其中的文件</div>
                ) : mentionLoading && mentionItems.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground animate-pulse">正在搜索文件…</div>
                ) : mentionItems.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">无匹配文件（Tab 无效，继续输入过滤）</div>
                ) : (
                  <>
                    {mentionItems.slice(0, 8).map((f, i) => (
                      <div key={f.path} onClick={() => applyMention(f.path)} className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs ${i === mentionIdx ? "bg-muted text-foreground font-medium" : "text-muted-foreground"}`}>
                        <FileText className="w-3 h-3 text-muted-foreground shrink-0" />
                        <span className="font-mono truncate flex-1" title={f.path}>{f.path}</span>
                        <span className="font-mono text-[10px] text-muted-foreground/70 shrink-0 tabular-nums">{formatFileSize(f.size)}</span>
                      </div>
                    ))}
                    {mentionTruncated && (
                      <div className="px-3 py-1 text-[10px] font-mono text-muted-foreground/70 border-t border-border/60">仅显示前 8 个，继续输入过滤</div>
                    )}
                  </>
                )}
              </div>
            )}
            <ComposerPrimitive.Input
              minRows={2}
              maxRows={8}
              onChange={handleInputChange}
              onKeyDown={handleInputKeyDown}
              onPaste={handlePaste}
              placeholder={p.isStreaming ? `${p.agentTitle} 正在响应中…可继续编辑，发送将排队；或点插队立即打断` : `给 ${p.agentTitle} 描述任务，@ 引用文件，/ 调用命令`}
              className="w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 text-sm leading-6 text-foreground placeholder:text-muted-foreground/80 focus:outline-none max-h-48 min-h-[48px]"
            />
            <div className="flex items-center justify-between px-3 pb-2 pt-1 text-xs gap-2">
              {/* Left: only model + thinking stay visible; everything else lives in the "…" popover.
                  Container query: narrower composer → pills shrink to icon + truncated label. */}
              <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-nowrap">
                <input ref={fileRef} type="file" multiple accept={p.supportImage ? undefined : ".txt,.md,.json,.js,.ts,.tsx,.py,.log,.csv"} className="hidden" onChange={(e) => handleFiles(e.target.files)} />
                {p.connected ? (
                  <>
                    <div data-testid="composer-model" className="acp-pill flex items-center gap-1 min-w-0 bg-muted/40 hover:bg-muted/70 px-2 py-0.5 rounded-md border border-border/60 transition-colors">
                      {modelOpt ? renderSelect(modelOpt, <Cpu className="w-3 h-3 text-muted-foreground shrink-0" />) : renderFallbackModel()}
                    </div>
                    {thinkOpt ? (
                      <div data-testid="composer-effort" className="acp-pill flex items-center gap-1 min-w-0 bg-muted/40 hover:bg-muted/70 px-2 py-0.5 rounded-md border border-border/60 transition-colors">
                        {renderSelect(thinkOpt, <Brain className="w-3 h-3 text-muted-foreground shrink-0" />)}
                      </div>
                    ) : modelThinking ? (
                      <span className="hidden @sm:flex items-center gap-1 text-[11px] font-mono text-muted-foreground px-1.5 py-0.5 whitespace-nowrap" title={`思考: ${modelThinking}`}>
                        <Brain className="w-3 h-3 text-muted-foreground shrink-0" />
                        {modelThinking}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">未连接</span>
                )}

                {/* "…" popover: attach, /, permission (Auto review), mode, other options, model catalog */}
                <div className="relative shrink-0" ref={moreRef}>
                  <button
                    type="button"
                    onClick={() => setMoreOpen((v) => !v)}
                    title="更多：附件、命令、权限、模式与其他选项"
                    aria-label="更多输入选项"
                    aria-expanded={moreOpen}
                    data-testid="composer-more"
                    className={`w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${moreOpen ? "bg-accent text-foreground" : ""}`}
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                  </button>
                  {moreOpen && (
                    <div role="dialog" aria-label="更多输入选项" className="absolute bottom-full mb-2 left-0 w-64 rounded-lg border border-border bg-popover shadow-lg z-30 p-1.5 text-xs space-y-1">
                      <div className="flex items-center gap-1 pb-1 border-b border-border/60">
                        <button type="button" onClick={() => { setMoreOpen(false); fileRef.current?.click(); }} title={p.supportImage ? "附加文件或图片（可拖拽 / 粘贴）" : "附加文本文件"} className="flex-1 h-7 rounded-md flex items-center justify-center gap-1.5 text-muted-foreground hover:text-foreground hover:bg-accent">
                          <Paperclip className="w-3.5 h-3.5" /> 附件
                        </button>
                        <button type="button" onClick={() => { setMoreOpen(false); aui.composer.setText("/" + composerText.trimStart()); }} title="打开命令菜单" className="flex-1 h-7 rounded-md flex items-center justify-center gap-1.5 text-muted-foreground hover:text-foreground hover:bg-accent">
                          <span className="font-mono">/</span> 命令
                        </button>
                        {p.onBrowseModels && (
                          <button type="button" onClick={() => { setMoreOpen(false); p.onBrowseModels?.(); }} title={p.hasModelCatalog ? "浏览 / 发现模型库" : "发现可用模型"} className="flex-1 h-7 rounded-md flex items-center justify-center gap-1.5 text-muted-foreground hover:text-foreground hover:bg-accent">
                            <LayoutGrid className="w-3.5 h-3.5" /> 模型库
                          </button>
                        )}
                      </div>
                      {p.connected && (
                        <div className="space-y-1 pt-0.5">
                          {permOpt ? (
                            <div className="flex items-center justify-between gap-2 px-1.5 py-0.5 rounded-md hover:bg-muted/50">
                              <span className="text-muted-foreground">权限</span>
                              {renderSelect(permOpt, <ShieldCheck className="w-3 h-3 text-muted-foreground shrink-0" />)}
                            </div>
                          ) : (
                            <div className="px-1.5 py-0.5 text-muted-foreground/70" title="该 Agent 未提供权限配置">权限：—</div>
                          )}
                          {otherOpts.map((opt) =>
                            opt.type === "boolean" ? (
                              <label key={opt.id} className="flex items-center justify-between gap-2 px-1.5 py-1 rounded-md hover:bg-muted/50 cursor-pointer select-none" title={opt.description || opt.name}>
                                <span className="text-muted-foreground">{opt.name || opt.id}</span>
                                <input type="checkbox" checked={Boolean(opt.currentValue)} disabled={p.isStreaming} onChange={(e) => p.onSetConfig?.(opt.id, e.target.checked)} className="rounded border-border text-primary focus:ring-primary/20" />
                              </label>
                            ) : (
                              <div key={opt.id} className="flex items-center justify-between gap-2 px-1.5 py-0.5 rounded-md hover:bg-muted/50">
                                <span className="text-muted-foreground truncate">{opt.name || opt.id}</span>
                                {renderSelect(opt, <Settings2 className="w-3 h-3 text-muted-foreground shrink-0" />)}
                              </div>
                            )
                          )}
                          {!thinkOpt && !modelThinking && <div className="px-1.5 py-0.5 text-muted-foreground/70">思考：该 Agent 未提供独立思考等级</div>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Right actions: Clear and Send */}
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={p.onClear}
                  disabled={p.isStreaming}
                  title="清空聊天记录"
                  aria-label="清空聊天记录"
                  className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-accent transition-colors disabled:opacity-40"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>

                {canCancel ? (
                  <>
                    {canSendText && (
                      <button
                        type="button"
                        onClick={handleSteer}
                        title="插队发送：中断当前生成并立即发送（排队中的消息随后继续）"
                        className="h-7 px-2.5 rounded-md border border-signal/50 text-signal hover:bg-signal/10 flex items-center gap-1 text-xs font-medium cursor-pointer transition-colors"
                      >
                        <Zap className="w-3 h-3" />
                        <span>插队</span>
                      </button>
                    )}
                    <ComposerPrimitive.Cancel asChild>
                      <button
                        type="button"
                        title="停止生成"
                        className="h-7 px-2.5 rounded-md border border-border bg-secondary text-foreground hover:bg-accent flex items-center gap-1.5 text-xs font-medium cursor-pointer"
                      >
                        <Square className="w-3 h-3 fill-current" />
                        <span>停止</span>
                      </button>
                    </ComposerPrimitive.Cancel>
                  </>
                ) : (
                  <ComposerPrimitive.Send asChild>
                    <button
                      type="button"
                      data-testid="composer-send"
                      aria-label="发送消息"
                      onClick={(e) => {
                        if (!canSendText && p.attachments.length > 0) {
                          e.preventDefault();
                          p.onSendAttachmentOnly();
                          return;
                        }
                        if (canSendText) clearDraft();
                      }}
                      disabled={!canSendAny || (p.isStreaming && !canSendText)}
                      title={p.isStreaming ? "发送（将在当前生成结束后排队执行）" : "发送消息"}
                      className={`h-7 w-7 rounded-md flex items-center justify-center transition-colors cursor-pointer ${
                        canSendText || (!p.isStreaming && canSendAny)
                          ? "bg-primary text-primary-foreground hover:bg-primary/90"
                          : "bg-muted text-muted-foreground/60 cursor-not-allowed"
                      }`}
                    >
                      <ArrowUp className="w-4 h-4" />
                      <span className="sr-only">发送</span>
                    </button>
                  </ComposerPrimitive.Send>
                )}
              </div>
            </div>
          </div>
        </ComposerPrimitive.Root>

        {/* Antigravity Local Target Tag & Workspace Menu */}
        <div className="@container flex items-center justify-between gap-2 pt-0.5 px-1 text-xs text-muted-foreground select-none relative whitespace-nowrap">
          <div className="relative" ref={localMenuRef}>
            {(() => {
              const env = getWorkspaceEnv();
              const envLabel = env.startsWith("wsl_") ? `WSL: ${env.replace(/^wsl_/, "")}` : env.startsWith("remote") ? "远端" : "本机";
              return (
                <button
                  type="button"
                  onClick={() => setLocalMenuOpen(!localMenuOpen)}
                  className="inline-flex items-center gap-1.5 h-6 px-1.5 rounded-md hover:bg-accent text-[11px] text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                >
                  <Laptop className="w-3 h-3" />
                  <span>{envLabel}</span>
                  <ChevronDown className="w-2.5 h-2.5 opacity-60" />
                </button>
              );
            })()}

            {localMenuOpen && (
              <div className="absolute left-0 bottom-full mb-1.5 w-72 p-1 rounded-lg border border-border bg-popover shadow-lg text-xs z-50 space-y-1">
                {/* Current Workspace Header */}
                <div className="px-2 py-1.5 border-b border-border/50">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-foreground flex items-center gap-1.5">
                      <Folder className="w-3.5 h-3.5 text-primary" />
                      {p.currentWorkspace
                        ? p.currentWorkspace.split(/[/\\]/).filter(Boolean).pop()
                        : "未绑定工作区"}
                    </span>
                    {p.currentWorkspace && (
                      <button
                        type="button"
                        onClick={handleRevealInExplorer}
                        title="在资源管理器中定位"
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  {p.currentWorkspace && (
                    <div className="text-[10px] font-mono text-muted-foreground/70 truncate mt-0.5" title={p.currentWorkspace}>
                      {p.currentWorkspace}
                    </div>
                  )}
                </div>

                {/* Workspace Actions */}
                <div className="space-y-0.5">
                  <button
                    type="button"
                    onClick={handleOpenFolder}
                    className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-foreground hover:bg-muted/80 text-left transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <FolderOpen className="w-3.5 h-3.5 text-primary" />
                      <span>打开本地项目 / 文件夹…</span>
                    </div>
                    <kbd className="text-[9px] font-mono bg-muted px-1 py-0.5 rounded text-muted-foreground border border-border/50">
                      Ctrl+O
                    </kbd>
                  </button>

                  {p.onOpenChanges && (
                    <button
                      type="button"
                      onClick={() => {
                        setLocalMenuOpen(false);
                        p.onOpenChanges?.();
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/80 text-left transition-colors"
                    >
                      <FileDiff className="w-3.5 h-3.5" />
                      <span>查看 Git 代码变更 (Diff)</span>
                    </button>
                  )}

                  {p.onToggleTerminal && (
                    <button
                      type="button"
                      onClick={() => {
                        setLocalMenuOpen(false);
                        p.onToggleTerminal?.();
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/80 text-left transition-colors"
                    >
                      <Terminal className="w-3.5 h-3.5" />
                      <span>打开集成终端</span>
                    </button>
                  )}
                </div>

                {/* Recent Projects (if any) */}
                {p.recentWorkspaces && p.recentWorkspaces.length > 0 && (
                  <div className="pt-1 border-t border-border/50">
                    <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <span>最近项目</span>
                    </div>
                    <div className="max-h-28 overflow-y-auto space-y-0.5">
                      {p.recentWorkspaces.slice(0, 4).map((rw) => (
                        <button
                          key={rw.path}
                          type="button"
                          onClick={() => {
                            setLocalMenuOpen(false);
                            p.onSelectWorkspace?.(rw.path, rw.name);
                          }}
                          className={`w-full flex items-center justify-between px-2 py-1 rounded text-left text-[11px] transition-colors ${
                            p.currentWorkspace === rw.path
                              ? "bg-muted text-foreground font-medium"
                              : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                          }`}
                        >
                          <span className="truncate">{rw.name || rw.path.split(/[/\\]/).pop()}</span>
                          {p.currentWorkspace === rw.path && <Check className="w-3 h-3 text-primary shrink-0" />}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Environment Status info */}
                <div className="px-2 py-1.5 pt-1 border-t border-border/50 text-[10px] text-muted-foreground/80 flex items-center justify-between">
                  <span>运行在本机</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-success" />
                </div>
              </div>
            )}
          </div>

          <div className="text-[11px] font-mono text-muted-foreground/70 hidden @md:block truncate min-w-0">
            {p.isStreaming ? "Enter 排队 · 插队立即打断 · Shift+Enter 换行" : "Enter 发送 · Shift+Enter 换行 · / 命令"}
          </div>
        </div>
      </div>
    </div>
  );
};
