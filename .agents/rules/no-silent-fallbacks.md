# 默认覆盖：报错优先，禁止静默兜底

凡是“找不到就换条路走”的兼容逻辑，默认一律不写——错了就直接报错，
让问题第一时间暴露。兜底只在用户明确要求时才加。

## 一、默认行为（覆盖旧习惯）

1. 解析外部依赖（npm 包、二进制、配置文件）只认**线上/正式来源**，
   不准顺手回退到本地 `scratch`、旧目录、 hardcode 绝对路径。
   找不到 → 连接期直接抛错（带 `installHint` 级别的修复指引），
   不准静默用一个过期本地文件顶上去。
2. 现状举例：`antigravity-stdio` 预设只认
   `bunx @yitom/agy-acp-map@latest`（npx 兜底，见
   `server/universal/presets.ts`）。runner 缺失 → `whichCommand`
   失败 + 提示装 bun/Node，绝不回退 `scratch/…/src/*.ts`、
   本地 exe 或开发目录。
3. 降级必须**大声**：实在要降级（如垫片缺失仍可直起），必须
   `console.warn` 明确写出缺了什么、后果是什么，不准静默。

## 二、例外

只有用户明确说“要兼容/要兜底”时才加 fallback，且必须同时满足：

1. 每次触发都在日志/界面留下可检索的痕迹（warn 级别以上）；
2. 在本规则文件或相关文档里写明触发条件与排查方式。

## 三、版本新鲜度（默认最新）

1. Runner 时代：stdio agent（codex/antigravity/…）一律走包 runner
  （`bunx <pkg>@latest`，npx 兜底），runner 缓存即事实来源；不再设
   “按需安装目录”，不展示安装徽标。
2. `npx` 起的 agent 一律 `pkg@latest`，不准用本地 `require.resolve`
   捷径锁死旧版（离线起不来就 loud 报错，这是对的）。
3. 内嵌到应用包里的只允许是**构建时快照**，不准用包内旧拷贝掩盖
   “没拉到最新”的事实。
4. 开发环境想调本地桥源码时，用自定义 profile 覆盖
  （`ACP_AGENTS_JSON` / `POST /api/universal/agents` /
   `~/.autumnflow/agents.json`，见 `server/universal/registry.ts`）：
   用户显式覆盖永远优先于 builtin 默认；生产环境不提供来源切换开关。

## 四、审查清单

改动涉及路径解析、外部命令、配置来源时自查：

1. 删掉候选路径了吗？（只留正式来源）
2. 缺失时报错信息里有没有“怎么修”？（命令/版本号写全）
3. 有没有 `catch { // ignore }` 吞掉关键失败？（只允许 deterministically
   无害的位置，见 error_handling.md，且注明原因）
