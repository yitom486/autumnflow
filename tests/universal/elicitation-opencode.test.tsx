import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { ElicitationCard } from "../../src/components/universal/ElicitationCard";
import type { PendingElicitation } from "../../src/lib/universal-api";

describe("SDK schema-driven elicitation UI", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
  async function render(schema: CreateElicitationRequest, status?: "accepted", respond = vi.fn()) {
    const e: PendingElicitation = { agentId: "opencode", sessionId: "s", elicitationId: "local-id", message: schema.message, schema, status };
    await act(async () => root.render(<ElicitationCard e={e} onRespond={respond} busy={false} />));
    return { e, respond };
  }
  const form: CreateElicitationRequest = { mode: "form", sessionId: "s", message: "请选择部署参数", requestedSchema: { type: "object", properties: {
    target: { type: "string", title: "部署环境", oneOf: [{ const: "stage", title: "预发布", description: "上线前验证" }, { const: "prod", title: "生产" }], default: "stage" },
    retries: { type: "integer", title: "重试次数", default: 3, minimum: 1, maximum: 9 },
    enabled: { type: "boolean", title: "启用", default: false },
    tags: { type: "array", title: "功能", items: { anyOf: [{ const: "logs", title: "日志", description: "记录运行信息" }, { const: "metrics", title: "指标" }] }, default: ["logs"], minItems: 1 },
  }, required: ["target", "retries", "enabled", "tags"] } };
  async function submit() { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
  async function click(text: string) { await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === text)!.click()); }
  async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
    const proto = input.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); });
  }

  it("shows defaults and descriptions and waits for explicit submission", async () => {
    const { e, respond } = await render(form);
    expect(host.textContent).toContain("opencode 请求你提供信息");
    expect(host.textContent).toContain("上线前验证");
    expect(host.textContent).toContain("记录运行信息");
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("3");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    const select = host.querySelector("select")!;
    await change(select, "prod");
    expect(respond).not.toHaveBeenCalled();
    await submit();
    expect(respond).toHaveBeenCalledExactlyOnceWith(e, { action: "accept", content: { target: "prod", retries: 3, enabled: false, tags: ["logs"] } });
  });

  it("blocks invalid values and leaves editable controls for correction", async () => {
    const { respond } = await render(form);
    const input = host.querySelector<HTMLInputElement>('input[type="number"]')!;
    await change(input, "10");
    await submit();
    expect(host.textContent).toContain("不得大于 9");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(respond).not.toHaveBeenCalled();
    await change(input, "4");
    await submit();
    expect(respond).toHaveBeenCalledOnce();
  });

  it.each([["拒绝", "decline"], ["取消", "cancel"]])("keeps %s separate from other response actions", async (label, action) => {
    const { e, respond } = await render(form);
    await click(label);
    expect(respond).toHaveBeenCalledExactlyOnceWith(e, { action });
  });

  it("opens URL only with consent and sends accept without form content", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const url: CreateElicitationRequest = { mode: "url", requestId: 1, message: "授权连接", elicitationId: "opaque", url: "https://accounts.example.org/connect" };
    const { e, respond } = await render(url);
    expect(host.textContent).toContain("accounts.example.org");
    expect(host.textContent).toContain(url.url);
    expect(open).not.toHaveBeenCalled();
    await click("同意并在浏览器中打开");
    expect(open).toHaveBeenCalledExactlyOnceWith(url.url, "_blank", "noopener,noreferrer");
    expect(respond).toHaveBeenCalledExactlyOnceWith(e, { action: "accept" });
    await render(url, "accepted");
    expect(host.textContent).toContain("等待外部流程完成");
    expect(open).toHaveBeenCalledOnce();
  });

  it("keeps a failed response visible and retryable, without losing field values", async () => {
    const respond = vi.fn().mockRejectedValueOnce(new Error("连接暂时中断")).mockResolvedValue(undefined);
    await render(form, undefined, respond);
    await submit();
    expect(host.textContent).toContain("连接暂时中断");
    await submit();
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it("prevents duplicate submissions while the response is pending", async () => {
    let finish!: () => void;
    const respond = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await render(form, undefined, respond);
    await submit(); await submit();
    expect(respond).toHaveBeenCalledOnce();
    expect(host.querySelector('button[type="submit"]')!.hasAttribute("disabled")).toBe(true);
    await act(async () => finish());
  });

  it("does not interpret private question fields as a standard ACP form", async () => {
    const { respond } = await render({ mode: "_vendor", sessionId: "s", message: "Private", questions: [{ question: "Hidden" }] });
    expect(host.textContent).toContain("无法处理此请求");
    expect(host.textContent).not.toContain("Hidden");
    await click("取消");
    expect(respond).toHaveBeenCalledOnce();
  });
});
