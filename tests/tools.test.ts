import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";

import { createJustBashSandbox } from "../src/sandbox-just-bash.js";
import { createAskUserTool, createCodingTools } from "../src/tools.js";
import { RunTrace } from "../src/trace.js";

const fakeModel = {} as LanguageModel;

describe("coding tool descriptions", () => {
  it("gives every tool the full five-section routing contract", async () => {
    const tools = createCodingTools(
      await createJustBashSandbox(),
      new RunTrace(),
      {
        maximumReadCharacters: 4_000,
        subagents: {
          explorerModel: fakeModel,
          executorModel: fakeModel,
        },
      },
    );

    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.description, `${name} summary`).toBeTruthy();
      expect(tool.description, `${name} WHEN TO USE`).toContain("WHEN TO USE:");
      expect(tool.description, `${name} WHEN NOT TO USE`).toContain(
        "WHEN NOT TO USE:",
      );
      expect(tool.description, `${name} DO NOT USE FOR`).toContain(
        "DO NOT USE FOR:",
      );
      expect(tool.description, `${name} USAGE`).toContain("USAGE:");
      expect(tool.description, `${name} EXAMPLES`).toContain("EXAMPLES:");
    }
  });

  it("adds task only when subagent models are supplied", async () => {
    const sandbox = await createJustBashSandbox();

    const withoutSubagents = createCodingTools(sandbox, new RunTrace());
    const withSubagents = createCodingTools(sandbox, new RunTrace(), {
      subagents: {
        explorerModel: fakeModel,
        executorModel: fakeModel,
      },
    });

    expect(Object.keys(withoutSubagents)).not.toContain("task");
    expect(Object.keys(withoutSubagents)).toContain("askUser");
    expect(Object.keys(withSubagents)).toContain("task");
    expect(Object.keys(withSubagents)).toContain("askUser");
  });

  it("documents explorer and executor delegation boundaries", async () => {
    const tools = createCodingTools(
      await createJustBashSandbox(),
      new RunTrace(),
      {
        subagents: {
          explorerModel: fakeModel,
          executorModel: fakeModel,
        },
      },
    );
    const task = (tools as Record<string, { description?: string }>).task;

    expect(task?.description).toContain("Explorer (default): read-only");
    expect(task?.description).toContain("readFile, grep, and read-only bash");
    expect(task?.description).toContain("Executor: focused implementation");
    expect(task?.description).toContain("writeFile, edit, and bash");
    expect(task?.description).toContain("ambiguous requirements");
  });

  it("documents askUser as a structured question tool", () => {
    const askUser = createAskUserTool(new RunTrace());

    expect(askUser.description).toContain("multiple-choice question");
    expect(askUser.description).toContain("2 to 4");
    expect(askUser.description).toContain("WHEN TO USE:");
    expect(askUser.description).toContain("WHEN NOT TO USE:");
    expect(askUser.description).toContain("DO NOT USE FOR:");
    expect(askUser.description).toContain("USAGE:");
    expect(askUser.description).toContain("EXAMPLES:");
  });

  it("returns the selected user answer from askUser", async () => {
    const askUser = createAskUserTool(new RunTrace(), async () => ({
      status: "answered",
      optionIndex: 1,
      answer: "JWT bearer tokens",
    }));

    const result = await askUser.execute(
      {
        question: "Which auth strategy?",
        options: ["Session cookies", "JWT bearer tokens"],
      },
      {
        toolCallId: "test-call",
        messages: [],
        context: {},
      },
    );

    expect(result).toContain("User answered option 2");
    expect(result).toContain("JWT bearer tokens");
  });

  it("handles broad explorer workspace scans deterministically", async () => {
    const tools = createCodingTools(
      await createJustBashSandbox(),
      new RunTrace(),
      {
        subagents: {
          explorerModel: fakeModel,
          executorModel: fakeModel,
        },
      },
    );
    const task = (tools as Record<string, { execute: Function }>).task;
    expect(task).toBeDefined();

    const result = await task!.execute(
      {
        subagentType: "explorer",
        description:
          "Explore the workspace structure. List all files and read all source files.",
      },
      {
        toolCallId: "test-call",
        messages: [],
        context: {},
      },
    );

    expect(result).toContain("deterministic workspace summary");
    expect(result).toContain("/workspace/AGENTS.md");
    expect(result).toContain("/workspace/calculator.js");
    expect(result).toContain("self-contained JavaScript fixtures");
  });

  it("handles auth fixture executor tasks deterministically", async () => {
    const sandbox = await createJustBashSandbox();
    const tools = createCodingTools(sandbox, new RunTrace(), {
      subagents: {
        explorerModel: fakeModel,
        executorModel: fakeModel,
      },
    });
    const task = (tools as Record<string, { execute: Function }>).task;
    expect(task).toBeDefined();

    const result = await task!.execute(
      {
        subagentType: "executor",
        description:
          "Create /workspace/auth.js as a self-contained authentication fixture, then run js-exec /workspace/auth.js.",
      },
      {
        toolCallId: "test-call",
        messages: [],
        context: {},
      },
    );

    expect(result).toContain("deterministic auth fixture");
    expect(result).toContain("exitCode: 0");
    await expect(sandbox.readFile("/workspace/auth.js")).resolves.toContain(
      "function authenticate",
    );
  });
});
