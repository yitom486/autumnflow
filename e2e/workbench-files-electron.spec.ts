import { test, expect } from "@playwright/test";
import { launchElectronApp } from "./helpers/launch-electron";

// 工作台的文件树与编辑器：项目自己的 .gitignore 决定哪些目录进树（和 VS Code
// 一致），被忽略的构建目录不该出现在里面；点开一个文件要在编辑器里看到内容。
test.describe("workbench file tree", () => {
  test("hides .gitignore'd folders and opens a file in the editor", async ({}, info) => {
    const launched = await launchElectronApp({
      workspaceFiles: {
        ".gitignore": "ignored-dir/\n*.log\n",
        "README.md": "# 标题\n\n正文内容\n",
        "src/app.ts": "export const x = 1;\n",
        "ignored-dir/secret.txt": "不该出现在树里\n",
        "debug.log": "也不该出现\n",
      },
    });
    const { page } = launched;
    try {
      // 文件树默认收起：把工作台偏好写成展开，再重载让应用读到。
      await page.evaluate(() =>
        localStorage.setItem("acp_workbench_prefs_v1", JSON.stringify({ sidebarOpen: true, fileTreeOpen: true })),
      );
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", /.*/, { timeout: 15000 });

      const tree = page.getByRole("tree", { name: "工作区文件" });
      await expect(tree).toBeVisible({ timeout: 20000 });

      // 普通目录在树里
      await expect(tree.getByRole("treeitem", { name: "src" })).toBeVisible({ timeout: 10000 });
      await expect(tree.getByRole("treeitem", { name: "README.md" })).toBeVisible({ timeout: 10000 });

      // 被 .gitignore 忽略的不在树里
      await expect(tree.getByRole("treeitem", { name: "ignored-dir" })).toHaveCount(0);
      await expect(tree.getByRole("treeitem", { name: "debug.log" })).toHaveCount(0);

      // 点开一个文件，编辑器里能看到内容
      await tree.getByRole("treeitem", { name: "README.md" }).click();
      await expect(page.getByText("正文内容", { exact: false }).first()).toBeVisible({ timeout: 15000 });
    } finally {
      await launched.cleanup();
    }
  });
});
