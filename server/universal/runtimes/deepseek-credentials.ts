/**
 * DeepSeek 凭据落盘（DSH 的 user-env 层）。
 *
 * DSH 的凭据解析顺序是：`.credentials.yaml` 托管仓库 > 进程环境 > 项目 `.env`
 * > `$DSH_HOME/.env`。这里只写最低优先级的 user-env 文件，原因：
 * - 托管文件由 DSH 自己用 YAML + 跨进程锁维护，外部写入容易和它的写入互相覆盖；
 * - `.env` 是 DSH 明确支持的启动环境层（`loadEnvFile`），格式简单、可审计；
 * - 托管仓库里若已有同名引用，会优先生效，不会因为这里多写一行而被改写。
 *
 * 写入是原子的（同目录临时文件 + rename），并且保留文件里其他所有行；
 * 旧内容会先备份为 `.env.bak`。密钥只出现在文件里，不写日志、不回显。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const KEY = "DEEPSEEK_API_KEY";
/** 只接受可安全放进 dotenv 单行的值：无空白/控制字符/引号/反斜杠/#。 */
const SAFE_VALUE = /^[\x21-\x7e]+$/;

export type DeepseekCredentialSource = "env" | "file" | "none";

export interface DeepseekCredentialState {
  configured: boolean;
  source: DeepseekCredentialSource;
  /** DSH user-env 文件的绝对路径（即使尚未创建也返回，便于界面展示）。 */
  path: string;
}

/** `$DSH_HOME/.env`，缺省 `<home>/.dsh/.env`。 */
export function deepseekEnvFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
  return path.join(home, ".env");
}

/** 校验并规整 API Key；失败抛出可展示的中文错误。 */
export function validateDeepseekApiKey(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("API Key 必须是字符串");
  const key = raw.trim();
  if (key.length < 8 || key.length > 512) throw new Error("API Key 长度需在 8–512 个字符之间");
  if (!SAFE_VALUE.test(key)) throw new Error("API Key 只能包含可见 ASCII 字符（不能有空格、换行或中文）");
  if (/["'#\\]/.test(key)) throw new Error("API Key 不能包含引号、反斜杠或 #，以免 dotenv 解析歧义");
  return key;
}

/**
 * 把 Key 写进 .env 文本：移除已有的同名行（含 `export` 前缀与不同大小写），
 * 再追加到末尾；保留注释与其它变量，沿用原文件的换行风格。
 */
export function applyDeepseekKeyToEnv(text: string, key: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length > 0 ? text.split(/\r?\n/) : [];
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.filter((line) => !new RegExp(`^[ \\t]*(?:export[ \\t]+)?${KEY}[ \\t]*=`, "i").test(line));
  kept.push(`${KEY}=${key}`);
  return `${kept.join(eol)}${eol}`;
}

/** 当前 Key 是否已配置：进程环境优先，其次 `$DSH_HOME/.env`。 */
export function readDeepseekCredentialState(env: NodeJS.ProcessEnv = process.env): DeepseekCredentialState {
  const file = deepseekEnvFile(env);
  if (env[KEY]?.trim()) return { configured: true, source: "env", path: file };
  let fromFile = false;
  try {
    if (fs.existsSync(file)) {
      const line = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${KEY}[ \\t]*=[ \\t]*\\S`, "m");
      fromFile = line.test(fs.readFileSync(file, "utf8"));
    }
  } catch {
    fromFile = false;
  }
  return { configured: fromFile, source: fromFile ? "file" : "none", path: file };
}

/** 原子写入 Key；返回写入后的状态（不回显密钥）。 */
export function saveDeepseekApiKey(
  rawKey: unknown,
  env: NodeJS.ProcessEnv = process.env,
): DeepseekCredentialState {
  const key = validateDeepseekApiKey(rawKey);
  const file = deepseekEnvFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exists = fs.existsSync(file);
  const existing = exists ? fs.readFileSync(file, "utf8") : "";
  const next = applyDeepseekKeyToEnv(existing, key);
  if (exists) {
    try {
      fs.writeFileSync(`${file}.bak`, existing, { mode: 0o600 });
    } catch {
      // 备份失败不阻塞保存：主写入仍是原子的。
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 无 POSIX 权限位
  }
  return readDeepseekCredentialState(env);
}
