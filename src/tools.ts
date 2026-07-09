import { posix } from "node:path";

import { stepCountIs, ToolLoopAgent, tool } from "ai";
import type { LanguageModel, Tool, ToolSet } from "ai";
import { z } from "zod";

import type { Sandbox } from "./sandbox.js";
import type { RunTrace } from "./trace.js";

const workspacePathSchema = z.string().refine(isWorkspacePath, {
  message: "Path must resolve inside /workspace.",
});

type CodingTool = Tool<any, any>;
type DirectCodingTools = {
  readFile: CodingTool;
  grep: CodingTool;
  writeFile: CodingTool;
  edit: CodingTool;
  bash: CodingTool;
};

export function createCodingTools(
  sandbox: Sandbox,
  trace: RunTrace,
  options: {
    maximumReadCharacters?: number;
    subagents?: {
      explorerModel: LanguageModel;
      executorModel: LanguageModel;
      onResult?: (result: {
        role: "explorer" | "executor";
        task: string;
        output: string;
      }) => void | Promise<void>;
    };
  } = {},
) {
  const readLimit = options.maximumReadCharacters;
  const readFile = tool({
    description: `Read one UTF-8 file from the virtual workspace. Returns the path, content, truncation status, and original character count.

WHEN TO USE: inspecting a known source file, configuration, test, or log; checking exact code before editing; rereading a file after a failed exact edit.

WHEN NOT TO USE: locating an unknown file or symbol (use grep). Running or verifying code (use bash). Making changes (use edit or writeFile).

DO NOT USE FOR: searching across files (use grep), executing commands (use bash), or modifying content (use edit or writeFile).

USAGE: path must resolve inside /workspace. Content is ${readLimit === undefined ? "not capped in baseline mode" : `capped at ${readLimit} characters`}; inspect truncated and sourceCharacters before assuming the full file was returned.

EXAMPLES:
- Read a known source file: { "path": "/workspace/math.js" }
- Inspect project instructions: { "path": "/workspace/AGENTS.md" }
- Read diagnostics explicitly requested by the task: { "path": "/workspace/diagnostics.log" }`,
    inputSchema: z.object({ path: workspacePathSchema }),
    execute: async ({ path }) => {
      const startedAt = performance.now();
      try {
        const content = await sandbox.readFile(path);
        const cappedContent = capOutput(
          content,
          options.maximumReadCharacters ?? Number.POSITIVE_INFINITY,
        );
        await trace.write({
          type: "tool_result",
          tool: "readFile",
          path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          sourceCharacters: content.length,
          outputCharacters: cappedContent.text.length,
          truncated: cappedContent.truncated,
        });
        return {
          path,
          content: cappedContent.text,
          truncated: cappedContent.truncated,
          sourceCharacters: content.length,
        };
      } catch (error) {
        return toolError(trace, "readFile", startedAt, error, { path });
      }
    },
  });

  const writeFile = tool({
    description: `Create or fully replace one UTF-8 file in the virtual workspace. Returns the path and number of characters written.

WHEN TO USE: creating a new file; replacing most or all of an existing file; writing a small executable test fixture when no suitable verification exists.

WHEN NOT TO USE: changing one unique span in an existing file (use edit). Inspecting content (use readFile). Running verification (use bash).

DO NOT USE FOR: small targeted changes (use edit), reading files (use readFile), searching (use grep), or executing code (use bash).

USAGE: path must resolve inside /workspace and content is limited to 20,000 characters. Read an existing file before replacing it. Virtual-workspace writes are auto-approved and traced.

EXAMPLES:
- Create a script: { "path": "/workspace/check.js", "content": "console.log('ok');" }
- Create project guidance: { "path": "/workspace/AGENTS.md", "content": "Always verify changes." }
- Replace a complete tiny module: { "path": "/workspace/constants.js", "content": "export const PORT = 3000;" }`,
    inputSchema: z.object({
      path: workspacePathSchema,
      content: z.string().max(20_000),
    }),
    execute: async ({ path, content }) => {
      const startedAt = performance.now();
      await trace.write({
        type: "approval",
        tool: "writeFile",
        policy: "virtual-workspace-write",
        decision: "auto-approved",
        path,
      });
      try {
        await sandbox.writeFile(path, content);
        await trace.write({
          type: "tool_result",
          tool: "writeFile",
          path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          writtenCharacters: content.length,
        });
        return { success: true, path, writtenCharacters: content.length };
      } catch (error) {
        return toolError(trace, "writeFile", startedAt, error, { path });
      }
    },
  });

  const grep = tool({
    description: `Search workspace file contents for a literal string. Returns matching lines with file paths, truncation status, and exit code.

WHEN TO USE: locating a function or class definition; finding imports, TODOs, error messages, or configuration keys; identifying which file to read next.

WHEN NOT TO USE: reading a known file (use readFile). Listing files without a search term (use bash with ls or tree). Modifying matches (use edit after reading the file).

DO NOT USE FOR: reading full files (use readFile), directory listings (use bash), regex searches, or file modification (use edit or writeFile).

USAGE: pattern is a non-empty literal string, not a regular expression. path defaults to /workspace and must stay inside it. Returned text is capped at 8,000 characters. Exit code 1 means no matches, not tool failure.

EXAMPLES:
- Locate a function: { "pattern": "function clamp", "path": "/workspace" }
- Find TODO comments: { "pattern": "TODO", "path": "/workspace" }
- Find an error message in a known subtree: { "pattern": "Division by zero", "path": "/workspace/src" }`,
    inputSchema: z.object({
      pattern: z.string().min(1).max(200),
      path: workspacePathSchema.default("/workspace"),
    }),
    execute: async ({ pattern, path }) => {
      const startedAt = performance.now();
      try {
        const result = await sandbox.exec(
          `rg -F ${shellQuote(pattern)} ${shellQuote(path)}`,
        );
        const cappedOutput = capOutput(result.stdout, 8_000);
        const output = {
          success: result.exitCode === 0 || result.exitCode === 1,
          matches: cappedOutput.text,
          truncated: cappedOutput.truncated,
          exitCode: result.exitCode,
        };
        await trace.write({
          type: "tool_result",
          tool: "grep",
          pattern,
          path,
          durationMs: Math.round(performance.now() - startedAt),
          outputCharacters: cappedOutput.text.length,
          ...output,
        });
        return output;
      } catch (error) {
        return toolError(trace, "grep", startedAt, error, { pattern, path });
      }
    },
  });

  const edit = tool({
    description: `Replace one exact, unique text span in an existing workspace file. Returns success plus removed and inserted character counts.

WHEN TO USE: fixing one expression; changing a function body or configuration value; making a small patch after reading the current file.

WHEN NOT TO USE: creating a file or replacing most of it (use writeFile). Changing repeated text without a unique surrounding span. Inspecting or searching (use readFile or grep).

DO NOT USE FOR: blind edits without first reading the file, multiple-match replacements, new files (use writeFile), or command execution (use bash).

USAGE: path must resolve inside /workspace. oldText must match exactly once, including whitespace; zero or multiple matches return a structured error without writing. oldText and newText are each capped at 10,000 characters. Successful edits are auto-approved and traced.

EXAMPLES:
- Fix an operator: { "path": "/workspace/calculator.js", "oldText": "return a * b;", "newText": "return a / b;" }
- Change a unique setting: { "path": "/workspace/config.js", "oldText": "const debug = true;", "newText": "const debug = false;" }
- Replace a unique function body by including enough surrounding text to make oldText occur once.`,
    inputSchema: z.object({
      path: workspacePathSchema,
      oldText: z.string().min(1).max(10_000),
      newText: z.string().max(10_000),
    }),
    execute: async ({ path, oldText, newText }) => {
      const startedAt = performance.now();
      try {
        const content = await sandbox.readFile(path);
        const occurrences = countOccurrences(content, oldText);
        if (occurrences !== 1) {
          const error = `Expected oldText to occur exactly once, found ${occurrences}.`;
          await trace.write({
            type: "tool_result",
            tool: "edit",
            path,
            success: false,
            durationMs: Math.round(performance.now() - startedAt),
            error,
            occurrences,
          });
          return { success: false, error, occurrences };
        }

        await trace.write({
          type: "approval",
          tool: "edit",
          policy: "virtual-workspace-write",
          decision: "auto-approved",
          path,
        });
        await sandbox.writeFile(path, content.replace(oldText, newText));
        await trace.write({
          type: "tool_result",
          tool: "edit",
          path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          removedCharacters: oldText.length,
          insertedCharacters: newText.length,
        });
        return {
          success: true,
          path,
          removedCharacters: oldText.length,
          insertedCharacters: newText.length,
        };
      } catch (error) {
        return toolError(trace, "edit", startedAt, error, { path });
      }
    },
  });

  const bash = tool({
    description: `Execute an allowlisted command in the virtual workspace. Returns success, stdout, stderr, and exit code, or a structured policy denial.

WHEN TO USE: executing a self-contained JavaScript or TypeScript file with js-exec; verifying a code change; listing workspace files with ls or tree; narrow read-only shell inspection with rg, cat, head, tail, or wc.

WHEN NOT TO USE: reading a known file (use readFile). Searching for a literal across files (use grep). Editing or creating files (use edit or writeFile).

DO NOT USE FOR: node, npm, package installation, network access, destructive commands, file mutation, reading known files, or searching when grep can express the query.

USAGE: command is one shell string capped at 500 characters. Allowed commands are js-exec against one self-contained workspace .js/.ts file and read-only ls/tree/rg/cat/head/tail/wc forms. Commands outside policy are denied and the denial should guide the next action. Use js-exec, never node, for verification in this backend.

EXAMPLES:
- Verify a file: { "command": "js-exec /workspace/calculator.js" }
- List workspace files: { "command": "ls -la /workspace" }
- Preview a long file only when readFile is inappropriate: { "command": "head -n 20 /workspace/diagnostics.log" }`,
    inputSchema: z.object({
      command: z.string().min(1).max(500),
    }),
    execute: async ({ command }) => {
      const startedAt = performance.now();
      if (!isAllowedCommand(command)) {
        await trace.write({
          type: "approval",
          tool: "bash",
          policy: "verification-command-allowlist",
          decision: "denied",
          command,
        });
        return {
          success: false,
          error:
            "Command denied by policy. Allowed: js-exec <workspace-file>.ts|js and read-only ls/tree/rg/cat/head/tail/wc commands.",
        };
      }

      await trace.write({
        type: "approval",
        tool: "bash",
        policy: "verification-command-allowlist",
        decision: "auto-approved",
        command,
      });
      try {
        const result = await sandbox.exec(command);
        const output = {
          success: result.exitCode === 0,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
        await trace.write({
          type: "tool_result",
          tool: "bash",
          command,
          durationMs: Math.round(performance.now() - startedAt),
          ...output,
        });
        return output;
      } catch (error) {
        return toolError(trace, "bash", startedAt, error, { command });
      }
    },
  });

  const directTools = { readFile, grep, writeFile, edit, bash };
  if (!options.subagents) {
    return directTools;
  }

  return {
    ...directTools,
    task: createTaskTool(sandbox, trace, directTools, options.subagents),
  };
}

export function createTaskTool(
  sandbox: Sandbox,
  trace: RunTrace,
  parentTools: DirectCodingTools,
  models: {
    explorerModel: LanguageModel;
    executorModel: LanguageModel;
    onResult?: (result: {
      role: "explorer" | "executor";
      task: string;
      output: string;
    }) => void | Promise<void>;
  },
) {
  return tool({
    description: `Delegate work to a fresh isolated subagent and return only its final summary.

Explorer (default): read-only research. It can use readFile and grep only. Use it for searching across many files, understanding patterns, gathering project context, and summarizing findings without polluting the parent context.

Executor: focused implementation. It can use readFile, grep, writeFile, edit, and bash. Use it only when the parent can give explicit instructions, constraints, and a known verification step.

WHEN TO USE: research across several files before acting; focused implementation after the parent has decided the approach; mechanical work where the parent benefits from receiving a concise result instead of every intermediate file read.

WHEN NOT TO USE: ambiguous requirements, architectural decisions, user-facing choices, or tasks where the parent can directly finish in one or two tool calls.

DO NOT USE FOR: asking the user questions, speculative broad rewrites, package installation, external network work, or delegating responsibility for decisions the parent should make.

USAGE: pass a concrete description. Set subagentType to "explorer" for read-only investigation or "executor" for scoped edits plus verification. Subagents are created per call and do not keep memory between calls.

EXAMPLES:
- Research: { "subagentType": "explorer", "description": "Find every file that defines or uses the clamp function and summarize the relevant behavior." }
- Implement: { "subagentType": "executor", "description": "In /workspace/math.js, fix clamp so boundary tests pass, then run js-exec /workspace/math.js and report the result." }
- Sequence: first ask explorer to locate the relevant files, then ask executor to make the decided change.`,
    inputSchema: z.object({
      description: z
        .string()
        .min(1)
        .max(2_000)
        .describe("Precise task instructions for the subagent."),
      subagentType: z
        .enum(["explorer", "executor"])
        .default("explorer")
        .describe("Use explorer for read-only research or executor for scoped edits."),
    }),
    execute: async ({ description, subagentType }, { abortSignal }) => {
      if (subagentType === "executor") {
        const output = await runSubagent(
          trace,
          subagentType,
          buildExecutor(sandbox, parentTools, models.executorModel),
          description,
          abortSignal,
        );
        await models.onResult?.({ role: subagentType, task: description, output });
        return output;
      }

      const output = await runSubagent(
        trace,
        subagentType,
        buildExplorer(sandbox, parentTools, models.explorerModel),
        description,
        abortSignal,
      );
      await models.onResult?.({ role: subagentType, task: description, output });
      return output;
    },
  });
}

function buildExplorer(
  sandbox: Sandbox,
  parentTools: Pick<DirectCodingTools, "readFile" | "grep">,
  model: LanguageModel,
) {
  return new ToolLoopAgent({
    model,
    instructions: `You are an explorer subagent working in ${sandbox.workingDirectory}.

Your job is read-only investigation.
- Use readFile and grep to gather evidence.
- Do not ask questions.
- Do not propose edits unless asked to identify likely changes.
- Return a concise summary with file paths and concrete findings.
- Do not claim tests pass or fail unless you actually ran an allowed verification command.
- If you cannot answer with the available tools, say exactly what is missing.`,
    tools: {
      readFile: parentTools.readFile,
      grep: parentTools.grep,
    },
    stopWhen: stepCountIs(5),
    maxOutputTokens: 800,
  });
}

function buildExecutor(
  sandbox: Sandbox,
  parentTools: DirectCodingTools,
  model: LanguageModel,
) {
  return new ToolLoopAgent({
    model,
    instructions: `You are an executor subagent working in ${sandbox.workingDirectory}.

Your job is focused implementation delegated by the parent.
- Follow the parent's instructions precisely.
- Do not ask questions.
- Do not explore beyond what is needed to complete the delegated task.
- Use edit or writeFile for changes, then use bash for allowed verification.
- Respect tool-policy denials. Do not retry denied commands.
- Report exactly what changed and what verification ran.
- If the instructions are insufficient or verification is unavailable, stop and report the limitation.`,
    tools: {
      readFile: parentTools.readFile,
      grep: parentTools.grep,
      writeFile: parentTools.writeFile,
      edit: parentTools.edit,
      bash: parentTools.bash,
    },
    stopWhen: stepCountIs(15),
    maxOutputTokens: 700,
  });
}

async function runSubagent<TTools extends ToolSet>(
  trace: RunTrace,
  role: "explorer" | "executor",
  agent: ToolLoopAgent<never, TTools>,
  description: string,
  abortSignal: AbortSignal | undefined,
) {
  await trace.write({
    type: "subagent_started",
    role,
    task: description,
  });

  try {
    const result = await agent.generate({
      prompt: description,
      abortSignal,
      timeout: {
        totalMs: role === "executor" ? 120_000 : 60_000,
        stepMs: 45_000,
        chunkMs: 30_000,
      },
      onToolExecutionStart: async ({ toolCall }) => {
        await trace.write({
          type: "subagent_tool_call",
          role,
          tool: toolCall.toolName,
          input: toolCall.input,
        });
      },
      onStepFinish: async ({ stepNumber, usage, finishReason, toolCalls }) => {
        await trace.write({
          type: "subagent_step_finished",
          role,
          stepNumber,
          finishReason,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          tools: toolCalls.map((call) => call.toolName),
        });
      },
      onFinish: async ({ usage, steps, finishReason }) => {
        await trace.write({
          type: "subagent_finished",
          role,
          steps: steps.length,
          finishReason,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        });
      },
    });

    return result.text
      ? `[${role}: ${result.steps.length} steps]\n${result.text}`
      : `(no response from ${role})`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await trace.write({
      type: "subagent_error",
      role,
      error: message,
    });
    return `${role} error: ${message}`;
  }
}

function isWorkspacePath(path: string): boolean {
  const resolved = posix.resolve("/workspace", path);
  return resolved === "/workspace" || resolved.startsWith("/workspace/");
}

function isAllowedCommand(command: string): boolean {
  const trimmed = command.trim();
  if (
    /^js-exec\s+(?:\/workspace\/)?[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s)$/.test(
      trimmed,
    )
  ) {
    return !trimmed.includes("..");
  }
  return /^(?:ls|tree|cat|head|tail|wc|rg)(?:\s+[A-Za-z0-9_./*?"'=-]+)*$/.test(
    trimmed,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function capOutput(value: string, maximumCharacters: number) {
  if (value.length <= maximumCharacters) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, maximumCharacters)}\n[output truncated by harness]`,
    truncated: true,
  };
}

function countOccurrences(value: string, search: string): number {
  let count = 0;
  let index = 0;
  while ((index = value.indexOf(search, index)) !== -1) {
    count += 1;
    index += search.length;
  }
  return count;
}

async function toolError(
  trace: RunTrace,
  toolName: string,
  startedAt: number,
  error: unknown,
  context: Record<string, unknown>,
) {
  const message = error instanceof Error ? error.message : String(error);
  await trace.write({
    type: "tool_result",
    tool: toolName,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: message,
    ...context,
  });
  return { success: false, error: message };
}
