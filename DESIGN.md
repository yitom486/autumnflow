# AutumnFlow — UI Redesign Brief

Target: an almost-full visual redesign of the chat workbench to remove AI-slop.
Status: direction + constraints live here. **Mandatory skills** (installed globally
in `~/.agents/skills`, mirrored to `.claude` / `.codex`): `frontend-design`
(director, improved local version), `redesign-existing-projects` (diagnostic
checklist), `web-design-guidelines` (audit).

## Brief

- **Subject**: desktop AI-agent workbench (Electron). Chat with coding agents,
  tool-call audit trail, sessions sidebar, terminal, git diff review.
- **Audience**: developers living in it daily, often in hour-long sessions.
- **Job**: legibility under load. Density and predictability beat decoration.

## Stack facts (do not regress)

- React 19.3, Tailwind CSS v4 CSS-first (`@theme inline` tokens in
  `src/index.css`; NO `tailwind.config.js`; build via `@tailwindcss/vite`).
  v4 notes: `bg-linear-*` (not `bg-gradient-*`), bare `border` keeps v3 look
  via the base-layer `border-color: hsl(var(--border))` rule, button cursor must be explicit.
- Chat renders on **assistant-ui primitives** (`Thread/Viewport/Messages/Parts`,
  `ExternalStoreRuntime` over the zustand ACP store). Do not replace the
  runtime or the ACP protocol layer for visual reasons.
- State: zustand (client) + TanStack Query (server lists). Reads → Query,
  writes → mutation + invalidate, streams stay imperative.
- **Four data-themes must keep working**: `dark / oled / dim / light`
  (`data-theme` vars in `src/index.css`). Verify any visual change in at
  least dark + light.
- Density must not drop. No functionality breaks. No new runtime dependency
  without checking `package.json` first.

## Direction (agreed)

1. De-card assistant messages → 2px signal rail + spacing hierarchy.
2. One accent (signal amber for agent/live states); user bubble neutral
   grey; semantic red stays. See **Palette** below.
3. Mono rises to first-class (timestamps, token counts, tool titles, status rows).
4. Remove per-message entrance animation; motion only for streaming,
   expand/collapse, hover.
5. Radius by hierarchy (12/8/6/4 from `--radius: 0.5rem`), never uniform.
6. Composer becomes a slash-first command deck.
7. **Unified theme transition system**: zero hardcoded color switch durations;
   synchronized CSS design tokens with lockstep execution.

## Palette (配色：tweakcn vercel)

来源：[tweakcn](https://github.com/jnsahaj/tweakcn) 的 **vercel** 主题（Apache-2.0），
OKLCH 换算成 HSL 通道后写在 `src/index.css` 的 `[data-theme]` 块里。

- **纯中性灰阶**（饱和度 0）。primary 为黑白反相按钮，不再有蓝色主色。
- **唯一强调色 `--signal`** 取 vercel 自带的琥珀（chart-1，`oklch(0.81 0.17 75.35)`
  ≈ `hsl(40.7 100% 50.9%)`），**只用于**键盘焦点（`--ring`）、智能体运行中、当前会话。
  浅色下压暗到 `hsl(32 100% 32%)`，作文字用也 ≥ 4.5:1。
- 四档主题：

  | data-theme | 名称 | 底色 | 说明 |
  |---|---|---|---|
  | `dark` | 深色（默认） | 7% | vercel dark，底色从纯黑抬到 7%，表面/边框同步上移 |
  | `oled` | 纯黑 | 0% | vercel dark 原值 |
  | `dim` | 暗灰 | 15% | 自定义中灰，对比更柔和 |
  | `light` | 浅色 | 98.7% | vercel light，`--input` 加深到 85% 让输入框边框可见 |

- `success` / `warning` 是补充的语义色（vercel 未定义）。
- 对比度门槛：`foreground` 与 `muted-foreground` 在 background / card / muted /
  sidebar / secondary / accent 上都 ≥ 4.5:1（WCAG AA）。改令牌时重新检查。
- 代码对比面板的语法高亮：深色用 `github-dark-default`，浅色用
  `github-light-high-contrast`（经典 github-light 的橙色、注释色在 diff 底色上不到 AA）。
- 终端 ANSI 的 black/white 也改为中性灰，不再带蓝调。

## Unified Theme Transition System (统一明暗主题切换动效规范)

### 1. 现状痛点与割裂感根因
此前不同组件在明暗主题切换时存在明显的**视觉撕裂感**：
* 部分组件硬编码了 `transition-colors duration-150`，部分硬编码了 `duration-300`，还有部分组件完全没有过渡属性（瞬时突变）；
* 导致切换主题瞬间，父容器背景已变浅，子组件文字却在半秒后才渐变完成，或者边框先变深、背景后变深，组件间节拍不一，如同画面撕裂。

### 2. 设计令牌 (CSS Design Tokens - Single Source of Truth)
所有主题切换的动作与时间**严禁在具体组件中硬编码**，统一收敛在 `src/index.css` 的 `:root` 变量中：
```css
:root {
  /* 统一切换时长：150ms（黄金响应时间，杜绝慢速切换下的线条反向对比残影与滞后感） */
  --theme-transition-duration: 150ms;
  /* 统一缓动曲线：自然流畅的高阶指数减速曲线 (Ease-Out Expo) */
  --theme-transition-timing: cubic-bezier(0.16, 1, 0.3, 1);
  /* 统一联动的视觉通道：坚决剔除 box-shadow，防止阴影模糊半径矩阵渐变造成卡片边缘黑色漫反射“拖影” */
  --theme-transition-properties: color, background-color, border-color, text-decoration-color, fill, stroke;
}
```

### 3. 全局锁步执行机制与文字/小组件全量覆盖 (Universal Baseline & Lockstep Execution)
此前大组件修复后小组件与文字仍旧割裂的**核心根因**：
* 容器类大组件（Card、Sidebar、TitleBar）往往自带 `transition-colors`，而内嵌的细粒度文本（`h1-h6`, `p`, `span`, `label`, `code`）以及图标（`svg`, `path`）默认 `transition: none`；
* 切换瞬间，背景以 200ms 渐变，而文字在 **0ms 瞬间反色**，在中间时刻（如 80ms 处）极易产生“暗底黑字”或“白底亮字”的严重反色致盲与撕裂闪烁！

为此采取全量防御与对齐体系：
1. **全局通配基线覆盖**（`src/index.css`）：
   放弃容易挂一漏万的具体标签列表（避免遗漏 `strong`、`b`、`em`、`li` 等），使用通用通配符注入基础过渡通道：
   ```css
   *,
   *::before,
   *::after {
     transition-property: var(--theme-transition-properties);
     transition-duration: var(--theme-transition-duration);
     transition-timing-function: var(--theme-transition-timing);
   }
   ```
2. **Markdown 粗体与文本 100% 继承对齐**（`AcpMarkdown.tsx` / `Markdown.tsx`）：
   `strong` 和 `b` 严禁写死 `text-foreground`，必须自然继承外层段落与消息气泡的主题文字色（`text-secondary-foreground` 或 `text-foreground`），确保加粗文本与常规文本的颜色计算值和过渡帧完全一致。
3. **消除按钮对色彩通道的遮蔽**：
   关键操作按钮（如顶栏“新会话”按钮）严禁使用 `transition-opacity`（它会把 transition 属性限定为仅透明度，导致底色与文字颜色 0ms 瞬间突变），统一采用 `transition-all`。
4. **Tailwind `@theme` 默认值对齐**：
   ```css
   @theme {
     --default-transition-duration: var(--theme-transition-duration);
     --default-transition-timing-function: var(--theme-transition-timing);
   }
   ```
   所有使用 Tailwind 原生 `transition-colors`、`transition` 的小组件（Button、Badge、Input）自动遵循 200ms 设计令牌，杜绝 150ms 与 200ms 的节拍差。
5. **首屏渲染零闪烁（Pre-paint Theme Bootstrap）**：
   在 `index.html` 的 `<head>` 中注入同步脚本，在首帧 DOM 渲染前直接将用户保存的主题打在 `documentElement` 上，从根本上防止冷启动时的颜色过渡拉扯。

### 4. 桌面端窗口控制栏（Pure Frontend Window Controls - 三大金刚按钮）全量对齐规范
* **架构解耦与职责纯粹**：后端/主进程（Electron）严格恪守“只提供底层系统能力（IPC）”的原则（`minimize`、`maximize`、`close`、`isMaximized`），坚决摒弃 Chromium 底层封闭的 `titleBarOverlay` 原生遮罩。**UI 100% 交由前端 React（`TitleBar.tsx`）全权绘制**，从架构根源上杜绝跨进程色值滞后、黑块漏底与样式无法定制的问题。
* **标准桌面工程学尺寸**：最小化、最大化/还原、关闭按钮统一采用标准桌面尺寸 `w-[46px] h-[32px]`，无缝贴靠窗口右上角边缘（`pr-0`），点击热区宽裕且符合直觉。
* **全局主题 150ms 动效毫秒级锁步**：控制按钮底色与图标色全部通过 CSS 变量绑定当前主题，在主题切换瞬间跟随 `--theme-transition-duration: 150ms` 和 `--theme-transition-timing: cubic-bezier(0.16, 1, 0.3, 1)` 与顶栏、侧边栏、卡片、文字**完全锁步渐变**，实现 100% 的视觉统一性。
* **桌面交互体验完备**：
  * **悬浮反馈**：最小化与最大化按钮使用 `hover:bg-muted/80 text-muted-foreground hover:text-foreground`；关闭按钮使用经典的沉浸式警示交互 `hover:bg-[#e81123] hover:text-white`；
  * **双击缩放**：标题栏拖拽区域（`app-drag`）绑定 `onDoubleClick={handleMaximize}`，双击即可切换最大化与还原；
  * **动态图标**：最大化状态下图标自动在单方框（`<Square />`）与重叠双框（`<Copy />`）之间精确切换。

### 5. 无障碍减弱动效 (Accessibility)
严格遵循系统辅助功能规范：
```css
@media (prefers-reduced-motion: reduce) {
  :root {
    --theme-transition-duration: 0ms;
  }
  *,
  *::before,
  *::after {
    transition: none !important;
  }
}
```

## Gates (every piece)

- [ ] `bunx tsc --noEmit` clean, full `vitest` suite green, `vite build` ok
- [ ] Screenshot reviewed (welcome, streaming, tool group, composer)
- [ ] dark + light theme checked
- [ ] No layout shift from hover/appear chrome (absolute overlay or fixed slot
      + opacity only — never mount/unmount in flow)
- [ ] Small, reviewable diffs; one component area per change

