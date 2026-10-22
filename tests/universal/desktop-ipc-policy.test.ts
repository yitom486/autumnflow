import { describe, expect, it } from "vitest";
import { isTrustedSenderUrl } from "../../desktop/sender-policy";

const APP = "http://127.0.0.1:25005/";

describe("desktop IPC sender policy", () => {
  it("accepts only the exact app origin", () => {
    expect(isTrustedSenderUrl("http://127.0.0.1:25005/", APP)).toBe(true);
    expect(isTrustedSenderUrl("http://127.0.0.1:25005/?cwd=D:/x", APP)).toBe(true);
    expect(isTrustedSenderUrl("http://127.0.0.1:25006/", APP)).toBe(false);
    expect(isTrustedSenderUrl("http://localhost:25005/", APP)).toBe(false);
    expect(isTrustedSenderUrl("file:///C:/evil/index.html", APP)).toBe(false);
    expect(isTrustedSenderUrl("about:blank", APP)).toBe(false);
    expect(isTrustedSenderUrl(undefined, APP)).toBe(false);
    expect(isTrustedSenderUrl("not a url", APP)).toBe(false);
  });

  it("tracks the configured dev origin", () => {
    expect(isTrustedSenderUrl("http://localhost:25188/", "http://localhost:25188")).toBe(true);
    expect(isTrustedSenderUrl("http://127.0.0.1:25188/", "http://localhost:25188")).toBe(false);
  });
});
