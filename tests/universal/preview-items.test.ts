import { describe, expect, it } from "vitest";
import {
  buildPreviewRailItems,
  PREVIEW_DESCRIPTION_MAX,
  PREVIEW_LABEL_MAX,
  type PreviewMessageInput,
} from "@/components/primitives/preview-items";

function conversation(turns: number): PreviewMessageInput[] {
  const messages: PreviewMessageInput[] = [];
  for (let index = 0; index < turns; index++) {
    messages.push({ id: `u${index}`, from: "user", text: `问题 ${index}` });
    messages.push({ id: `a${index}`, from: "assistant", text: `回答 ${index}` });
  }
  return messages;
}

describe("preview rail items", () => {
  it("pairs a question with the answers that follow it", () => {
    const items = buildPreviewRailItems([
      { id: "u1", from: "user", text: "怎么修？" },
      { id: "a1", from: "assistant", text: "第一步" },
      { id: "a2", from: "assistant", text: "第二步" },
      { id: "u2", from: "user", text: "还有呢？" },
      { id: "a3", from: "assistant", text: "第三步" },
    ]);
    expect(items.map((item) => item.id)).toEqual(["u1", "a1", "a2", "u2", "a3"]);
    expect(items[0].label).toBe("怎么修？");
    expect(items[0].description).toBe("第一步 第二步");
    expect(items[3].description).toBe("第三步");
    expect(items[1].description).toBe("第一步");
  });

  it("keeps only user messages when the rail is scoped to questions", () => {
    const items = buildPreviewRailItems(conversation(3), "user");
    expect(items.map((item) => item.id)).toEqual(["u0", "u1", "u2"]);
    expect(items[0].description).toBe("回答 0");
  });

  it("labels system and assistant messages without stealing their text", () => {
    const items = buildPreviewRailItems([
      { id: "s1", from: "system", text: "系统提示" },
      { id: "a1", from: "assistant", text: "智能体回答" },
    ]);
    expect(items[0].label).toBe("系统消息");
    expect(items[0].description).toBe("系统提示");
    expect(items[1].label).toBe("智能体回复");
    expect(items[1].description).toBe("智能体回答");
  });

  it("falls back for empty bodies", () => {
    const items = buildPreviewRailItems([
      { id: "u1", from: "user", text: "" },
      { id: "a1", from: "assistant", text: "" },
    ]);
    expect(items[0].label).toBe("（附件消息）");
    expect(items[0].description).toBe("暂无回答");
    expect(items[1].description).toBe("（空消息）");
  });

  it("scales linearly with the conversation length", () => {
    // The previous implementation looked the message index up with `indexOf`
    // inside a `map` and re-read every body twice, so a long chat rescanned
    // quadratically while a response streamed.
    const messages = conversation(400);
    const started = Date.now();
    const items = buildPreviewRailItems(messages, "all");
    const elapsed = Date.now() - started;
    expect(items).toHaveLength(messages.length);
    expect(elapsed).toBeLessThan(200);
  });

  it("caps the answer text so one huge reply cannot dominate the card", () => {
    const items = buildPreviewRailItems([
      { id: "u1", from: "user", text: "问题" },
      { id: "a1", from: "assistant", text: "答".repeat(PREVIEW_DESCRIPTION_MAX + 500) },
    ]);
    expect((items[0].description as string).length).toBeLessThanOrEqual(PREVIEW_DESCRIPTION_MAX);
    expect(PREVIEW_LABEL_MAX).toBeLessThan(PREVIEW_DESCRIPTION_MAX);
  });
});
