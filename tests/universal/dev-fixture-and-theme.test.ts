import { describe, it, expect } from "vitest";
import lightTheme from "@shikijs/themes/github-light-high-contrast";
import { patchLightThemeComments, LIGHT_COMMENT_COLOR } from "../../src/components/magicui/code-comparison";
import { buildConversationFixture, FIXTURE_SESSION_ID } from "../../src/dev/conversation-fixture";
import { badgeVariants } from "../../src/components/ui/badge";

describe("light diff comment contrast", () => {
  it("swaps only the comment token colour in github-light-high-contrast", () => {
    const src: any = (lightTheme as any).default ?? lightTheme;
    const patched = patchLightThemeComments(src);
    const comment = patched.tokenColors.find((t: any) => [].concat(t.scope).includes("comment" as never));
    expect(comment.settings.foreground).toBe(LIGHT_COMMENT_COLOR);
    // 原主题对象不被改写，其余 token 原样保留
    const orig = src.tokenColors.find((t: any) => [].concat(t.scope).includes("comment" as never));
    expect(orig.settings.foreground.toLowerCase()).toBe("#66707b");
    expect(patched.tokenColors.length).toBe(src.tokenColors.length);
  });
});

describe("untracked badge", () => {
  it("neutral variant does not use the warning/amber tokens", () => {
    const cls = badgeVariants({ variant: "neutral" });
    expect(cls).not.toMatch(/warning|signal/);
    expect(cls).toContain("text-muted-foreground");
  });
});

describe("dev conversation fixture", () => {
  it("covers user/assistant, streaming turn, plan, tools, usage and an inline permission", () => {
    const fx = buildConversationFixture({ now: 1_760_000_000_000 });
    expect(fx.sessionId).toBe(FIXTURE_SESSION_ID);
    expect(fx.messages.some((m) => m.role === "user")).toBe(true);
    const streaming = fx.messages.find((m) => m.isStreaming);
    expect(streaming?.thought).toBeTruthy();
    expect(streaming?.plan?.some((p) => p.status === "in_progress")).toBe(true);
    expect(fx.messages.flatMap((m) => m.toolCalls || []).length).toBeGreaterThanOrEqual(5);
    expect(fx.usage.used).toBeGreaterThan(0);
    expect(fx.pendingPerms).toHaveLength(1);
    expect(fx.pendingPerms[0].permissionId).toBeTruthy();
    expect(fx.pendingPerms[0].options?.length).toBeGreaterThan(0);
  });

  it("approval mode adds a second permission for the global approval flow", () => {
    const fx = buildConversationFixture({ globalPermission: true });
    expect(fx.pendingPerms).toHaveLength(2);
    expect(fx.pendingPerms[1].toolCall?.title).toBeTruthy();
  });
});

describe("theme switch animation gate", () => {
  it("falls back to an instant switch without View Transitions or with reduced motion", async () => {
    const { canAnimateThemeSwitch } = await import("../../src/stores/useThemeStore");
    const win = (reduce: boolean) => ({ matchMedia: () => ({ matches: reduce }) }) as unknown as Window;
    expect(canAnimateThemeSwitch({} as Document, win(false))).toBe(false);
    const doc = { startViewTransition: () => {} } as unknown as Document;
    expect(canAnimateThemeSwitch(doc, win(false))).toBe(true);
    expect(canAnimateThemeSwitch(doc, win(true))).toBe(false);
  });
});
