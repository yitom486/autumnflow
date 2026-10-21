import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleUniversal } from "../../server/universal/routes";
import { useStudioStore } from "../../src/stores/useStudioStore";
import { authedRequest } from "../helpers/gateway-auth";

describe("workspace and terminal routes", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStudio();
  });

  it("returns default workspace", async () => {
    const req = authedRequest("http://localhost/api/universal/workspace/default", { method: "GET" });
    const res = (await handleUniversal(req))!;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.path).toBe("string");
    expect(typeof data.name).toBe("string");
  });

  it("lists directories without blocking the event loop", async () => {
    // 目录选择器会顺带查 WSL 快捷项，而 wsl.exe 冷启动要十几秒。同步查会把
    // 整个网关堵住——本地 Windows 工作区也一样被拖慢（快捷项和列表在同一个
    // 响应里）。所以这条路径上不允许同步起子进程。
    const source = fs.readFileSync(path.join(process.cwd(), "server", "universal", "http", "workspace.ts"), "utf8");
    expect(source).not.toMatch(/\bspawnSync\b/);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-ws-list-"));
    try {
      const req = authedRequest(`http://localhost/api/universal/workspace/directories?dir=${encodeURIComponent(tmp)}`, { method: "GET" });
      const res = (await handleUniversal(req))!;
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.entries)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("validates existing directory and detects git", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-ws-"));
    try {
      const req = authedRequest("http://localhost/api/universal/workspace/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: tmp }),
      });
      const res = (await handleUniversal(req))!;
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.path.toLowerCase()).toBe(path.resolve(tmp).toLowerCase());
      expect(data.isGit).toBe(false);

      // Now create .git folder
      fs.mkdirSync(path.join(tmp, ".git"));
      const req2 = authedRequest("http://localhost/api/universal/workspace/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: tmp }),
      });
      const res2 = (await handleUniversal(req2))!;
      const data2 = await res2.json();
      expect(data2.ok).toBe(true);
      expect(data2.isGit).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects non-existent path and files as directory", async () => {
    // Non-existent path
    const badPath = path.join(os.tmpdir(), "non_existent_dir_123456");
    const req = authedRequest("http://localhost/api/universal/workspace/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: badPath }),
    });
    const res = (await handleUniversal(req))!;
    const data = await res.json();
    expect(data.ok).toBe(false);

    // File as directory
    const tmpFile = path.join(os.tmpdir(), "temp_file_for_test.txt");
    fs.writeFileSync(tmpFile, "test");
    try {
      const fileReq = authedRequest("http://localhost/api/universal/workspace/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: tmpFile }),
      });
      const fileRes = (await handleUniversal(fileReq))!;
      const fileData = await fileRes.json();
      expect(fileData.ok).toBe(false);
      expect(fileData.error).toContain("不是有效目录");
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  // 真 shell 冷启动（尤其 Windows runner 上 PowerShell + Defender 首次
  // 加载）5s 默认超时不够，第一轮发版即因此 flake；放宽到 30s。
  it("streams terminal execution output", { timeout: 30000 }, async () => {
    const tmp = os.tmpdir();
    const isWin = process.platform === "win32";
    const command = isWin ? "Write-Output 'acp_terminal_ok'" : "echo 'acp_terminal_ok'";

    const req = authedRequest("http://localhost/api/universal/terminal/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tmp, command }),
    });

    const res = (await handleUniversal(req))!;
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }
    expect(output).toContain("acp_terminal_ok");
  }, 30_000); // Windows CI 上 PowerShell 冷启动慢

  it("manages workspace and terminal state in useStudioStore", () => {
    const s = useStudioStore.getState();
    expect(s.terminalOpen).toBe(false);
    expect(s.gitChangesOpen).toBe(false);

    // Toggle terminal
    s.setTerminalOpen(true);
    expect(useStudioStore.getState().terminalOpen).toBe(true);

    // Open Git diff with target file
    s.setGitChangesOpen(true, "src/index.ts");
    expect(useStudioStore.getState().gitChangesOpen).toBe(true);
    expect(useStudioStore.getState().gitDiffFile).toBe("src/index.ts");

    // Set workspace and verify recentWorkspaces updating
    s.setWorkspace("D:/project/alpha", "alpha");
    expect(useStudioStore.getState().currentWorkspace).toBe("D:/project/alpha");
    expect(useStudioStore.getState().recentWorkspaces[0].name).toBe("alpha");

    // Adding another workspace shifts it to front
    s.setWorkspace("D:/project/beta", "beta");
    expect(useStudioStore.getState().currentWorkspace).toBe("D:/project/beta");
    expect(useStudioStore.getState().recentWorkspaces[0].name).toBe("beta");
    expect(useStudioStore.getState().recentWorkspaces[1].name).toBe("alpha");

    // Re-adding alpha brings it back to front without duplicates
    s.setWorkspace("D:/project/alpha", "alpha");
    const recents = useStudioStore.getState().recentWorkspaces;
    expect(recents[0].name).toBe("alpha");
    expect(recents.filter((r) => r.name === "alpha")).toHaveLength(1);
  });
});
