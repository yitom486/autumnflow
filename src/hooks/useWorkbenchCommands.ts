/**
 * 注册全应用命令，并把原生菜单（app:command）与浏览器模式下的快捷键接到命令注册表。
 */
import { useEffect } from "react";
import { registerCommands, runCommand, matchesKey, listCommands, type Command } from "@/lib/commands";
import { useWorkbenchStore, isDirty } from "@/stores/useWorkbenchStore";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { useThemeStore } from "@/stores/useThemeStore";
import { useStudioStore } from "@/stores/useStudioStore";
import { saveTab } from "@/lib/workbench-actions";
import { validateWorkspace } from "@/lib/universal-api";

const CHANGELOG_URL = "https://github.com/yitom486/autumnflow/blob/master/CHANGELOG.md";
const ISSUES_URL = "https://github.com/yitom486/autumnflow/issues";

export function useWorkbenchCommands(opts: { onNewSession: (targetCwd?: string) => void }) {
  const { onNewSession } = opts;
  const recents = useStudioStore((s) => s.recentWorkspaces);

  useEffect(() => {
    const wb = () => useWorkbenchStore.getState();
    const studio = () => useStudioStore.getState();
    const desktop = typeof window !== "undefined" ? window.autumnflow?.workbench : undefined;
    const cwd = () => studio().currentWorkspace;
    const copy = (t: string) => (desktop ? desktop.copyText(t) : navigator.clipboard.writeText(t));
    const openWorkspace = async (p: string) => {
      const r = await validateWorkspace(p);
      if (r.ok && r.path) studio().setWorkspace(r.path, r.name);
      else window.alert(r.error || "无法打开该文件夹");
    };
    const exec = (c: string) => () => void document.execCommand(c);

    const cmds: Command[] = [
      { id: "palette.open", title: "命令面板", group: "视图", keybinding: "Ctrl+Shift+P", run: () => wb().setPaletteOpen(true) },
      { id: "window.new", title: "新建窗口", group: "文件", keybinding: "Ctrl+Shift+N", when: () => !!desktop, run: () => desktop?.newWindow() },
      { id: "session.new", title: "新会话", group: "文件", run: onNewSession },
      {
        id: "workspace.openFolder", title: "打开文件夹…", group: "文件", keybinding: "Ctrl+O",
        run: () => {
          wb().openWorkspacePicker();
        },
      },
      { id: "workspace.open", title: "打开工作区（路径）", group: "文件", hidden: true, run: async (p) => { if (typeof p === "string") await openWorkspace(p); } },
      { id: "workspace.openRecent", title: "最近打开…", group: "文件", run: () => wb().setPaletteOpen(true, "最近打开") },
      { id: "workspace.reveal", title: "在文件管理器中显示工作区", group: "文件", when: () => !!desktop && !!cwd(), run: () => { const c = cwd(); if (c) void desktop?.reveal(c); } },
      { id: "workspace.copyPath", title: "复制工作区路径", group: "文件", when: () => !!cwd(), run: () => { const c = cwd(); if (c) void copy(c); } },
      {
        id: "editor.save", title: "保存", group: "编辑器", keybinding: "Ctrl+S",
        when: () => { const t = wb().tabs.find((x) => x.id === wb().activeId); return !!t && t.kind === "file"; },
        run: async () => { const c = cwd(); const id = wb().activeId; if (c && id) await saveTab(c, id); },
      },
      {
        id: "editor.saveAll", title: "全部保存", group: "编辑器",
        run: async () => { const c = cwd(); if (!c) return; for (const t of wb().tabs.filter(isDirty)) await saveTab(c, t.id); },
      },
      {
        id: "editor.closeTab", title: "关闭标签页", group: "编辑器", keybinding: "Ctrl+W",
        when: () => !!wb().activeId,
        run: () => {
          const t = wb().tabs.find((x) => x.id === wb().activeId);
          if (!t) return;
          if (isDirty(t) && !window.confirm(`${t.path} 有未保存的修改，确定关闭？`)) return;
          wb().closeTab(t.id);
        },
      },
      { id: "edit.undo", title: "撤销", group: "编辑", keybinding: "Ctrl+Z", run: exec("undo") },
      { id: "edit.redo", title: "重做", group: "编辑", keybinding: "Ctrl+Shift+Z", run: exec("redo") },
      { id: "edit.cut", title: "剪切", group: "编辑", keybinding: "Ctrl+X", run: exec("cut") },
      { id: "edit.copy", title: "复制", group: "编辑", keybinding: "Ctrl+C", run: exec("copy") },
      { id: "edit.paste", title: "粘贴", group: "编辑", keybinding: "Ctrl+V", run: exec("paste") },
      { id: "edit.selectAll", title: "全选", group: "编辑", keybinding: "Ctrl+A", run: exec("selectAll") },
      { id: "view.toggleSidebar", title: "切换侧栏", group: "视图", keybinding: "Ctrl+B", run: () => wb().setSidebarOpen(!wb().sidebarOpen) },
      { id: "view.toggleFileTree", title: "切换文件树", group: "视图", keybinding: "Ctrl+Shift+E", run: () => wb().setFileTreeOpen(!wb().fileTreeOpen) },
      { id: "view.toggleTerminal", title: "切换终端", group: "视图", keybinding: "Ctrl+`", run: () => studio().setTerminalOpen(!studio().terminalOpen) },
      { id: "view.toggleTheme", title: "切换深色 / 浅色", group: "视图", run: () => { const t = useThemeStore.getState(); t.setTheme(t.theme === "light" ? "dark" : "light"); } },
      { id: "settings.open", title: "设置", group: "偏好", keybinding: "Ctrl+,", run: () => wb().openSettings("general") },
      { id: "settings.about", title: "关于 AutumnFlow", group: "帮助", run: () => wb().openSettings("about") },
      { id: "update.check", title: "检查更新…", group: "帮助", run: () => { wb().openSettings("about"); void useUpdateStore.getState().check(); } },
      { id: "help.changelog", title: "更新日志", group: "帮助", run: () => void window.open(CHANGELOG_URL, "_blank") },
      { id: "help.issues", title: "报告问题", group: "帮助", run: () => void window.open(ISSUES_URL, "_blank") },
      ...recents.slice(0, 10).map((r, i) => ({
        id: `recent.${i}`,
        title: r.path,
        group: "最近打开",
        run: () => openWorkspace(r.path),
      })),
    ];
    const off = registerCommands(cmds);

    // 原生菜单 → 命令
    const offMenu = desktop?.onCommand((id, payload) => void runCommand(id, payload));

    // 浏览器模式快捷键（Electron 下由原生菜单的 accelerator 负责，避免重复触发）
    const onKey = (e: KeyboardEvent) => {
      if (desktop) return;
      for (const c of listCommands()) {
        if (!c.keybinding || c.group === "编辑") continue;
        if (matchesKey(e, c.keybinding)) {
          e.preventDefault();
          void c.run();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      offMenu?.();
      window.removeEventListener("keydown", onKey);
    };
  }, [onNewSession, recents]);
}
