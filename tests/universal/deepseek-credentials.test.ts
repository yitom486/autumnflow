// @vitest-environment node
/**
 * DeepSeek 凭据落盘：只写 DSH 的 user-env 层，保留其它内容、原子替换、不回显密钥。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyDeepseekKeyToEnv,
  deepseekEnvFile,
  readDeepseekCredentialState,
  saveDeepseekApiKey,
  validateDeepseekApiKey,
} from "../../server/universal/runtimes/deepseek-credentials";
import { agentsRouter } from "../../server/universal/http/agents";

const KEY = "sk-abcdef1234567890";

describe("validateDeepseekApiKey", () => {
  it("接受普通 API Key 并去除首尾空白", () => {
    expect(validateDeepseekApiKey(`  ${KEY}  `)).toBe(KEY);
  });

  it("拒绝空白/引号/反斜杠/# 与过短的值", () => {
    expect(() => validateDeepseekApiKey("short")).toThrow(/长度/);
    expect(() => validateDeepseekApiKey("sk-abc def-123")).toThrow(/可见 ASCII/);
    expect(() => validateDeepseekApiKey("sk-abc\n456789")).toThrow(/可见 ASCII/);
    expect(() => validateDeepseekApiKey("sk-abc#456789")).toThrow(/引号/);
    expect(() => validateDeepseekApiKey(`sk-abc"456789`)).toThrow(/引号/);
    expect(() => validateDeepseekApiKey(42)).toThrow(/字符串/);
  });
});

describe("applyDeepseekKeyToEnv", () => {
  it("空文件只写一行并以换行结尾", () => {
    expect(applyDeepseekKeyToEnv("", KEY)).toBe(`DEEPSEEK_API_KEY=${KEY}\n`);
  });

  it("保留其它变量与注释，并把 Key 追加到末尾", () => {
    const input = "# 注释\nDSH_HOME=/tmp/dsh\nFOO=bar\n";
    expect(applyDeepseekKeyToEnv(input, KEY)).toBe(
      `# 注释\nDSH_HOME=/tmp/dsh\nFOO=bar\nDEEPSEEK_API_KEY=${KEY}\n`,
    );
  });

  it("替换已有 Key（含 export 前缀与大小写差异），不会重复", () => {
    const input = `A=1\nexport deepseek_api_key=old-value\nB=2\n`;
    const out = applyDeepseekKeyToEnv(input, KEY);
    expect(out).toBe(`A=1\nB=2\nDEEPSEEK_API_KEY=${KEY}\n`);
    expect(out.match(/DEEPSEEK_API_KEY=/gi)).toHaveLength(1);
  });

  it("注释掉的 Key 不算已有配置，保留原注释", () => {
    const input = `# DEEPSEEK_API_KEY=old\nA=1\n`;
    expect(applyDeepseekKeyToEnv(input, KEY)).toBe(
      `# DEEPSEEK_API_KEY=old\nA=1\nDEEPSEEK_API_KEY=${KEY}\n`,
    );
  });

  it("沿用 CRLF 换行", () => {
    const input = "A=1\r\nB=2\r\n";
    expect(applyDeepseekKeyToEnv(input, KEY)).toBe(`A=1\r\nB=2\r\nDEEPSEEK_API_KEY=${KEY}\r\n`);
  });
});

describe("read / save credentials", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-env-"));
    env = { DSH_HOME: dir };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("未配置时报告 none，并给出 .env 路径", () => {
    const state = readDeepseekCredentialState(env);
    expect(state).toEqual({ configured: false, source: "none", path: path.join(dir, ".env") });
    expect(deepseekEnvFile(env)).toBe(path.join(dir, ".env"));
  });

  it("进程环境里的 Key 优先于文件", () => {
    fs.writeFileSync(path.join(dir, ".env"), `DEEPSEEK_API_KEY=${KEY}\n`);
    expect(readDeepseekCredentialState(env)).toMatchObject({ configured: true, source: "file" });
    expect(readDeepseekCredentialState({ ...env, DEEPSEEK_API_KEY: "sk-from-process" })).toMatchObject({
      configured: true,
      source: "env",
    });
  });

  it("保存写入 .env、备份旧文件，且状态里不含密钥", () => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "A=1\n");
    const state = saveDeepseekApiKey(KEY, env);
    expect(state).toEqual({ configured: true, source: "file", path: file });
    expect(fs.readFileSync(file, "utf8")).toBe(`A=1\nDEEPSEEK_API_KEY=${KEY}\n`);
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe("A=1\n");
    expect(JSON.stringify(state)).not.toContain(KEY);
  });

  it("重复保存保持单行，且不残留临时文件", () => {
    saveDeepseekApiKey(KEY, env);
    saveDeepseekApiKey("sk-zzzzzzzzzzzzzzzz", env);
    const text = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(text).toBe("DEEPSEEK_API_KEY=sk-zzzzzzzzzzzzzzzz\n");
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readDeepseekCredentialState(env)).toMatchObject({ configured: true, source: "file" });
  });

  it("非法 Key 不会写盘", () => {
    expect(() => saveDeepseekApiKey("bad key value", env)).toThrow(/可见 ASCII/);
    expect(fs.existsSync(path.join(dir, ".env"))).toBe(false);
  });
});

describe("agent credentials route", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-env-route-"));
    vi.stubEnv("DSH_HOME", dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("GET 报告未配置，POST 写入后 GET 报告 file 来源", async () => {
    const before = await agentsRouter.request("http://localhost/deepseek/credentials");
    expect(await before.json()).toMatchObject({ ok: true, configured: false, source: "none" });

    const saved = await agentsRouter.request("http://localhost/deepseek/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: KEY }),
    });
    const savedBody = (await saved.json()) as Record<string, unknown>;
    expect(savedBody).toMatchObject({ ok: true, configured: true, source: "file", restartRequired: true });
    expect(JSON.stringify(savedBody)).not.toContain(KEY);
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(`DEEPSEEK_API_KEY=${KEY}\n`);

    const after = await agentsRouter.request("http://localhost/deepseek/credentials");
    expect(await after.json()).toMatchObject({ ok: true, configured: true, source: "file" });
  });

  it("非法 Key 返回 400，不写盘", async () => {
    const res = await agentsRouter.request("http://localhost/deepseek/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "bad key value" }),
    });
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(dir, ".env"))).toBe(false);
  });

  it("只对 deepseek 开放", async () => {
    const get = await agentsRouter.request("http://localhost/codex/credentials");
    expect(get.status).toBe(400);
    const post = await agentsRouter.request("http://localhost/codex/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: KEY }),
    });
    expect(post.status).toBe(400);
  });
});
