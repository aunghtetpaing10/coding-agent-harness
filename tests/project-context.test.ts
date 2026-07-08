import { describe, expect, it } from "vitest";

import { loadProjectContext } from "../src/project-context.js";
import { createJustBashSandbox } from "../src/sandbox-just-bash.js";
import type { Sandbox } from "../src/sandbox.js";

describe("loadProjectContext", () => {
  it("loads AGENTS.md from the sandbox working directory", async () => {
    const context = await loadProjectContext(await createJustBashSandbox());

    expect(context).toContain("Project codename: Pocket Harness");
    expect(context).toContain("js-exec /workspace/<file>.js");
  });

  it("returns undefined when AGENTS.md is absent", async () => {
    await expect(
      loadProjectContext(createContextSandbox(undefined)),
    ).resolves.toBeUndefined();
  });

  it("omits an empty AGENTS.md", async () => {
    await expect(
      loadProjectContext(createContextSandbox("  \n")),
    ).resolves.toBeUndefined();
  });
});

function createContextSandbox(context: string | undefined): Sandbox {
  return {
    type: "test",
    workingDirectory: "/workspace",
    fileExists: async () => context !== undefined,
    readFile: async () => context ?? "",
    writeFile: async () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    stop: async () => {},
  };
}
