/**
 * 全局测试环境（vitest setupFiles，先于每个测试文件及其被测模块执行）。
 * 测试绝不碰真实用户目录：
 * - 固定网关令牌（ACP_GATEWAY_TOKEN），不读写 ~/.autumnflow/.gateway-token；
 * - 应用目录（AUTUMNFLOW_HOME）指向每个 worker 独立的临时目录，
 *   自定义智能体（ACP_AGENTS_FILE / ACP_AGENTS_HOME）也落在同一个沙箱。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TEST_GATEWAY_TOKEN } from "./helpers/gateway-auth";

process.env.ACP_GATEWAY_TOKEN = TEST_GATEWAY_TOKEN;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "autumnflow-test-home-"));
process.env.AUTUMNFLOW_HOME = sandbox;
process.env.ACP_AGENTS_FILE = path.join(sandbox, "agents.json");
process.env.ACP_AGENTS_HOME = path.join(sandbox, "agents");
process.env.AUTUMNFLOW_RESOURCES_DIR = path.join(sandbox, "app-resources");
process.env.ACP_SESSION_INDEX_FILE = path.join(sandbox, "session-index.json");

process.on("exit", () => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

try {
  const { MotionGlobalConfig } = await import("framer-motion");
  MotionGlobalConfig.skipAnimations = true;
} catch {
  // framer-motion not loaded in pure node tests
}

