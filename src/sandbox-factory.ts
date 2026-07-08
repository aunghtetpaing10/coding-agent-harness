import { createJustBashSandbox } from "./sandbox-just-bash.js";
import type { Sandbox } from "./sandbox.js";

export async function createSandboxByType(
  type = process.env.SANDBOX ?? "just-bash",
): Promise<Sandbox> {
  if (type === "just-bash") {
    return createJustBashSandbox();
  }

  throw new Error(
    `Unsupported sandbox type: ${type}. Available types: just-bash.`,
  );
}
