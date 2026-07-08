import { describe, expect, it } from "vitest";

import { createJustBashSandbox } from "../src/sandbox-just-bash.js";
import { createCodingTools } from "../src/tools.js";
import { RunTrace } from "../src/trace.js";

describe("coding tool descriptions", () => {
  it("gives every tool the full five-section routing contract", async () => {
    const tools = createCodingTools(await createJustBashSandbox(), new RunTrace(), {
      maximumReadCharacters: 4_000,
    });

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
});
