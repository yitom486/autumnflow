# AutumnFlow UI 设计铁律（所有 AI 助手与贡献者必读）

本规则与 `.agents/rules/version_control.md` 同级，适用于本仓库 `src/` 下一切界面改动。
违反以下任何一条的 UI 提交必须打回重做。

## 一、风格：简约蓝灰科技风，禁止花哨

1. 只允许**蓝灰（blue-gray）单色系 + 单一 steel-blue 强调色**，走简约科技风。
2. 禁止蓝紫渐变（indigo/purple/pink）、禁止多色渐变背景、禁止彩色投影（colored shadow）。
3. 状态色只允许四种语义 token：`primary`（强调/进行中）、`success`（成功/已连接）、
   `warning`（待审批/警告）、`destructive`（危险/失败）。思考过程等中性面板用中性 token。

## 二、颜色只允许 CSS 变量，禁止字面调色板

1. 所有颜色必须来自 `src/index.css` 的 `:root` 变量，并经由 `tailwind.config.js`
   映射后的语义 token 使用：`background foreground card popover primary secondary
   muted accent success warning destructive border input ring`（及各自 `-foreground`）。
2. **JSX/TSX 的 className 中严禁出现字面调色板**，包括但不限于：
   `slate-* indigo-* purple-* pink-* emerald-* amber-* rose-* sky-* white black`
   以及十六进制颜色（如 `bg-[#070A12]`）。
3. 唯一例外：`magicui/animated-shiny-text.tsx` 内的微光扫过层（monochrome 效果，
   且已改用 `via-foreground` 变量实现）。
4. 自查命令（必须零命中，`whitespace-*` 等非颜色词除外）：
   ```bash
   rg --glob '*.tsx' '-(slate|indigo|purple|pink|emerald|amber|rose|sky|violet|fuchsia|cyan|teal|lime|orange|red|green|yellow|zinc|neutral|stone|gray)-\d|text-white|bg-white|border-white|text-black|bg-black|#[0-9a-fA-F]{3,6}\b' src
   ```

## 三、组件来源铁律：只用 shadcn / Magic UI 官方组件，禁止手写组件

1. **本项目已正规引入两套组件库**（不再是手抄）：
   - shadcn：根目录 `components.json` 已配置（new-york 风格，`@/components/ui`），
     新增基础组件必须走 CLI：`bunx shadcn@latest add <name> -y`，
     装完如含字面调色板需按第二条改写为变量（以 `skeleton` 为例，官方版
     `bg-primary/10` 本就是变量，直接合规）。
   - Magic UI：无 npm 包，官方分发即复制源码。本项目 `src/components/magicui/`
     即官方登记位：`blur-fade`、`animated-shiny-text` 均为官网实现原样移植；
     新增动效必须从 magicui.design 按官方文档复制（含其要求的 tailwind
     keyframes，一并登记进 `tailwind.config.js`），禁止自创动画组件。
     前置依赖 `framer-motion` 已安装。
2. **现有库存（复用优先，新需求先查这里）**：
   `ui/`：button badge card input skeleton（全部为 CLI 官方版；
   唯一特批扩展是 badge 的 `success`/`warning` 变体，token 实现，
   见该文件注释）；
   `magicui/`：blur-fade animated-shiny-text code-comparison
  （code-comparison 需 `shiki` + `@shikijs/transformers` 依赖，
   已安装；移植时去掉 `next-themes`（本应用纯深色，主题固定）、
   diff 行底色改用变量，特例见该文件头注释）。
   `magicui/`：blur-fade animated-shiny-text。
3. **禁止事项**：禁止新建 `ui/*`、`magicui/*` 之外的通用基础组件；
   禁止在业务组件（`universal/*`、`ChatArea` 等）里手写 keyframes、
   渐变动画、骨架屏、微光文字——一律用第 2 条库存；业务组件只做
   “拼装 + 传参”，不许自带视觉样式发明。

## 四、聊天内容必须富文本渲染

1. 助手消息必须经 `src/components/universal/Markdown.tsx` 渲染（GFM：列表/标题/
   粗体/代码块/表格/引用/链接），禁止 `whitespace-pre-wrap` 裸排。
2. 用户消息与系统动态保持纯文本，避免 `_` `*` 等字符被误解析。
