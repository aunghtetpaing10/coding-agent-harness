import { posix } from "node:path";

import { tool } from "ai";
import type { Bash } from "just-bash";
import { z } from "zod";

import type { RunTrace } from "./trace.js";

const workspacePathSchema = z.string().refine(isWorkspacePath, {
  message: "Path must resolve inside /workspace.",
});

export function createCodingTools(
  sandbox: Bash,
  trace: RunTrace,
  options: { maximumReadCharacters?: number } = {},
) {
  const readFile = tool({
    description:
      "Read a UTF-8 text file from the virtual workspace. Use this when the task depends on file contents you have not observed.",
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
    description:
      "Replace a UTF-8 file inside /workspace. Use only after reading the existing file when it exists. The write is automatically approved because the filesystem is disposable and virtual.",
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
    description:
      "Search text files in the virtual workspace for a literal string. Use this to locate symbols or text before reading whole files. Results are capped by the harness.",
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
    description:
      "Replace one exact, unique text span in an existing workspace file. Prefer this over writeFile for small changes. The edit fails if oldText is absent or occurs more than once.",
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
    description:
      "Run a restricted command in the virtual workspace. Use js-exec with a self-contained workspace .ts or .js file to verify code. Destructive and arbitrary shell commands are denied by executable policy.",
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
          error: "Command denied by policy. Allowed: js-exec <workspace-file>.ts|js and read-only ls/tree/rg/cat/head/tail/wc commands.",
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

  return { readFile, grep, writeFile, edit, bash };
}

function isWorkspacePath(path: string): boolean {
  const resolved = posix.resolve("/workspace", path);
  return resolved === "/workspace" || resolved.startsWith("/workspace/");
}

function isAllowedCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/^js-exec\s+(?:\/workspace\/)?[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s)$/.test(trimmed)) {
    return !trimmed.includes("..");
  }
  return /^(?:ls|tree|cat|head|tail|wc|rg)(?:\s+[A-Za-z0-9_./*?"'=-]+)*$/.test(trimmed);
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
