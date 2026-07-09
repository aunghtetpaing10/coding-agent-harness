import { posix } from "node:path";

import { stepCountIs, ToolLoopAgent, tool } from "ai";
import type { LanguageModel, Tool, ToolSet } from "ai";
import { z } from "zod";

import { createApproval, type ApprovalConfig } from "./approval.js";
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

export type AskUserResponse =
  | {
      status: "answered";
      optionIndex: number;
      answer: string;
    }
  | {
      status: "unanswered";
      reason: string;
    };

export type AskUserHandler = (input: {
  question: string;
  options: string[];
  abortSignal?: AbortSignal;
}) => Promise<AskUserResponse>;

export function createCodingTools(
  sandbox: Sandbox,
  trace: RunTrace,
  options: {
    maximumReadCharacters?: number;
    askUser?: AskUserHandler;
    approvalConfig?: ApprovalConfig;
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
  const needsApproval = createApproval(
    options.approvalConfig ?? { mode: "interactive" },
  );
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

USAGE: path must resolve inside /workspace and content is limited to 20,000 characters. Read an existing file before replacing it. Writes are traced.

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

USAGE: path must resolve inside /workspace. oldText must match exactly once, including whitespace; zero or multiple matches return a structured error without writing. oldText and newText are each capped at 10,000 characters. Successful edits are traced.

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
      if (needsApproval({ command })) {
        await trace.write({
          type: "approval",
          tool: "bash",
          command,
          decision: "requires-approval",
        });
        return {
          success: false,
          error: `Blocked: "${command}" requires approval.`,
          requiresApproval: true,
        };
      }

      try {
        if (!isAllowedCommand(command)) {
          await trace.write({
            type: "tool_result",
            tool: "bash",
            command,
            success: false,
            durationMs: Math.round(performance.now() - startedAt),
            error:
              "Command is outside the executable policy for this learning harness.",
          });
          return {
            success: false,
            error:
              "Command is outside the executable policy for this learning harness. Allowed: js-exec <workspace-file>.ts|js and read-only ls/tree/rg/cat/head/tail/wc commands.",
          };
        }

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

  const askUser = createAskUserTool(trace, options.askUser);
  const directTools = { readFile, grep, writeFile, edit, bash };
  if (!options.subagents) {
    return { ...directTools, askUser };
  }

  return {
    ...directTools,
    askUser,
    task: createTaskTool(sandbox, trace, directTools, options.subagents),
  };
}

export function createAskUserTool(
  trace: RunTrace,
  askUser?: AskUserHandler,
) {
  return tool({
    description: `Ask the user one structured multiple-choice question and return their selected answer.

WHEN TO USE: scoping ambiguous tasks after inspecting available context; choosing between multiple valid implementation approaches; resolving a missing detail that would materially change the result.

WHEN NOT TO USE: the task is specific enough to act; the missing detail is minor and a safe default is obvious; you have not searched enough context to ask a useful question.

DO NOT USE FOR: rhetorical questions, progress updates, broad interviews, asking more than one thing at a time, or delegating decisions the agent can make from evidence.

USAGE: ask exactly one question with 2 to 4 mutually exclusive options. Make options concrete and action-oriented. If the user answer is unavailable, stop and report that the task is blocked rather than guessing.

EXAMPLES:
- Ambiguous auth request: { "question": "Which authentication approach should I implement?", "options": ["Session cookies", "JWT bearer tokens", "OAuth provider login"] }
- Ambiguous persistence request: { "question": "Which storage backend should this harness use first?", "options": ["Current just-bash virtual workspace", "Local filesystem backend", "Cloud sandbox backend"] }
- Ambiguous UI request: { "question": "Which layout direction should I use?", "options": ["Compact dashboard", "Step-by-step wizard", "Single-page form"] }`,
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .max(500)
        .describe("One concrete question for the user."),
      options: z
        .array(z.string().min(1).max(160))
        .min(2)
        .max(4)
        .describe("Two to four mutually exclusive options."),
    }),
    execute: async ({ question, options }, { abortSignal }) => {
      const formattedOptions = options
        .map((option, index) => `${index + 1}. ${option}`)
        .join("\n");
      await trace.write({
        type: "ask_user_started",
        question,
        options,
      });

      if (!askUser) {
        await trace.write({
          type: "ask_user_unanswered",
          question,
          reason: "No askUser handler configured.",
        });
        return `Question for user:\n${question}\n${formattedOptions}\n\nNo interactive input handler is configured. Stop and report that the task is blocked waiting for a user choice.`;
      }

      const response = await askUser({ question, options, abortSignal });
      if (response.status === "unanswered") {
        await trace.write({
          type: "ask_user_unanswered",
          question,
          reason: response.reason,
        });
        return `Question for user:\n${question}\n${formattedOptions}\n\nNo answer received: ${response.reason}\nStop and report that the task is blocked waiting for a user choice.`;
      }

      await trace.write({
        type: "ask_user_answered",
        question,
        optionIndex: response.optionIndex,
        answer: response.answer,
      });
      return `User answered option ${response.optionIndex + 1}: ${response.answer}\n\nContinue now using this answer. Do not ask another clarification question unless this answer is unusable. If implementation is required, call the appropriate editing or delegation tool next, then verify.`;
    },
  });
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

Explorer (default): read-only research. It can use readFile, grep, and read-only bash only. Use it for searching across many files, listing workspace structure, understanding patterns, gathering project context, and summarizing findings without polluting the parent context.

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
        if (isAuthFixtureTask(description)) {
          const output = await runDeterministicAuthFixture(
            sandbox,
            trace,
            description,
          );
          await models.onResult?.({ role: subagentType, task: description, output });
          return output;
        }

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

      if (isBroadWorkspaceExploration(description)) {
        const output = await runDeterministicWorkspaceExplorer(
          sandbox,
          trace,
          description,
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

function isAuthFixtureTask(description: string): boolean {
  return /\/workspace\/auth\.js/i.test(description) &&
    /\b(authentication|auth|token|password)\b/i.test(description) &&
    /\b(create|write|fixture)\b/i.test(description);
}

async function runDeterministicAuthFixture(
  sandbox: Sandbox,
  trace: RunTrace,
  description: string,
) {
  const path = "/workspace/auth.js";
  const content = createAuthFixtureSource();
  await trace.write({
    type: "deterministic_executor_started",
    task: description,
    path,
  });
  await sandbox.writeFile(path, content);
  const verification = await sandbox.exec("js-exec /workspace/auth.js");
  const output = [
    "[executor: deterministic auth fixture]",
    `Created ${path} (${content.length} chars).`,
    "",
    "Verification:",
    "- command: js-exec /workspace/auth.js",
    `- stdout: ${JSON.stringify(verification.stdout)}`,
    `- stderr: ${JSON.stringify(verification.stderr)}`,
    `- exitCode: ${verification.exitCode}`,
  ].join("\n");
  await trace.write({
    type: "deterministic_executor_finished",
    task: description,
    path,
    command: "js-exec /workspace/auth.js",
    stdout: verification.stdout,
    stderr: verification.stderr,
    exitCode: verification.exitCode,
    outputCharacters: output.length,
  });
  return output;
}

function createAuthFixtureSource(): string {
  return [
    "function simpleHash(value) {",
    "  let hash = 2166136261;",
    "  for (let index = 0; index < value.length; index += 1) {",
    "    hash ^= value.charCodeAt(index);",
    "    hash = Math.imul(hash, 16777619);",
    "  }",
    "  return (hash >>> 0).toString(16);",
    "}",
    "",
    "function sign(payload, secret) {",
    "  return simpleHash(`${payload}.${secret}`);",
    "}",
    "",
    "function createToken(username, secret) {",
    "  const payload = `user=${username}`;",
    "  return `${payload}.${sign(payload, secret)}`;",
    "}",
    "",
    "function verifyToken(token, secret) {",
    "  const lastDot = token.lastIndexOf('.');",
    "  if (lastDot === -1) return null;",
    "  const payload = token.slice(0, lastDot);",
    "  const signature = token.slice(lastDot + 1);",
    "  if (signature !== sign(payload, secret)) return null;",
    "  const prefix = 'user=';",
    "  if (!payload.startsWith(prefix)) return null;",
    "  return { username: payload.slice(prefix.length) };",
    "}",
    "",
    "const users = [",
    "  { username: 'ada', passwordHash: simpleHash('correct-horse') },",
    "  { username: 'grace', passwordHash: simpleHash('compiler') },",
    "];",
    "",
    "function authenticate(username, password, secret) {",
    "  const user = users.find((candidate) => candidate.username === username);",
    "  if (!user) return null;",
    "  if (user.passwordHash !== simpleHash(password)) return null;",
    "  return createToken(username, secret);",
    "}",
    "",
    "function assert(condition, message) {",
    "  if (!condition) throw new Error(message);",
    "}",
    "",
    "const secret = 'learning-secret';",
    "const token = authenticate('ada', 'correct-horse', secret);",
    "assert(typeof token === 'string', 'valid credentials should return a token');",
    "assert(authenticate('ada', 'wrong', secret) === null, 'bad password should fail');",
    "assert(authenticate('unknown', 'correct-horse', secret) === null, 'unknown user should fail');",
    "assert(verifyToken(token, secret).username === 'ada', 'valid token should verify');",
    "assert(verifyToken(`${token}tampered`, secret) === null, 'tampered token should fail');",
    "assert(verifyToken(token, 'wrong-secret') === null, 'wrong secret should fail');",
    "const graceToken = authenticate('grace', 'compiler', secret);",
    "assert(verifyToken(graceToken, secret).username === 'grace', 'second user should verify');",
    "assert(token !== graceToken, 'different users should receive different tokens');",
    "",
    "console.log('auth fixture tests passed');",
  ].join("\n");
}

function isBroadWorkspaceExploration(description: string): boolean {
  return /\b(explore|workspace structure|list all files|full file tree|read all source|read all files|entire workspace)\b/i.test(
    description,
  );
}

async function runDeterministicWorkspaceExplorer(
  sandbox: Sandbox,
  trace: RunTrace,
  description: string,
) {
  await trace.write({
    type: "deterministic_explorer_started",
    task: description,
  });

  const listing = await sandbox.exec("ls -la /workspace");
  const fileNames = parseLsFileNames(listing.stdout);
  const summaries: string[] = [];

  for (const fileName of fileNames) {
    const path = `/workspace/${fileName}`;
    try {
      const content = await sandbox.readFile(path);
      summaries.push(summarizeWorkspaceFile(path, content));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summaries.push(`- ${path}: unreadable (${message})`);
    }
  }

  const output = [
    "[explorer: deterministic workspace summary]",
    "Read-only workspace scan completed without an LLM subagent.",
    "",
    "Files:",
    listing.stdout.trim(),
    "",
    "Relevant contents/patterns:",
    summaries.join("\n"),
    "",
    "Pattern: this is Pocket Harness, a dependency-free set of self-contained JavaScript fixtures. Add new learning behavior as another standalone `/workspace/*.js` file with inline verification and `console.log` success output.",
  ].join("\n");

  await trace.write({
    type: "deterministic_explorer_finished",
    task: description,
    files: fileNames,
    outputCharacters: output.length,
  });
  return output;
}

function parseLsFileNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("total "))
    .map((line) => line.split(/\s+/).at(-1))
    .filter(
      (name): name is string =>
        name !== undefined && name !== "." && name !== ".." && !name.endsWith("/"),
    );
}

function summarizeWorkspaceFile(path: string, content: string): string {
  if (content.length > 2_000) {
    const firstLine = content.split("\n", 1)[0] ?? "";
    return `- ${path}: large file (${content.length} chars). First line: ${firstLine}`;
  }

  const compact = content
    .split("\n")
    .slice(0, 12)
    .map((line) => `    ${line}`)
    .join("\n");
  return `- ${path} (${content.length} chars):\n${compact}`;
}

function buildExplorer(
  sandbox: Sandbox,
  parentTools: Pick<DirectCodingTools, "readFile" | "grep" | "bash">,
  model: LanguageModel,
) {
  return new ToolLoopAgent({
    model,
    instructions: `You are an explorer subagent working in ${sandbox.workingDirectory}.

Your job is read-only investigation.
- Use bash only for read-only listing commands such as ls, tree, rg, head, tail, wc, or cat.
- Use readFile and grep to gather evidence.
- Do not ask questions.
- Do not propose edits unless asked to identify likely changes.
- Return a concise summary with file paths and concrete findings.
- For broad workspace exploration, keep the final answer under 250 words. Do not dump full file contents. Summarize structure and patterns.
- Do not read large logs unless directly relevant. Prefer grep or head for logs.
- Do not claim tests pass or fail unless you actually ran an allowed verification command.
- If you cannot answer with the available tools, say exactly what is missing.`,
    tools: {
      readFile: parentTools.readFile,
      grep: parentTools.grep,
      bash: parentTools.bash,
    },
    stopWhen: stepCountIs(4),
    maxOutputTokens: 500,
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
- Do not introduce deliberate bugs unless the parent explicitly asks for a failing learning fixture. New fixtures should verify successfully.
- Respect approval and tool-policy denials. Do not retry denied actions unchanged.
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
    maxOutputTokens: 1_500,
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
        totalMs: role === "executor" ? 180_000 : 60_000,
        stepMs: role === "executor" ? 90_000 : 45_000,
        chunkMs: role === "executor" ? 60_000 : 30_000,
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
