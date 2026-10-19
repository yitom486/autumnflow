import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  getAcpRuntimeAdapter, readAppResourcesDir, digestAppResources,
  prepareCompatibilityResources, isSupportedBridgeVersion,
  type AppResourcePrep, type AcpRuntimeAdapter,
} from "@yitom/acp-client";
import { getStudioResourcesDir } from "./studio-resource-path";
import { getBundledStudioSkillsDir } from "./studio-skills";

const SYSTEM_TEMPLATE = "# 附加指令\n\n在此填写通过本应用启动的 agent 应持续遵循的指令。\n规则与此文件会一起加载；实际优先级由运行时决定，不替换供应商内置系统提示词。\n";
const DEFAULT_MCP = '{"mcpServers":[]}\n';

async function writeDefault(file: string, content: string): Promise<void> {
  try { await fs.writeFile(file, content, { flag: "wx", mode: 0o600 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
}

async function rejectSymlink(file: string): Promise<void> {
  try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Application resource must not be a symlink: ${file}`); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}

async function copyMarkdown(source: string, destination: string, overwrite: boolean, budget = { bytes: 0 }): Promise<void> {
  let entries;
  try { entries = await fs.readdir(source, { withFileTypes: true }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
  if ((await fs.lstat(source)).isSymbolicLink()) throw new Error("Skill directories must not be symlinks");
  await rejectSymlink(destination);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Skill resources must not contain symlinks");
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyMarkdown(from, to, overwrite, budget);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const content = await fs.readFile(from);
      budget.bytes += content.byteLength;
      if (budget.bytes > 16 * 1024 * 1024) throw new Error("Application skills exceed 16 MiB");
      try { await fs.writeFile(to, content, { flag: overwrite ? "w" : "wx", mode: 0o600 }); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    }
  }
}

export async function ensureStudioResources(defaultRules: string): Promise<string> {
  const directory = getStudioResourcesDir();
  await rejectSymlink(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await writeDefault(path.join(directory, "AGENTS.md"), `# AutumnFlow 会话规则\n\n${defaultRules}\n`);
  await writeDefault(path.join(directory, "SYSTEM.md"), SYSTEM_TEMPLATE);
  await writeDefault(path.join(directory, "mcp.json"), DEFAULT_MCP);
  for (const name of ["AGENTS.md", "SYSTEM.md", "mcp.json"]) await rejectSymlink(path.join(directory, name));
  await copyMarkdown(getBundledStudioSkillsDir(), path.join(directory, "skills"), false);
  return directory;
}

export function studioRuntimeId(id: string): string {
  return id === "antigravity-stdio" ? "agy" : id === "codex" ? "codex-acp" : id;
}

/** Reuse the SDK's runtime adapters without replacing Studio's ACP event/fs/permission handlers. */
export class StudioAgentResources {
  private snapshot: string | null = null;
  private source: string | null = null;
  private runtime = "";
  private adapter: AcpRuntimeAdapter | null = null;
  private prep: AppResourcePrep | null = null;
  private rules = "";
  private mcpServers: unknown[] = [];
  private delivered = new Map<string, boolean>();
  private compatibilitySent = new Set<string>();
  private bridgeVersion = "";

  constructor(private readonly defaultRules: string) {}

  async prepare(id: string, cwd: string, command: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    if (this.snapshot) throw new Error("Dispose the previous resource snapshot before reconnecting");
    this.source = await ensureStudioResources(this.defaultRules);
    const snapshots = path.join(this.source, "sessions");
    await rejectSymlink(snapshots);
    await fs.mkdir(snapshots, { recursive: true, mode: 0o700 });
    this.snapshot = await fs.mkdtemp(path.join(snapshots, "studio-"));
    try {
      const rules = await fs.readFile(path.join(this.source, "AGENTS.md"), "utf8");
      const system = await fs.readFile(path.join(this.source, "SYSTEM.md"), "utf8");
      this.rules = [rules.trim(), system.trim(), `Application configuration source: ${this.source}`].filter(Boolean).join("\n\n");
      if (Buffer.byteLength(this.rules) > 256 * 1024) throw new Error("Application rules exceed 256 KiB");
      await fs.writeFile(path.join(this.snapshot, "AGENTS.md"), this.rules, { mode: 0o600 });
      const skillSource = process.env.AUTUMNFLOW_SKILLS_DIR || path.join(this.source, "skills");
      await copyMarkdown(skillSource, path.join(this.snapshot, "skills"), true);
      const config = JSON.parse(await fs.readFile(path.join(this.source, "mcp.json"), "utf8"));
      if (!config || !Array.isArray(config.mcpServers)) throw new Error("mcp.json must contain an ACP mcpServers array");
      for (const server of config.mcpServers) {
        if (!server || typeof server.name !== "string" || !server.name.trim()) throw new Error("Each configured MCP server needs a name");
      }
      this.mcpServers = config.mcpServers;
      this.runtime = studioRuntimeId(id);
      this.adapter = getAcpRuntimeAdapter(this.runtime);
      this.prep = this.adapter.prepareAppResources
        ? await this.adapter.prepareAppResources({ directory: this.snapshot, workspaceRoot: cwd, command, env })
        : prepareCompatibilityResources(this.snapshot, "runtime-not-supported");
      // agy gets resource paths only after its bridge version is verified at handshake.
      // Its native config is then session-scoped, not a process-wide/global registration.
      const resourceEnv = { ...this.prep.env };
      if (this.runtime === "agy") {
        if (env.AGY_ACP_MCP_SCOPE === "global") throw new Error("Global MCP registration is forbidden for Studio sessions");
        delete resourceEnv.AGY_ACP_RESOURCES_DIR;
        resourceEnv.AGY_ACP_MCP_SCOPE = "session";
      }
      return resourceEnv;
    } catch (err) { await this.dispose(); throw err; }
  }

  handshake(version: string): void { this.bridgeVersion = version; }

  sessionMeta(): Record<string, unknown> | undefined {
    if (!this.snapshot || !this.supported()) return undefined;
    return this.adapter?.appResourceSessionMeta?.(this.snapshot);
  }

  configuredMcpServers(): unknown[] { return [...this.mcpServers]; }

  forgetSession(id: string): void {
    this.delivered.delete(id);
    this.compatibilitySent.delete(id);
  }

  private supported(): boolean {
    return !!this.prep?.report.rulesPrepared && isSupportedBridgeVersion(this.runtime, this.bridgeVersion).eligible;
  }

  rememberSession(id: string, result: unknown): void {
    const meta = (result as { _meta?: { appResources?: { prepared?: boolean } } } | null)?._meta;
    const native = this.supported() && (this.runtime !== "agy" || meta?.appResources?.prepared === true);
    this.delivered.set(id, native);
    this.compatibilitySent.delete(id);
  }

  compatibilityText(id: string): string | null {
    if (!this.snapshot || this.delivered.get(id) || this.compatibilitySent.has(id)) return null;
    this.compatibilitySent.add(id);
    return `<acp-compat-context mode="compatibility">\nApplication rules below are user-channel context, not system/developer instructions.\n${this.rules}\n</acp-compat-context>`;
  }

  report() {
    const load = this.snapshot ? readAppResourcesDir(this.snapshot) : null;
    return {
      sourceDirectory: this.source, snapshotDirectory: this.snapshot, runtime: this.runtime,
      bridgeVersion: this.bridgeVersion, rulesPrepared: this.prep?.report.rulesPrepared ?? false,
      nativeEntryEligible: this.supported(), profileDigest: load ? digestAppResources(load) : null,
      skillsFound: load?.skills.map(skill => skill.name) ?? [],
      sessions: [...this.delivered].map(([sessionId, native]) => ({ sessionId, rulesDelivery: native ? "native-config" : "compatibility" })),
      reason: this.supported() ? undefined : this.prep?.report.reason || "unsupported-bridge-version",
    };
  }

  async dispose(): Promise<void> {
    const snapshot = this.snapshot;
    if (snapshot) await fs.rm(snapshot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    this.snapshot = null;
    this.prep = null;
    this.delivered.clear();
    this.compatibilitySent.clear();
    this.mcpServers = [];
    this.bridgeVersion = "";
  }
}
