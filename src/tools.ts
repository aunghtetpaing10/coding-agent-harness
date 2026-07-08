import { posix } from "node:path";

import { tool } from "ai";
import type { Bash } from "just-bash";
import { z } from "zod";

import type { RunTrace } from "./trace.js";

const workspacePathSchema = z.string().refine(isWorkspacePath, {
  message: "Path must resolve inside /workspace.",
});

export function createCodingTools(sandbox: Bash, trace: RunTrace) {
  const readFile = tool({
    description:
      "Read a UTF-8 text file from the virtual workspace. Use this when the task depends on file contents you have not observed.",
    inputSchema: z.object({ path: workspacePathSchema }),
    execute: async ({ path }) => {
      const startedAt = performance.now();
      try {
        const content = await sandbox.readFile(path);
        await trace.write({
          type: "tool_result",
          tool: "readFile",
          path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
          outputCharacters: content.length,
        });
        return { path, content };
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

  return { readFile, writeFile, bash };
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
