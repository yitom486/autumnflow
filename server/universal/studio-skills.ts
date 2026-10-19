import * as fs from "node:fs";
import * as path from "node:path";
import { getStudioResourcesDir } from "./studio-resource-path";
import { fileURLToPath } from "node:url";

export interface StudioSkill {
  name: string;
  title: string;
  description: string;
  content: string;
  path: string;
}

/**
 * Returns the resolved directory where Studio built-in skills reside.
 * Can be overridden via AUTUMNFLOW_SKILLS_DIR environment variable.
 */
export function getStudioSkillsDir(): string {
  if (process.env.AUTUMNFLOW_SKILLS_DIR) {
    return path.resolve(process.env.AUTUMNFLOW_SKILLS_DIR);
  }
  const configured = path.join(getStudioResourcesDir(), "skills");
  return fs.existsSync(configured) ? configured : getBundledStudioSkillsDir();
}

export function getBundledStudioSkillsDir(): string {
  const directory = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(directory, "skills");
}

/**
 * Discovers and lists all built-in Studio skills with summary metadata.
 */
export function listStudioSkills(): Array<{ name: string; title: string; description: string }> {
  const dir = getStudioSkillsDir();
  if (!fs.existsSync(dir)) return [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const skills: Array<{ name: string; title: string; description: string }> = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillFile = path.join(dir, entry.name, "SKILL.md");
        if (fs.existsSync(skillFile)) {
          const raw = fs.readFileSync(skillFile, "utf-8");
          const meta = parseSkillFrontmatter(raw, entry.name);
          skills.push({
            name: entry.name,
            title: meta.title,
            description: meta.description,
          });
        }
      }
    }
    return skills;
  } catch (err) {
    console.error(`[StudioSkills] listStudioSkills failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Loads a specific skill by name on demand.
 */
export function getStudioSkill(name: string): StudioSkill | null {
  const cleanName = path.basename(name).trim();
  if (!cleanName) return null;

  const dir = getStudioSkillsDir();
  const skillFile = path.join(dir, cleanName, "SKILL.md");
  if (!fs.existsSync(skillFile)) return null;

  try {
    const content = fs.readFileSync(skillFile, "utf-8");
    const meta = parseSkillFrontmatter(content, cleanName);
    return {
      name: cleanName,
      title: meta.title,
      description: meta.description,
      content,
      path: skillFile,
    };
  } catch (err) {
    console.error(`[StudioSkills] getStudioSkill failed for ${cleanName}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Simple parser for YAML-like frontmatter or markdown titles.
 */
function parseSkillFrontmatter(
  content: string,
  fallbackName: string
): { title: string; description: string } {
  let title = fallbackName;
  let description = "";

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match) {
    const yaml = match[1];
    const descMatch = yaml.match(/description:\s*(.+)/);
    if (descMatch) description = descMatch[1].trim();
    const titleMatch = yaml.match(/title:\s*(.+)/);
    if (titleMatch) title = titleMatch[1].trim();
  }

  if (!description) {
    const h1 = content.match(/^#\s+(.+)$/m);
    if (h1) title = h1[1].trim();
    const p = content.match(/^(?!#|---)(.+)$/m);
    if (p) description = p[1].trim().slice(0, 150);
  }

  return { title, description };
}
