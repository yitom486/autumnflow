import * as path from "node:path";
import { resolveAppHome } from "./app-paths";

/** Application-owned source configuration; never an agent's authentication home. */
export function getStudioResourcesDir(): string {
  const directory = process.env.AUTUMNFLOW_RESOURCES_DIR;
  if (directory && !path.isAbsolute(directory)) {
    throw new Error("AUTUMNFLOW_RESOURCES_DIR must be absolute");
  }
  return directory || path.join(resolveAppHome(), "resources");
}
