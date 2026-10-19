# AutumnFlow 版本规范与发版铁律

本规则适用于本仓库（AutumnFlow，`package.json` 当前 `0.1.0` 起步）。
日常只允许 **Patch 线性递增**（`0.1.0` → `0.1.1` → `0.1.2` …），
功能往上加也先走 patch；Minor / Major 跃迁以后另行许可。

## 一、版本号铁律

1. **默认只能 +0.0.1**：日常发版、Bug 修复、ACP 协议对齐、小功能，
   一律 `bun run release:patch`（可附 `--notes "..."`）。
2. **Minor / Major 必须显式放行**：`release:minor` 需 `--allow-minor`
   （或 `ALLOW_MINOR_BUMP=true`），`release:major` 需 `--allow-major`
   （或 `ALLOW_MAJOR_BUMP=true`）；无放行脚本直接报错退出。
   放行只能由用户在对话中明确许可，Agent 不得自行决定跃迁。
3. 内核桥接库 `@yitom/agy-acp-map`（子仓库）沿用其自有 Patch 纪律，
   与本仓库版本互不绑定。

## 二、单一事实源与 CHANGELOG 自动同步

1. `package.json` 的 `version` 为全局唯一事实源；UI、文档、打包配置
   一律运行时读取，禁止硬编码版本号。
2. `CHANGELOG.md` 由发版脚本自动维护：
   - 日常开发只往 `## [Unreleased]` 下加条目（Added/Fixed/Changed）；
   - 发版时脚本把 Unreleased 归档为 `## [x.y.z] - 日期` 新小节，
     同步改写 `package.json`，并更新底部版本链接；
   - Unreleased 为空且无 `--notes` 时脚本拒绝执行。
3. 发版后手动提交并打 tag（脚本会打印确切命令）：
   ```bash
   bun run release:patch --notes "fix: xxx"
   git add package.json CHANGELOG.md
   git commit -m "chore(release): v0.1.1"
   git tag v0.1.1   # 触发 Release 工作流出安装包
   ```
4. 发版前门禁：`bunx tsc --noEmit`、`bunx vitest run tests/universal`、
   `bun run build` 全绿（与 CI 一致）。
