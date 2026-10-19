/**
 * AutumnFlow 发版脚本：默认 patch （+0.0.1），自动同步 CHANGELOG。
 *
 *   bun run release:patch [--notes "..."] [--dry-run]
 *   bun run release:minor --allow-minor [--notes "..."] [--dry-run]
 *   bun run release:major --allow-major [--notes "..."] [--dry-run]
 *
 * 规则（见 .agents/rules/version_control.md）：
 * - 日常只允许 patch；minor/major 必须显式放行
 *   （--allow-minor/--allow-major 或 ALLOW_MINOR_BUMP/ALLOW_MAJOR_BUMP=true）。
 * - package.json 是唯一事实源；CHANGELOG 的 Unreleased 小节在发版时归档。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const PKG = path.join(ROOT, "package.json");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");

function usage(fail = false): never {
  console.error(`用法:
  bun run release:patch [--notes "..."] [--dry-run]
  bun run release:minor --allow-minor [--notes "..."] [--dry-run]
  bun run release:major --allow-major [--notes "..."] [--dry-run]`);
  process.exit(fail ? 1 : 0);
}

function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`package.json version 非法: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) usage();
  const mode = argv.find((a) => ["patch", "minor", "major"].includes(a)) || "patch";
  const notesIdx = argv.indexOf("--notes");
  const notes = notesIdx >= 0 ? argv[notesIdx + 1] || "" : "";
  const dryRun = argv.includes("--dry-run");
  const allowMinor = argv.includes("--allow-minor") || process.env.ALLOW_MINOR_BUMP === "true";
  const allowMajor = argv.includes("--allow-major") || process.env.ALLOW_MAJOR_BUMP === "true";

  if (mode === "minor" && !allowMinor) {
    throw new Error("minor 跃迁需要显式放行：加 --allow-minor 或 ALLOW_MINOR_BUMP=true（需用户许可）");
  }
  if (mode === "major" && !allowMajor) {
    throw new Error("major 跃迁需要显式放行：加 --allow-major 或 ALLOW_MAJOR_BUMP=true（需用户许可）");
  }

  const pkgRaw = fs.readFileSync(PKG, "utf8");
  const pkg = JSON.parse(pkgRaw);
  const [major, minor, patch] = parseVersion(pkg.version);
  const next =
    mode === "major"
      ? `${major + 1}.0.0`
      : mode === "minor"
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`;
  const date = today();

  if (!fs.existsSync(CHANGELOG)) throw new Error("CHANGELOG.md 不存在");
  const log = fs.readFileSync(CHANGELOG, "utf8");
  const unreleasedHeader = "## [Unreleased]";
  const hi = log.indexOf(unreleasedHeader);
  if (hi < 0) throw new Error("CHANGELOG 缺少 ## [Unreleased] 小节");
  const bodyStart = hi + unreleasedHeader.length;
  const nextHeader = log.indexOf("\n## [", bodyStart);
  const kept = (nextHeader >= 0 ? log.slice(bodyStart, nextHeader) : log.slice(bodyStart))
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith(">") && !t.startsWith("<!--") && t !== "-->";
    }); // 去掉占位说明（引用块/注释），保留小节标题与条目
  const hasBullets = kept.some((l) => /^[-*]\s+\S/.test(l.trim()) || /^\d+\.\s+\S/.test(l.trim()));
  const unreleasedBody = kept.join("\n").trim();
  const rest = nextHeader >= 0 ? log.slice(nextHeader) : "";

  let archived = unreleasedBody;
  if (notes.trim()) {
    const bullet = notes
      .trim()
      .split("\n")
      .map((l) => (l.trim().startsWith("-") ? l.trim() : `- ${l.trim()}`))
      .join("\n");
    archived = archived ? `${archived}\n${bullet}` : `### Added\n${bullet}`;
  }
  if (!hasBullets && !notes.trim()) {
    throw new Error("Unreleased 为空且未给 --notes：请先在 CHANGELOG 里记一笔，或用 --notes 附上说明");
  }

  // 推导仓库链接前缀（沿用文件底部的 [Unreleased] 定义）
  const linkMatch = log.match(/\[Unreleased\]:\s*(\S+?)\/compare\/[^.\s]+\.\.\.HEAD/);
  const repoBase = linkMatch ? linkMatch[1] : "https://github.com/yitom486/autumnflow";
  const linkDef = `[${next}]: ${repoBase}/releases/tag/v${next}`;
  const newUnreleasedLink = `[Unreleased]: ${repoBase}/compare/v${next}...HEAD`;

  const emptyTemplate = `## [Unreleased]\n\n### Added\n<!-- 日常开发把条目写在这里（- 开头一行一条），发版时自动归档；注释行不计入归档 -->\n`;
  const newSection = `## [${next}] - ${date}\n\n${archived}\n`;
  let out = `${log.slice(0, hi)}${emptyTemplate}\n${newSection}${rest}`;
  out = out.replace(/\[Unreleased\]:\s*\S+/, newUnreleasedLink);
  if (!out.includes(linkDef)) out = `${out.trimEnd()}\n${linkDef}\n`;

  const newPkgRaw = pkgRaw.replace(/"version":\s*"[^"]+"/, `"version": "${next}"`);

  if (dryRun) {
    console.log(`[dry-run] ${pkg.version} -> ${next} (${mode}, ${date})`);
    console.log(`[dry-run] 将写入 CHANGELOG 新小节:\n${newSection}`);
    return;
  }

  fs.writeFileSync(PKG, newPkgRaw.endsWith("\n") ? newPkgRaw : newPkgRaw + "\n");
  fs.writeFileSync(CHANGELOG, out);
  console.log(`已发版 ${pkg.version} -> ${next}（package.json + CHANGELOG 已同步）`);
  console.log(`后续：git add package.json CHANGELOG.md && git commit -m "chore(release): v${next}" && git tag v${next}`);
}

try {
  main();
} catch (err) {
  console.error(`发版失败: ${(err as Error).message}`);
  process.exit(1);
}
