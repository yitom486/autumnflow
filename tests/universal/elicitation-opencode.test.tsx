import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ElicitationCard } from "../../src/components/universal/ElicitationCard";
import type { PendingElicitation } from "../../src/lib/universal-api";

function setInputValue(input: HTMLInputElement, value: string) {
  const proto = window.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("ElicitationCard - OpenCode & ACP Schema Option Rendering Tests", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders OpenCode questions with options and descriptions, not wiped out", async () => {
    const onRespond = vi.fn();
    const elicitation: PendingElicitation = {
      agentId: "opencode",
      sessionId: "sess-1",
      elicitationId: "elic-1",
      message: "Please choose your database",
      schema: {
        mode: "form",
        questions: [
          {
            header: "Database",
            question: "Which database backend should we initialize for the project?",
            options: [
              {
                label: "PostgreSQL (Recommended)",
                description: "Relational, ACID-compliant, robust structure.",
              },
              {
                label: "MongoDB",
                description: "Document store, flexible schema layout.",
              },
            ],
            multiple: false,
          },
        ],
      },
    };

    await act(async () => {
      root.render(<ElicitationCard e={elicitation} onRespond={onRespond} busy={false} />);
    });

    const html = container.innerHTML;
    // Verify question header & prompt are displayed
    expect(html).toContain("Database");
    expect(html).toContain("Which database backend should we initialize for the project?");
    // Verify options AND descriptions are fully rendered, NOT wiped out!
    expect(html).toContain("PostgreSQL (Recommended)");
    expect(html).toContain("Relational, ACID-compliant, robust structure.");
    expect(html).toContain("MongoDB");
    expect(html).toContain("Document store, flexible schema layout.");

    // Click the first option
    const optionBtns = container.querySelectorAll("button[data-menu-row]");
    expect(optionBtns.length).toBe(2);

    await act(async () => {
      (optionBtns[0] as HTMLButtonElement).click();
    });

    // Wait for auto-advance timer or click send button
    await new Promise((r) => setTimeout(r, 600));

    expect(onRespond).toHaveBeenCalledWith(
      elicitation,
      true,
      expect.objectContaining({
        answers: [["PostgreSQL (Recommended)"]],
        Database: "PostgreSQL (Recommended)",
      })
    );
  });

  it("renders OpenCode questions nested inside requestedSchema.questions", async () => {
    const onRespond = vi.fn();
    const elicitation: PendingElicitation = {
      agentId: "opencode",
      sessionId: "sess-1",
      elicitationId: "elic-2",
      message: "Architecture Choice",
      schema: {
        requestedSchema: {
          questions: [
            {
              header: "CSS Framework",
              question: "Select styling library",
              options: [
                { label: "Tailwind CSS", description: "Utility-first CSS framework" },
                { label: "CSS Modules", description: "Scoped component styling" },
              ],
              multiple: false,
            },
          ],
        },
      },
    };

    await act(async () => {
      root.render(<ElicitationCard e={elicitation} onRespond={onRespond} busy={false} />);
    });

    expect(container.innerHTML).toContain("CSS Framework");
    expect(container.innerHTML).toContain("Tailwind CSS");
    expect(container.innerHTML).toContain("Utility-first CSS framework");
    expect(container.innerHTML).toContain("CSS Modules");
  });

  it("renders ACP JSON Schema with oneOf options properly", async () => {
    const onRespond = vi.fn();
    const elicitation: PendingElicitation = {
      agentId: "codex",
      sessionId: "sess-1",
      elicitationId: "elic-3",
      message: "Select target framework",
      schema: {
        requestedSchema: {
          type: "object",
          title: "Project Configuration",
          properties: {
            framework: {
              type: "string",
              title: "Frontend Framework",
              description: "Choose the view layer",
              oneOf: [
                { const: "react", title: "React 19", description: "Modern React with Hooks" },
                { const: "vue", title: "Vue 3", description: "Progressive JavaScript framework" },
              ],
            },
          },
          required: ["framework"],
        },
      },
    };

    await act(async () => {
      root.render(<ElicitationCard e={elicitation} onRespond={onRespond} busy={false} />);
    });

    const html = container.innerHTML;
    expect(html).toContain("Frontend Framework");
    expect(html).toContain("React 19");
    expect(html).toContain("Modern React with Hooks");
    expect(html).toContain("Vue 3");

    // Click React 19 option
    const optionBtns = container.querySelectorAll("button[data-menu-row]");
    expect(optionBtns.length).toBe(2);

    await act(async () => {
      (optionBtns[0] as HTMLButtonElement).click();
    });

    await new Promise((r) => setTimeout(r, 600));

    expect(onRespond).toHaveBeenCalledWith(
      elicitation,
      true,
      expect.objectContaining({
        framework: "react",
      })
    );
  });

  it("supports custom text input for OpenCode elicitation question", async () => {
    const onRespond = vi.fn();
    const elicitation: PendingElicitation = {
      agentId: "opencode",
      sessionId: "sess-1",
      elicitationId: "elic-4",
      schema: {
        questions: [
          {
            header: "Custom Port",
            question: "Specify port number or keep default",
            options: [{ label: "3000 (Default)" }, { label: "8080" }],
          },
        ],
      },
    };

    await act(async () => {
      root.render(<ElicitationCard e={elicitation} onRespond={onRespond} busy={false} />);
    });

    const input = container.querySelector("input[aria-label='自定义补充']") as HTMLInputElement;
    expect(input).not.toBeNull();

    await act(async () => {
      setInputValue(input, "9999");
    });

    // Advance by clicking continue / send
    const sendBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("确认提交") || b.textContent?.includes("继续")
    );
    expect(sendBtn).toBeDefined();

    await act(async () => {
      sendBtn?.click();
    });

    expect(onRespond).toHaveBeenCalledWith(
      elicitation,
      true,
      expect.objectContaining({
        answers: [["9999"]],
        "Custom Port": "9999",
      })
    );
  });

  it("handles multi-select (multiple: true) OpenCode questions", async () => {
    const onRespond = vi.fn();
    const elicitation: PendingElicitation = {
      agentId: "opencode",
      sessionId: "sess-1",
      elicitationId: "elic-5",
      schema: {
        questions: [
          {
            header: "Features",
            question: "Select project features",
            options: [
              { label: "ESLint", description: "Linter" },
              { label: "Prettier", description: "Formatter" },
              { label: "Vitest", description: "Unit test runner" },
            ],
            multiple: true,
          },
        ],
      },
    };

    await act(async () => {
      root.render(<ElicitationCard e={elicitation} onRespond={onRespond} busy={false} />);
    });

    const optionBtns = container.querySelectorAll("button[data-menu-row]");
    expect(optionBtns.length).toBe(3);

    // Select ESLint and Vitest
    await act(async () => {
      (optionBtns[0] as HTMLButtonElement).click();
      (optionBtns[2] as HTMLButtonElement).click();
    });

    const sendBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("确认提交") || b.textContent?.includes("继续")
    );
    expect(sendBtn).toBeDefined();

    await act(async () => {
      sendBtn?.click();
    });

    expect(onRespond).toHaveBeenCalledWith(
      elicitation,
      true,
      expect.objectContaining({
        answers: [["ESLint", "Vitest"]],
        Features: ["ESLint", "Vitest"],
      })
    );
  });

  it("renders and submits JSON Schema array with items.enum", async () => {
    const onRespond = vi.fn();
    const elicitation: PendingElicitation = {
      agentId: "claude",
      sessionId: "sess-1",
      elicitationId: "elic-6",
      schema: {
        requestedSchema: {
          type: "object",
          properties: {
            plugins: {
              type: "array",
              title: "Active Plugins",
              items: {
                type: "string",
                enum: ["git-integration", "linter-hub", "docker-runner"],
              },
            },
          },
        },
      },
    };

    await act(async () => {
      root.render(<ElicitationCard e={elicitation} onRespond={onRespond} busy={false} />);
    });

    expect(container.innerHTML).toContain("Active Plugins");
    expect(container.innerHTML).toContain("git-integration");
    expect(container.innerHTML).toContain("docker-runner");

    const optionBtns = container.querySelectorAll("button[data-menu-row]");
    expect(optionBtns.length).toBe(3);

    // Select git-integration and docker-runner
    await act(async () => {
      (optionBtns[0] as HTMLButtonElement).click();
      (optionBtns[2] as HTMLButtonElement).click();
    });

    const sendBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("确认提交") || b.textContent?.includes("继续")
    );
    await act(async () => {
      sendBtn?.click();
    });

    expect(onRespond).toHaveBeenCalledWith(
      elicitation,
      true,
      expect.objectContaining({
        plugins: ["git-integration", "docker-runner"],
      })
    );
  });

  it("handles fallback confirmation mode when no schema or questions are provided", async () => {
    const onRespond = vi.fn();
    const elicitation: PendingElicitation = {
      agentId: "codex",
      sessionId: "sess-1",
      elicitationId: "elic-7",
      message: "Do you want to apply migrations to production?",
    };

    await act(async () => {
      root.render(<ElicitationCard e={elicitation} onRespond={onRespond} busy={false} />);
    });

    expect(container.innerHTML).toContain("Do you want to apply migrations to production?");
    expect(container.innerHTML).toContain("确认继续 (Continue)");
    expect(container.innerHTML).toContain("取消 / 拒绝 (Decline)");

    const optionBtns = container.querySelectorAll("button[data-menu-row]");
    expect(optionBtns.length).toBe(2);

    // Click confirm
    await act(async () => {
      (optionBtns[0] as HTMLButtonElement).click();
    });

    await new Promise((r) => setTimeout(r, 600));

    expect(onRespond).toHaveBeenCalledWith(
      elicitation,
      true,
      expect.objectContaining({
        accepted: true,
      })
    );
  });
});
