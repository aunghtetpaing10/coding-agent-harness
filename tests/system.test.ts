import { describe, expect, it } from "vitest";

import { buildSystemPrompt, type PromptContext } from "../src/system.js";

const baseContext: PromptContext = {
  workingDirectory: "/workspace",
  sandboxType: "in-memory test sandbox",
  toolNames: ["readFile", "grep", "bash"],
};

describe("buildSystemPrompt", () => {
  it("constructs deterministic runtime-aware sections", () => {
    const first = buildSystemPrompt(baseContext);
    const second = buildSystemPrompt(baseContext);

    expect(first).toBe(second);
    expect(first).toContain("working in /workspace");
    expect(first).toContain("Sandbox: in-memory test sandbox");
    expect(first).toContain("Available tools: readFile, grep, bash");
    expect(first).toContain("# Agency");
    expect(first).toContain("# Guardrails");
    expect(first).toContain("# Verification");
  });

  it("includes optional runtime context only when supplied", () => {
    const withoutOptionalContext = buildSystemPrompt(baseContext);
    const withOptionalContext = buildSystemPrompt({
      ...baseContext,
      gitBranch: "main",
      projectContext: "Always use exact edits.",
      verificationHint: "Run js-exec check.js.",
    });

    expect(withoutOptionalContext).not.toContain("Current git branch:");
    expect(withoutOptionalContext).not.toContain("Project Instructions");
    expect(withOptionalContext).toContain("Current git branch: main");
    expect(withOptionalContext).toContain("# Project Instructions (from AGENTS.md)");
    expect(withOptionalContext).toContain("Always use exact edits.");
    expect(withOptionalContext).toContain("Run js-exec check.js.");
  });

  it("requires evidence-backed, scoped verification claims", () => {
    const prompt = buildSystemPrompt(baseContext);

    expect(prompt).toContain("Do NOT claim that tests pass");
    expect(prompt).toContain("passed, failed, blocked, and unavailable");
    expect(prompt).toContain("successful tool result");
    expect(prompt).toContain("Scope the final claim");
  });

  it("instructs the agent to ask structured questions for material ambiguity", () => {
    const prompt = buildSystemPrompt({
      ...baseContext,
      toolNames: [...baseContext.toolNames, "askUser"],
    });

    expect(prompt).toContain("# Handling Ambiguity");
    expect(prompt).toContain("Search the workspace");
    expect(prompt).toContain("Use askUser");
    expect(prompt).toContain("Do not guess");
    expect(prompt).toContain("Do not use askUser for specific tasks");
  });
});
