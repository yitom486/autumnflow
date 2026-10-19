// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stageDesktopApp } from "../../desktop/stage";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-package-"));
  roots.push(root);
  const write = (file: string, value: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), value);
  };
  write("package.json", JSON.stringify({ name: "autumnflow", version: "0.1.5", type: "module", main: "electron-dist/main.cjs", dependencies: { mermaid: "1.0.0", "node-pty": "1.1.0" } }));
  write("dist/index.html", '<script type="module" src="/assets/chat.js"></script>');
  write("dist/assets/chat.js", 'import("./mermaid.js")');
  write("dist/assets/mermaid.js", "export const render = () => '<svg></svg>';");
  write("dist/assets/mermaid.js.map", "debug only");
  write("dist/fonts/math.woff2", "font bytes");
  write("electron-dist/main.cjs", 'require("electron");require("node-pty")');
  write("electron-dist/preload.cjs", 'require("electron")');
  write("electron-dist/host.cjs", 'require("node-pty")');
  write("LICENSE", "project license");
  write("node_modules/mermaid/package.json", JSON.stringify({ name: "mermaid", version: "1.0.0", license: "MIT" }));
  write("node_modules/mermaid/LICENSE", "Mermaid attribution");
  write("node_modules/mermaid/dist/unused.js", "redundant source");
  write("node_modules/node-pty/package.json", JSON.stringify({ name: "node-pty", version: "1.1.0", main: "lib/index.js", dependencies: { "node-addon-api": "7.1.0" }, license: "MIT" }));
  write("node_modules/node-pty/LICENSE", "node-pty attribution");
  write("node_modules/node-pty/lib/index.js", "module.exports = {};");
  write("node_modules/node-pty/lib/index.js.map", "debug only");
  write("node_modules/node-pty/lib/index.test.js", "test only");
  write("node_modules/node-pty/src/native.cc", "build only");
  write("node_modules/node-pty/prebuilds/win32-x64/conpty.node", "native bytes");
  write("node_modules/node-pty/prebuilds/win32-x64/conpty.pdb", "symbols");
  write("node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe", "helper bytes");
  write("node_modules/node-pty/prebuilds/win32-arm64/conpty.node", "other arch");
  write("node_modules/node-addon-api/package.json", JSON.stringify({ name: "node-addon-api", version: "7.1.0", license: "MIT" }));
  write("node_modules/node-addon-api/LICENSE.md", "addon attribution");
  return { root, write };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("desktop release app", () => {
  it("keeps compiled Mermaid and Markdown assets without their redundant npm trees", () => {
    const { root } = fixture();
    const app = stageDesktopApp(root, "win32", "x64");
    const pkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({ "node-pty": "1.1.0" });
    expect(pkg.main).toBe("electron-dist/main.cjs");
    for (const file of ["dist/index.html", "dist/assets/chat.js", "dist/assets/mermaid.js", "dist/fonts/math.woff2", "electron-dist/main.cjs", "electron-dist/preload.cjs", "electron-dist/host.cjs"]) {
      expect(fs.readFileSync(path.join(app, file))).toEqual(fs.readFileSync(path.join(root, file)));
    }
    expect(fs.existsSync(path.join(app, "node_modules/mermaid"))).toBe(false);
    expect(fs.existsSync(path.join(root, "node_modules/mermaid/dist/unused.js"))).toBe(true);
    expect(fs.readFileSync(path.join(app, "THIRD-PARTY-NOTICES.txt"), "utf8")).toContain("Mermaid attribution");
    expect(fs.readFileSync(path.join(app, "LICENSE"), "utf8")).toBe("project license");
  });

  it("keeps current-architecture PTY helpers, drops debug/source files, and replaces stale output", () => {
    const { root } = fixture();
    const app = stageDesktopApp(root, "win32", "x64");
    fs.mkdirSync(path.join(app, "node_modules/mermaid"));
    stageDesktopApp(root, "win32", "x64");
    for (const file of ["node_modules/node-pty/lib/index.js", "node_modules/node-pty/prebuilds/win32-x64/conpty.node"]) {
      expect(fs.existsSync(path.join(app, file))).toBe(true);
    }
    for (const file of ["node_modules/mermaid", "node_modules/node-addon-api", "node_modules/node-pty/prebuilds/win32-x64/conpty", "node_modules/node-pty/prebuilds/win32-arm64", "node_modules/node-pty/src", "node_modules/node-pty/lib/index.test.js", "node_modules/node-pty/lib/index.js.map", "node_modules/node-pty/prebuilds/win32-x64/conpty.pdb", "dist/assets/mermaid.js.map"]) {
      expect(fs.existsSync(path.join(app, file))).toBe(false);
    }
    const staged = JSON.parse(fs.readFileSync(path.join(app, "node_modules/node-pty/package.json"), "utf8"));
    const source = JSON.parse(fs.readFileSync(path.join(root, "node_modules/node-pty/package.json"), "utf8"));
    expect(staged.dependencies).toEqual({});
    expect(source.dependencies).toEqual({ "node-addon-api": "7.1.0" });
    expect(fs.readFileSync(path.join(app, "THIRD-PARTY-NOTICES.txt"), "utf8")).toContain("addon attribution");
  });

  it("supports source-built Linux native files and fails before replacing a valid stage when missing", () => {
    const { root, write } = fixture();
    write("node_modules/node-pty/build/Release/pty.node", "linux native");
    write("node_modules/node-pty/build/Release/spawn-helper", "linux helper");
    write("node_modules/node-pty/build/Release/obj.target/debug.o", "build junk");
    const app = stageDesktopApp(root, "linux", "x64");
    expect(fs.existsSync(path.join(app, "node_modules/node-pty/build/Release/spawn-helper"))).toBe(true);
    expect(fs.existsSync(path.join(app, "node_modules/node-pty/build/Release/obj.target"))).toBe(false);
    fs.rmSync(path.join(root, "node_modules/node-pty/build/Release/pty.node"));
    expect(() => stageDesktopApp(root, "linux", "x64")).toThrow("Missing node-pty native runtime");
    expect(fs.existsSync(path.join(app, "dist/index.html"))).toBe(true);
  });
});
