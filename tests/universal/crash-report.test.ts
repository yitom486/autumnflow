// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CRASH_REPORT_PREFIX,
  RendererConsoleTail,
  crashReportFileName,
  pruneCrashReports,
  renderCrashReport,
  writeCrashReport,
  type CrashReportInput,
} from "../../desktop/crash-report";

const dirs: string[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autumnflow-crash-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (path.basename(dir).startsWith("autumnflow-crash-")) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

const app = {
  name: "AutumnFlow",
  version: "0.1.11",
  platform: "win32",
  arch: "x64",
  electron: "44.0.0",
  node: "24.0.0",
  locale: "zh-CN",
};

function input(overrides: Partial<CrashReportInput> = {}): CrashReportInput {
  return {
    source: "renderer",
    phase: "running",
    error: new Error("boom"),
    rendererConsole: ["[error] first", "[error] second"],
    app,
    time: new Date("2026-10-18T12:00:00.000Z"),
    ...overrides,
  };
}

describe("crash report", () => {
  it("renders a bounded, readable report with app facts and console tail", () => {
    const text = renderCrashReport(input());
    expect(text).toContain("source: renderer");
    expect(text).toContain("app: AutumnFlow 0.1.11");
    expect(text).toContain("--- error ---");
    expect(text).toContain("boom");
    expect(text).toContain("[error] second");
    expect(crashReportFileName(input().time, "renderer")).toBe(
      "crash-2026-10-18T12-00-00-000Z-renderer.log"
    );
  });

  it("bounds renderer console tail by bytes while keeping one oversized line", () => {
    const tail = new RendererConsoleTail(10);
    tail.push("12345");
    tail.push("67890");
    tail.push("x".repeat(100));
    const snapshot = tail.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toHaveLength(100);
  });

  it("writes and prunes only generated crash reports", async () => {
    const dir = tempDir();
    const unrelated = path.join(dir, "keep-me.log");
    fs.writeFileSync(unrelated, "keep");
    for (let i = 0; i < 12; i++) {
      const time = new Date(Date.UTC(2026, 9, 18, 12, 0, i));
      const file = await writeCrashReport(dir, input({ time, source: i % 2 ? "renderer" : "main" }));
      expect(file).toBeTruthy();
      expect(path.basename(file!)).toMatch(new RegExp(`^${CRASH_REPORT_PREFIX}`));
    }
    await pruneCrashReports(dir, 3);
    const names = fs.readdirSync(dir).filter((n) => n.startsWith(CRASH_REPORT_PREFIX));
    expect(names).toHaveLength(3);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
