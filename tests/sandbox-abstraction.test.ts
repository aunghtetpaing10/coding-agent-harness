import { describe, expect, it } from "vitest";

import { createSandboxByType } from "../src/sandbox-factory.js";
import type { Sandbox } from "../src/sandbox.js";

describe("Sandbox abstraction", () => {
  it("creates a just-bash backend through the factory", async () => {
    const sandbox: Sandbox = await createSandboxByType("just-bash");

    expect(sandbox.type).toBe("just-bash");
    expect(sandbox.workingDirectory).toBe("/workspace");
    expect(await sandbox.fileExists("/workspace/math.js")).toBe(true);
    await expect(sandbox.readFile("/workspace/math.js")).resolves.toContain(
      "function clamp",
    );
    await sandbox.stop();
  });

  it("keeps writes inside the selected backend", async () => {
    const sandbox = await createSandboxByType("just-bash");

    await sandbox.writeFile("/workspace/scratch.txt", "temporary");

    expect(await sandbox.fileExists("/workspace/scratch.txt")).toBe(true);
    expect(await sandbox.readFile("/workspace/scratch.txt")).toBe("temporary");
    await sandbox.stop();
  });

  it("rejects an unknown backend explicitly", async () => {
    await expect(createSandboxByType("cloud")).rejects.toThrow(
      "Unsupported sandbox type: cloud",
    );
  });
});
