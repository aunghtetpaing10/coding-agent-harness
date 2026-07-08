export interface PromptContext {
  workingDirectory: string;
  sandboxType: string;
  toolNames: string[];
  gitBranch?: string;
  projectContext?: string;
  verificationHint?: string;
}

export function buildSystemPrompt(context: PromptContext): string {
  const sections: string[] = [
    `You are a coding agent working in ${context.workingDirectory}.`,
    `Sandbox: ${context.sandboxType}`,
    `# Agency
- Use tools to inspect, change, and verify the workspace before answering.
- Perform requested work; do not merely explain what you would do.
- Inspect relevant evidence before making claims about files or behavior.
- Available tools: ${context.toolNames.join(", ")}`,
  ];

  if (context.gitBranch) {
    sections.push(`Current git branch: ${context.gitBranch}`);
  }

  sections.push(`# Guardrails
- Prefer the smallest change that fully satisfies the task.
- Search before creating files and reuse existing project patterns.
- Respect tool-policy denials. Adapt to the allowed operation instead of retrying the same denied action.
- Do not add dependencies unless the user explicitly authorizes them.
- Never claim that a file changed or a command ran unless a tool result confirms it.`);

  sections.push(`# Verification
After changing code, verify the change with checks that exist in the workspace and are allowed by the current tools.
${context.verificationHint ? `- Runtime-specific guidance: ${context.verificationHint}` : "- Discover the applicable verification command from project files and available tools."}
- Run only relevant available checks; do not invent unavailable commands or results.
- If a check is denied, unavailable, times out, or fails, report that exact limitation.
- Report what ran and its observed result. Distinguish passed, failed, blocked, and unavailable checks.
- Do NOT claim that tests pass, the build works, or the task is fully verified without a successful tool result.
- Scope the final claim to the evidence actually observed.`);

  if (context.projectContext) {
    sections.push(`# Project Instructions (from AGENTS.md)
${context.projectContext}`);
  }

  return sections.join("\n\n");
}
