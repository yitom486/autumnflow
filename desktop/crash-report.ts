/**
 * Bounded crash diagnostics for the desktop shell. Electron main can fail
 * before DevTools or the renderer logger are available, so a fatal/renderer
 * crash is written to a small plain-text file next to the user data instead of
 * disappearing into a console that a packaged app does not have.
 */
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";

export type CrashReportSource = "main" | "renderer" | "web-boot" | "child";
export type CrashReportPhase = "startup" | "running";

export interface CrashReportApp {
  name: string;
  version: string;
  platform: string;
  arch: string;
  electron: string;
  node: string;
  locale: string;
}

export interface CrashReportInput {
  source: CrashReportSource;
  phase: CrashReportPhase;
  error: unknown;
  rendererConsole: readonly string[];
  app: CrashReportApp;
  time: Date;
}

export const CRASH_REPORT_PREFIX = "crash-";
const CRASH_REPORT_NAME =
  /^crash-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:main|renderer|web-boot|child)\.log$/;
export const CRASH_REPORTS_RETAINED = 10;
export const RENDERER_CONSOLE_MAX_BYTES = 64 * 1024;
export const ERROR_SECTION_MAX_CHARS = 256 * 1024;

/** Bounded oldest-first tail of renderer error messages. */
export class RendererConsoleTail {
  private lines: string[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes = RENDERER_CONSOLE_MAX_BYTES) {}

  push(line: string): void {
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line);
    while (this.lines.length > 1 && this.bytes > this.maxBytes) {
      this.bytes -= Buffer.byteLength(this.lines.shift() as string);
    }
  }

  snapshot(): readonly string[] {
    return [...this.lines];
  }

  clear(): void {
    this.lines = [];
    this.bytes = 0;
  }
}

export function crashReportFileName(time: Date, source: CrashReportSource): string {
  return `${CRASH_REPORT_PREFIX}${time.toISOString().replaceAll(/[:.]/gu, "-")}-${source}.log`;
}

function boundedError(error: unknown): string {
  const rendered = inspect(error, {
    depth: 6,
    maxStringLength: 64 * 1024,
    maxArrayLength: 100,
    breakLength: 120,
  });
  return rendered.length <= ERROR_SECTION_MAX_CHARS
    ? rendered
    : `${rendered.slice(0, ERROR_SECTION_MAX_CHARS)}\n… (error section cut at ${ERROR_SECTION_MAX_CHARS} characters)`;
}

export function renderCrashReport(input: CrashReportInput): string {
  const header = [
    `time: ${input.time.toISOString()}`,
    `source: ${input.source}`,
    `phase: ${input.phase}`,
    `app: ${input.app.name} ${input.app.version}`,
    `platform: ${input.app.platform} ${input.app.arch}`,
    `electron: ${input.app.electron}`,
    `node: ${input.app.node}`,
    `locale: ${input.app.locale}`,
    `shell pid: ${process.pid}`,
  ];
  const consoleSection =
    input.rendererConsole.length === 0
      ? "(no error-level renderer console output was captured)"
      : input.rendererConsole.join("\n");
  return [
    header.join("\n"),
    "",
    "--- error ---",
    boundedError(input.error),
    "",
    "--- renderer console (error level, oldest first) ---",
    consoleSection,
    "",
  ].join("\n");
}

/** Write one report; returns undefined on I/O failure (never masks the crash). */
export async function writeCrashReport(
  directory: string,
  input: CrashReportInput,
): Promise<string | undefined> {
  const path = join(directory, crashReportFileName(input.time, input.source));
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, renderCrashReport(input), { mode: 0o600, flag: "wx" });
    return path;
  } catch (error) {
    console.error("[CrashReport] could not write", path, error);
    return undefined;
  }
}

/** Delete only generated crash files beyond `retained`, oldest first. */
export async function pruneCrashReports(
  directory: string,
  retained = CRASH_REPORTS_RETAINED,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    console.error("[CrashReport] could not list", directory, error);
    return;
  }
  const reports = names.filter((name) => CRASH_REPORT_NAME.test(name)).sort();
  for (const name of reports.slice(0, Math.max(0, reports.length - retained))) {
    try {
      await unlink(join(directory, name));
    } catch (error) {
      console.error("[CrashReport] could not prune", name, error);
    }
  }
}
