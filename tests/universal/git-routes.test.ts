import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleUniversal } from "../../server/universal/routes";
import { authedRequest } from "../helpers/gateway-auth";

function req(urlPath: string): Request {
  return authedRequest(`http://localhost${urlPath}`, { method: "GET" });
}

describe("git inspection routes", () => {
  let repo = "";
  let hasGit = true;

  beforeAll(() => {
    const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) {
      hasGit = false;
      return;
    }
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "acp-git-"));
    const run = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    run(["init"]);
    run(["config", "user.email", "t@t.t"]);
    run(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    run(["add", "."]);
    run(["commit", "-m", "init"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\nTWO\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "hello\n");
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it("status lists modified + untracked files with branch", async () => {
    if (!hasGit || !repo) return;
    const res = (await handleUniversal(req(`/api/universal/git/status?cwd=${encodeURIComponent(repo)}`)))!;
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.files.map((f: any) => f.path).sort()).toEqual(["a.txt", "new.txt"]);
    expect(typeof data.branch).toBe("string");
  });

  it("file returns before/after plus unified diff", async () => {
    if (!hasGit || !repo) return;
    const res = (await handleUniversal(req(`/api/universal/git/file?cwd=${encodeURIComponent(repo)}&file=a.txt`)))!;
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.binary).toBe(false);
    expect(data.before).toContain("two");
    expect(data.after).toContain("TWO");
    expect(data.unified).toContain("-two");
    expect(data.unified).toContain("+TWO");
  });

  it("never blocks the event loop while git runs", async () => {
    // spawnSync 会把整个网关堵住：文件树每次文件变动都问一次 git status，
    // 智能体提交时会连续写文件，于是回应提问、聊天流全排在后面，
    // 界面就停在"提交中…"。所以这里要求 git 路由走异步 spawn：
    // 定时器必须先于 git 响应跑出来。
    if (!hasGit || !repo) return;
    const order: string[] = [];
    const pending = handleUniversal(req(`/api/universal/git/status?cwd=${encodeURIComponent(repo)}`))!
      .then(async (res) => {
        await res.json();
        order.push("response");
      });
    await new Promise((r) => setTimeout(r, 0));
    order.push("timer");
    await pending;
    expect(order[0]).toBe("timer");
  });

  it("stages and restores a file change", async () => {
    if (!hasGit || !repo) return;
    // Stage new.txt
    const stageReq = authedRequest("http://localhost/api/universal/git/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: repo, file: "new.txt" }),
    });
    const stageRes = (await handleUniversal(stageReq))!;
    expect(stageRes.status).toBe(200);
    expect((await stageRes.json()).ok).toBe(true);

    // Verify a.txt restore
    const restoreReq = authedRequest("http://localhost/api/universal/git/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: repo, file: "a.txt" }),
    });
    const restoreRes = (await handleUniversal(restoreReq))!;
    expect(restoreRes.status).toBe(200);
    expect((await restoreRes.json()).ok).toBe(true);

    // a.txt should be reverted to original content
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("one\ntwo\n");
  });

  it("rejects non-repos and path escapes", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-nogit-"));
    try {
      const bad = (await handleUniversal(req(`/api/universal/git/status?cwd=${encodeURIComponent(tmp)}`)))!;
      expect(bad.status).toBe(400);
      const esc = (await handleUniversal(
        req(`/api/universal/git/file?cwd=${encodeURIComponent(tmp)}&file=../../x`)
      ))!;
      expect([400, 500].includes(esc.status) || !(await esc.json()).ok).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
