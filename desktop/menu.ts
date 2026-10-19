/**
 * 原生应用菜单。菜单项只做两件事：
 * - 主进程能直接完成的（打开文件夹对话框、新窗口、检查更新、打开链接）在这里处理；
 * - 其余发 `app:command` 给当前窗口，由渲染端命令注册表（src/lib/commands.ts）执行，
 *   与标题栏菜单 / 命令面板共用同一套命令。
 */
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { loadRecent, clearRecent } from "./recent";

export interface MenuActions {
  openFolder: () => void;
  openRecent: (p: string) => void;
  newWindow: () => void;
  checkForUpdates: () => void;
}

const CHANGELOG_URL = "https://github.com/yitom486/autumnflow/blob/master/CHANGELOG.md";
const RELEASES_URL = "https://github.com/yitom486/autumnflow/releases";
const ISSUES_URL = "https://github.com/yitom486/autumnflow/issues";

export function sendCommand(id: string, payload?: unknown) {
  const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (w && !w.isDestroyed()) w.webContents.send("app:command", id, payload);
}

export function buildAppMenu(actions: MenuActions, opts: { isDev: boolean }) {
  const isMac = process.platform === "darwin";
  const recent = loadRecent();
  const cmd = (id: string) => () => sendCommand(id);

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: "AutumnFlow",
          submenu: [
            { label: "关于 AutumnFlow", click: cmd("settings.about") },
            { label: "检查更新…", click: actions.checkForUpdates },
            { type: "separator" },
            { label: "设置…", accelerator: "Cmd+,", click: cmd("settings.open") },
            { type: "separator" },
            { role: "hide", label: "隐藏 AutumnFlow" },
            { role: "hideOthers", label: "隐藏其他" },
            { role: "unhide", label: "全部显示" },
            { type: "separator" },
            { role: "quit", label: "退出 AutumnFlow" },
          ],
        } as MenuItemConstructorOptions]
      : []),
    {
      label: "文件",
      submenu: [
        { label: "新建窗口", accelerator: "CmdOrCtrl+Shift+N", click: actions.newWindow },
        { label: "新会话", accelerator: "CmdOrCtrl+N", click: cmd("session.new") },
        { type: "separator" },
        { label: "打开文件夹…", accelerator: "CmdOrCtrl+O", click: actions.openFolder },
        {
          label: "最近打开",
          submenu: [
            ...(recent.length
              ? recent.map((p) => ({ label: p, click: () => actions.openRecent(p) }))
              : [{ label: "（无）", enabled: false }]),
            { type: "separator" },
            { label: "清除最近打开", enabled: recent.length > 0, click: () => { clearRecent(); buildAppMenu(actions, opts); } },
          ],
        },
        { type: "separator" },
        { label: "保存", accelerator: "CmdOrCtrl+S", click: cmd("editor.save") },
        { label: "关闭标签页", accelerator: "CmdOrCtrl+W", click: cmd("editor.closeTab") },
        { type: "separator" },
        { label: "在文件管理器中显示工作区", click: cmd("workspace.reveal") },
        { label: "复制工作区路径", click: cmd("workspace.copyPath") },
        ...(!isMac
          ? [{ type: "separator" } as MenuItemConstructorOptions, { label: "设置…", accelerator: "Ctrl+,", click: cmd("settings.open") }, { type: "separator" } as MenuItemConstructorOptions, { role: "quit", label: "退出" } as MenuItemConstructorOptions]
          : [{ type: "separator" } as MenuItemConstructorOptions, { role: "close", label: "关闭窗口" } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "命令面板…", accelerator: "CmdOrCtrl+Shift+P", click: cmd("palette.open") },
        { type: "separator" },
        { label: "切换侧栏", accelerator: "CmdOrCtrl+B", click: cmd("view.toggleSidebar") },
        { label: "切换文件树", accelerator: "CmdOrCtrl+Shift+E", click: cmd("view.toggleFileTree") },
        { label: "切换终端", accelerator: "CmdOrCtrl+`", click: cmd("view.toggleTerminal") },
        { label: "切换深色 / 浅色", click: cmd("view.toggleTheme") },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        ...(opts.isDev ? [{ role: "toggleDevTools", label: "开发者工具" } as MenuItemConstructorOptions, { role: "reload", label: "重新加载" } as MenuItemConstructorOptions] : []),
      ],
    },
    {
      label: "帮助",
      submenu: [
        ...(!isMac ? [{ label: "检查更新…", click: actions.checkForUpdates } as MenuItemConstructorOptions] : []),
        { label: "更新日志", click: () => void shell.openExternal(CHANGELOG_URL) },
        { label: "所有版本", click: () => void shell.openExternal(RELEASES_URL) },
        { label: "报告问题", click: () => void shell.openExternal(ISSUES_URL) },
        ...(!isMac ? [{ type: "separator" } as MenuItemConstructorOptions, { label: "关于 AutumnFlow", click: cmd("settings.about") } as MenuItemConstructorOptions] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  void app; // keep import for typings
}
