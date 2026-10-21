// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { getSystemDirectoryRoots } from "../../server/universal/http/workspace";
import { getWorkspaceEnv, isLocalMode, getWorkspaceStorageKey } from "../../src/stores/useStudioStore";

describe("WSL and Windows Environment Isolation", () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) || null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  };

  beforeEach(() => {
    store.clear();
  });

  it("identifies local Windows environment by default", () => {
    expect(getWorkspaceEnv()).toBe("local");
    expect(isLocalMode()).toBe(true);
    expect(getWorkspaceStorageKey()).toBe("acp_workspace_local");
  });

  it("identifies WSL native environment strictly when distro is configured", () => {
    localStorage.setItem("acp_wsl_native_distro", "Ubuntu");
    // 不管 base 是否存在，均直接识别为 wsl_ubuntu
    expect(getWorkspaceEnv()).toBe("wsl_ubuntu");
    expect(isLocalMode()).toBe(false);
    expect(getWorkspaceStorageKey()).toBe("acp_workspace_wsl_ubuntu");
  });

  it("isolates directory roots for WSL distros without exposing Windows drive letters", async () => {
    if (process.platform === "win32") {
      const wslRoots = await getSystemDirectoryRoots("Ubuntu");
      expect(wslRoots.length).toBeGreaterThanOrEqual(1);
      // 必须包含 WSL 专属标签
      const labels = wslRoots.map((r) => r.label);
      expect(labels.some((l) => l.includes("WSL: Ubuntu"))).toBe(true);
      // 绝不能包含 Windows 盘符 C: 或 D:
      expect(labels.some((l) => l.includes("本地磁盘 (C:)"))).toBe(false);
      expect(labels.some((l) => l.includes("本地磁盘 (D:)"))).toBe(false);

      // 本地 Windows 模式应返回 Windows 驱动器
      const localRoots = await getSystemDirectoryRoots();
      const localLabels = localRoots.map((r) => r.label);
      expect(localLabels.some((l) => l.includes("本地磁盘"))).toBe(true);
    }
  });
});
