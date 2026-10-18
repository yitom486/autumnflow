// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { staticCacheControl, staticFileResponse } from "../../server/static-files";
import { buildApp, shutdownBridges } from "../../server/gateway";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-static-"));
const previousDir = process.env.ACP_PUBLIC_DIR;
const app = buildApp();
beforeAll(() => {
  process.env.ACP_PUBLIC_DIR = root;
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "assets", "app-Abc12_-Z.js"), "console.log('cached')");
  fs.writeFileSync(path.join(root, "index.html"), "<html>current shell</html>");
  fs.writeFileSync(path.join(root, "config.json"), "{}");
});
afterAll(async () => {
  if (previousDir === undefined) delete process.env.ACP_PUBLIC_DIR;
  else process.env.ACP_PUBLIC_DIR = previousDir;
  await shutdownBridges();
  fs.rmSync(root, { recursive: true, force: true });
});
const request = (url: string, headers?: HeadersInit) => new Request(`http://127.0.0.1${url}`, { headers });

describe("static cache policy", () => {
  it("only gives Vite content-hashed assets a long freshness lifetime", () => {
    expect(staticCacheControl("assets/app-Abc12_-Z.js")).toContain("immutable");
    expect(staticCacheControl("assets\\font-12345678.woff2")).toContain("immutable");
    for (const file of ["index.html", "assets/app.js", "config.json", "app-12345678.js"]) {
      expect(staticCacheControl(file)).toBe("no-cache");
    }
  });
  it("sets the HttpOnly desktop session cookie on HTML responses only", async () => {
    const page = await app.fetch(request("/"));
    const cookie = page.headers.get("Set-Cookie") || "";
    expect(cookie).toContain("acp_gateway_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(page.headers.get("Set-Cookie")).not.toBeNull();
    const asset = await app.fetch(request("/assets/app-Abc12_-Z.js"));
    expect(asset.headers.get("Set-Cookie")).toBeNull();
  });

  it("sends the asset once and returns an empty 304 for matching validators through the gateway", async () => {
    const first = await app.fetch(request("/assets/app-Abc12_-Z.js"));
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(first.headers.get("Content-Type")).toContain("javascript");
    expect(await first.text()).toContain("cached");
    const tag = first.headers.get("ETag")!;
    for (const condition of [tag, tag.replace(/^W\//, ""), `"older", ${tag}`, "*"]) {
      const cached = await app.fetch(request("/assets/app-Abc12_-Z.js", { "If-None-Match": condition }));
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe("");
      expect(cached.headers.get("ETag")).toBe(tag);
    }
  });
  it("keeps HTML and SPA routes revalidated and detects content changes", async () => {
    const first = await app.fetch(request("/chat/example"));
    expect(first.headers.get("Cache-Control")).toBe("no-cache");
    const tag = first.headers.get("ETag")!;
    expect((await app.fetch(request("/chat/example", { "If-None-Match": tag }))).status).toBe(304);
    fs.writeFileSync(path.join(root, "index.html"), "<html>new deployed application shell</html>");
    const updated = await app.fetch(request("/chat/example", { "If-None-Match": tag }));
    expect(updated.status).toBe(200);
    expect(updated.headers.get("ETag")).not.toBe(tag);
    expect(await updated.text()).toContain("new deployed");
    expect((await app.fetch(request("/config.json"))).headers.get("Cache-Control")).toBe("no-cache");
  });
  it("uses modification dates only when no ETag condition is supplied", () => {
    const file = path.join(root, "config.json");
    const first = staticFileResponse(request("/config.json"), file, "config.json", "application/json");
    const since = first.headers.get("Last-Modified")!;
    expect(staticFileResponse(request("/config.json", { "If-Modified-Since": since }), file, "config.json", "application/json").status).toBe(304);
    expect(staticFileResponse(request("/config.json", { "If-Modified-Since": since, "If-None-Match": '"different"' }), file, "config.json", "application/json").status).toBe(200);
    expect(staticFileResponse(request("/config.json", { "If-Modified-Since": "invalid" }), file, "config.json", "application/json").status).toBe(200);
  });
  it("serves HEAD metadata without a body", async () => {
    const res = await app.fetch(new Request("http://127.0.0.1/assets/app-Abc12_-Z.js", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(await res.text()).toBe("");
  });
});
