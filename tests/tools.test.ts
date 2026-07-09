import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";

import { createJustBashSandbox } from "../src/sandbox-just-bash.js";
import { createCodingTools } from "../src/tools.js";
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
    expect(Object.keys(withSubagents)).toContain("task");
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
    expect(task?.description).toContain("readFile and grep only");
    expect(task?.description).toContain("Executor: focused implementation");
    expect(task?.description).toContain("writeFile, edit, and bash");
    expect(task?.description).toContain("ambiguous requirements");
  });
});
