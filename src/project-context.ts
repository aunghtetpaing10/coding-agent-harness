import { posix } from "node:path";

import type { Bash } from "just-bash";

const MAXIMUM_PROJECT_CONTEXT_CHARACTERS = 8_000;

export async function loadProjectContext(
  sandbox: Bash,
  workingDirectory = "/workspace",
): Promise<string | undefined> {
  const path = posix.join(workingDirectory, "AGENTS.md");
  if (!(await sandbox.fs.exists(path))) {
    return undefined;
  }

  const content = (await sandbox.readFile(path)).trim();
  if (!content) {
    return undefined;
  }

  if (content.length <= MAXIMUM_PROJECT_CONTEXT_CHARACTERS) {
    return content;
  }

  return `${content.slice(0, MAXIMUM_PROJECT_CONTEXT_CHARACTERS)}\n\n[AGENTS.md truncated by harness]`;
}
