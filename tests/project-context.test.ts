import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";

import { loadProjectContext } from "../src/project-context.js";
import { createSandbox } from "../src/sandbox.js";

describe("loadProjectContext", () => {
  it("loads AGENTS.md from the sandbox working directory", async () => {
    const context = await loadProjectContext(createSandbox());

    expect(context).toContain("Project codename: Pocket Harness");
    expect(context).toContain("js-exec /workspace/<file>.js");
  });

  it("returns undefined when AGENTS.md is absent", async () => {
    const sandbox = new Bash({ cwd: "/workspace", files: {} });

    await expect(loadProjectContext(sandbox)).resolves.toBeUndefined();
  });

  it("omits an empty AGENTS.md", async () => {
    const sandbox = new Bash({
      cwd: "/workspace",
      files: { "/workspace/AGENTS.md": "  \n" },
    });

    await expect(loadProjectContext(sandbox)).resolves.toBeUndefined();
  });
});
