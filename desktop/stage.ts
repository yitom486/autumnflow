/** Prepare a self-contained release app; renderer dependencies stay in dist. */
import * as fs from "node:fs";
import * as path from "node:path";

const NOTICE_FILE = /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/i;
const OMIT_FILE = /(?:\.map|\.pdb|\.d\.ts|\.test\.js)$/i;
const NATIVE_FILES = new Set([
  "pty.node", "conpty.node", "conpty_console_list.node", "spawn-helper",
  "winpty.dll", "winpty-agent.exe",
]);

function readPackage(dir: string) {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
}

function resolvePackage(name: string, from: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

/** Preserve attribution for bundled packages without shipping their source trees. */
export function thirdPartyNotices(projectRoot: string): string {
  const visited = new Set<string>();
  const notices: string[] = [];
  const visit = (dir: string) => {
    const real = fs.realpathSync(dir);
    if (visited.has(real)) return;
    visited.add(real);
    const pkg = readPackage(real);
    const licenseFiles = fs.readdirSync(real, { withFileTypes: true })
      .filter((e) => e.isFile() && NOTICE_FILE.test(e.name));
    notices.push([
      `${pkg.name}@${pkg.version}`,
      `License: ${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? "unspecified")}`,
      ...licenseFiles.map((e) => `${e.name}\n${fs.readFileSync(path.join(real, e.name), "utf8")}`),
    ].join("\n"));
    const required = pkg.dependencies || {};
    const optional = { ...pkg.peerDependencies, ...pkg.optionalDependencies };
    for (const name of new Set([...Object.keys(required), ...Object.keys(optional)])) {
      const child = resolvePackage(name, real);
      if (child) visit(child);
      else if (name in required) throw new Error(`Cannot collect license for required dependency ${pkg.name} -> ${name}`);
    }
  };
  const rootPkg = readPackage(projectRoot);
  // The browser quota parser adapts the MIT SDK; retain its attribution as well.
  const bundled = { ...rootPkg.dependencies, ...(rootPkg.devDependencies?.["@yitom/acp-client"] ? { "@yitom/acp-client": rootPkg.devDependencies["@yitom/acp-client"] } : {}) };
  for (const name of Object.keys(bundled).sort()) {
    const dir = resolvePackage(name, projectRoot);
    if (!dir) throw new Error(`Missing dependency ${name}; run bun install before packaging`);
    visit(dir);
  }
  return `Third-party packages used by AutumnFlow's compiled bundles.\n\n${notices.sort().join("\n\n" + "=".repeat(72) + "\n\n")}\n`;
}

export function stageDesktopApp(projectRoot: string, platform = process.platform, arch = process.arch): string {
  const root = fs.realpathSync(projectRoot);
  const destination = path.resolve(root, ".acp-tmp", "desktop-app");
  // This is the only directory this script may replace; never remove a caller-provided path.
  if (path.relative(root, destination) !== path.join(".acp-tmp", "desktop-app")) {
    throw new Error("Invalid desktop staging path");
  }
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
    throw new Error("Desktop staging directory must not be a symlink");
  }
  const stageParent = path.dirname(destination);
  if (fs.existsSync(stageParent) && fs.realpathSync(stageParent) !== stageParent) {
    throw new Error("Desktop staging parent must not be a symlink");
  }
  for (const file of ["dist/index.html", "electron-dist/main.cjs", "electron-dist/preload.cjs"]) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing ${file}; run bun run build and bun run build:electron first`);
  }
  const source = resolvePackage("node-pty", root);
  if (!source) throw new Error("Missing node-pty; run bun install before packaging");
  const nativeName = platform === "win32" ? "conpty.node" : "pty.node";
  const prebuild = path.join(source, "prebuilds", `${platform}-${arch}`);
  const compiled = path.join(source, "build", "Release");
  const nativeSource = fs.existsSync(path.join(prebuild, nativeName)) ? prebuild : compiled;
  if (!fs.existsSync(path.join(nativeSource, nativeName))) {
    throw new Error(`Missing node-pty native runtime for ${platform}-${arch}; install/build node-pty on the target platform`);
  }
  const notices = thirdPartyNotices(root);
  const runtimePkg = readPackage(source);

  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const dir of ["dist", "electron-dist"]) {
    fs.cpSync(path.join(root, dir), path.join(destination, dir), {
      recursive: true, dereference: true,
      filter: (file) => !OMIT_FILE.test(file),
    });
  }
  const runtimeDir = path.join(destination, "node_modules", "node-pty");
  fs.mkdirSync(runtimeDir, { recursive: true });
  // node-addon-api supplies compile-time headers; the staged native binary is
  // already built. Remove only that dependency from the release manifest so
  // builder cannot pull the headers back in from the development installation.
  const stagedRuntimePkg = { ...runtimePkg, dependencies: { ...runtimePkg.dependencies } };
  delete stagedRuntimePkg.dependencies["node-addon-api"];
  fs.writeFileSync(path.join(runtimeDir, "package.json"), JSON.stringify(stagedRuntimePkg, null, 2) + "\n");
  for (const e of fs.readdirSync(source, { withFileTypes: true })) {
    if (e.isFile() && NOTICE_FILE.test(e.name)) fs.copyFileSync(path.join(source, e.name), path.join(runtimeDir, e.name));
  }
  fs.cpSync(path.join(source, "lib"), path.join(runtimeDir, "lib"), {
    recursive: true, filter: (file) => !OMIT_FILE.test(file),
  });
  const nativeDestination = path.join(runtimeDir, path.relative(source, nativeSource));
  fs.mkdirSync(nativeDestination, { recursive: true });
  for (const name of fs.readdirSync(nativeSource)) {
    if (!NATIVE_FILES.has(name)) continue;
    fs.cpSync(path.join(nativeSource, name), path.join(nativeDestination, name), {
      recursive: true, filter: (file) => !OMIT_FILE.test(file),
    });
  }
  const pkg = readPackage(root);
  const { name, version, description, author, license, homepage, repository, type, main } = pkg;
  fs.writeFileSync(path.join(destination, "package.json"), JSON.stringify({
    name, version, description, author, license, homepage, repository, type, main,
    dependencies: { "node-pty": runtimePkg.version },
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(destination, "THIRD-PARTY-NOTICES.txt"), notices);
  if (fs.existsSync(path.join(root, "LICENSE"))) fs.copyFileSync(path.join(root, "LICENSE"), path.join(destination, "LICENSE"));
  return destination;
}

if (import.meta.main) {
  const platform = process.argv[2] || process.platform;
  const arch = process.argv[3] || process.arch;
  const destination = stageDesktopApp(path.resolve(import.meta.dir, ".."), platform as NodeJS.Platform, arch as typeof process.arch);
  console.log(`[desktop] staged ${platform}-${arch} runtime at ${destination}; renderer libraries remain bundled in dist`);
}
