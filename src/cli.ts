import "dotenv/config";

import { createInterface } from "node:readline/promises";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { pruneMessages, stepCountIs, ToolLoopAgent } from "ai";

import type { ApprovalConfig } from "./approval.js";
import { loadProjectContext } from "./project-context.js";
import { createSandboxByType } from "./sandbox-factory.js";
import type { SandboxLifecycle } from "./sandbox.js";
import { buildSystemPrompt } from "./system.js";
import { createCodingTools, type AskUserHandler } from "./tools.js";
import { RunTrace } from "./trace.js";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error(
    "OPENROUTER_API_KEY is missing. Copy .env.example to .env and add your key.",
  );
}

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  throw new Error(
    'Provide a task, for example: npm run agent -- "Read /workspace/calculator.js and explain the bug."',
  );
}

const modelId = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4-flash";
const explorerModelId = process.env.OPENROUTER_EXPLORER_MODEL ?? modelId;
const executorModelId = process.env.OPENROUTER_EXECUTOR_MODEL ?? modelId;
const contextMode =
  process.env.HARNESS_CONTEXT_MODE === "baseline" ? "baseline" : "managed";
const approvalConfig = parseApprovalConfig();
const openrouter = createOpenRouter({ apiKey });
const trace = new RunTrace();
let lastDelegationResult:
  | {
      role: "explorer" | "executor";
      task: string;
      output: string;
    }
  | undefined;
let pendingPostAskUserAction = false;
let lastAnsweredQuestion:
  | {
      question: string;
      answer: string;
    }
  | undefined;
let askUserAnswered = false;
let actionToolAfterAskUser = false;
let authFixtureNeedsDeterministicRepair = false;

const sandbox = await createSandboxByType();
const lifecycle: SandboxLifecycle = {
  afterStart: async (startedSandbox) => {
    await trace.write({
      type: "sandbox_started",
      sandboxType: startedSandbox.type,
      workingDirectory: startedSandbox.workingDirectory,
    });
  },
  beforeStop: async (stoppingSandbox) => {
    await trace.write({
      type: "sandbox_stopping",
      sandboxType: stoppingSandbox.type,
    });
  },
};

await lifecycle.afterStart?.(sandbox);

try {
  const projectContext = await loadProjectContext(sandbox);
  const tools = createCodingTools(sandbox, trace, {
    maximumReadCharacters: contextMode === "managed" ? 4_000 : undefined,
    askUser: askUserInTerminal,
    approvalConfig,
    subagents: {
      explorerModel: openrouter.chat(explorerModelId),
      executorModel: openrouter.chat(executorModelId),
      onResult: (result) => {
        lastDelegationResult = result;
      },
    },
  });

  const agent = new ToolLoopAgent({
    model: openrouter.chat(modelId),
    instructions: buildSystemPrompt({
      workingDirectory: sandbox.workingDirectory,
      sandboxType: sandbox.type,
      toolNames: Object.keys(tools),
      projectContext,
      verificationHint:
        "Use bash with js-exec on a self-contained workspace .js or .ts file. node, npm, external binaries, require/import, and Node built-ins such as crypto are unavailable.",
    }),
    tools,
    stopWhen: stepCountIs(10),
    maxOutputTokens: 2_000,
    prepareStep: async ({ stepNumber, messages }) => {
      const isPostAskUserActionStep = pendingPostAskUserAction;
      pendingPostAskUserAction = false;
      const beforeCharacters = JSON.stringify(messages).length;
      const preparedMessages =
        contextMode === "managed"
          ? pruneMessages({
              messages,
              reasoning: "all",
              toolCalls: [
                {
                  type: "before-last-2-messages",
                  tools: ["grep"],
                },
              ],
              emptyMessages: "remove",
            })
          : messages;
      await trace.write({
        type: "context_prepared",
        mode: contextMode,
        stepNumber,
        messagesBefore: messages.length,
        messagesAfter: preparedMessages.length,
        serializedCharactersBefore: beforeCharacters,
        serializedCharactersAfter: JSON.stringify(preparedMessages).length,
        postAskUserActionStep: isPostAskUserActionStep,
      });
      return {
        messages: preparedMessages,
        ...(isPostAskUserActionStep
          ? {
              maxOutputTokens: 1_600,
              instructions: buildSystemPrompt({
                workingDirectory: sandbox.workingDirectory,
                sandboxType: sandbox.type,
                toolNames: Object.keys(tools),
                projectContext,
                verificationHint:
                  "Use bash with js-exec on a self-contained workspace .js or .ts file. node, npm, external binaries, require/import, and Node built-ins such as crypto are unavailable.",
              }).concat(
                "\n\n# Current Step\nThe user just answered askUser. Do not ask another clarification question unless the answer is unusable. Act on the selected option now: make the required change with writeFile/edit or delegate to task/executor, then verify with allowed tools.",
              ),
            }
          : {}),
      };
    },
  });

  await trace.write({
    type: "run_started",
    modelId,
    explorerModelId,
    executorModelId,
    contextMode,
    approvalMode: approvalConfig.mode,
    sandboxType: sandbox.type,
    projectContextLoaded: projectContext !== undefined,
    projectContextCharacters: projectContext?.length ?? 0,
    task: prompt,
  });
  console.log(`model: ${modelId}`);
  console.log(`explorer model: ${explorerModelId}`);
  console.log(`executor model: ${executorModelId}`);
  console.log(`sandbox: ${sandbox.type}`);
  console.log(`context: ${contextMode}`);
  console.log(`approval: ${formatApprovalConfig(approvalConfig)}`);
  console.log(`trace: ${trace.filePath}\n`);

  let streamedText = "";
  let textSinceLastTool = "";
  let sawToolCall = false;
  const result = await agent.stream({
    prompt,
    timeout: {
      totalMs: 120_000,
      stepMs: 45_000,
      chunkMs: 30_000,
    },
    onToolExecutionStart: async ({ toolCall }) => {
      if (askUserAnswered && toolCall.toolName !== "askUser") {
        actionToolAfterAskUser = true;
      }
      sawToolCall = true;
      textSinceLastTool = "";
      process.stdout.write(`\n[tool] ${toolCall.toolName}\n`);
      await trace.write({
        type: "tool_call",
        tool: toolCall.toolName,
        input: toolCall.input,
      });
    },
    onToolExecutionEnd: async ({ toolCall, toolOutput }) => {
      if (toolCall.toolName === "askUser" && isAnsweredAskUserOutput(toolOutput)) {
        pendingPostAskUserAction = true;
        lastAnsweredQuestion = parseAnsweredAskUserOutput(toolOutput);
        askUserAnswered = true;
      }
      if (isAuthFixtureCryptoFailure(toolOutput)) {
        authFixtureNeedsDeterministicRepair = true;
      }
      if (isAuthFixtureTaskFailure(toolOutput)) {
        authFixtureNeedsDeterministicRepair = true;
      }
      await trace.write({
        type: "tool_execution_finished",
        tool: toolCall.toolName,
        output: toolOutput,
      });
    },
    onStepFinish: async ({ stepNumber, usage, finishReason, toolCalls }) => {
      await trace.write({
        type: "step_finished",
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
        type: "run_finished",
        steps: steps.length,
        finishReason,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      });
    },
  });

  for await (const chunk of result.textStream) {
    streamedText += chunk;
    textSinceLastTool += chunk;
    process.stdout.write(chunk);
  }
  const missingPostToolText = sawToolCall && textSinceLastTool.trim().length === 0;
  if (missingPostToolText && lastDelegationResult) {
    const fallback = formatDelegationFallback(lastDelegationResult);
    await trace.write({
      type: "delegation_fallback_printed",
      role: lastDelegationResult.role,
      task: lastDelegationResult.task,
      outputCharacters: lastDelegationResult.output.length,
    });
    process.stdout.write(fallback);
  } else if (missingPostToolText && lastAnsweredQuestion) {
    const fallback = formatAskUserFallback(lastAnsweredQuestion);
    await trace.write({
      type: "ask_user_fallback_printed",
      question: lastAnsweredQuestion.question,
      answer: lastAnsweredQuestion.answer,
    });
    process.stdout.write(fallback);
  }
  if (
    askUserAnswered &&
    !actionToolAfterAskUser &&
    lastAnsweredQuestion &&
    shouldAutoContinueAfterAskUser(prompt)
  ) {
    const continuation = await runAskUserContinuation({
      originalPrompt: prompt,
      question: lastAnsweredQuestion.question,
      answer: lastAnsweredQuestion.answer,
      taskTool: (tools as Record<string, { execute?: Function }>).task,
    });
    await trace.write({
      type: "ask_user_auto_continuation_finished",
      question: lastAnsweredQuestion.question,
      answer: lastAnsweredQuestion.answer,
      outputCharacters: continuation.length,
    });
    process.stdout.write(`\n${continuation}`);
  }
  if (authFixtureNeedsDeterministicRepair) {
    const repair = await runAuthFixtureRepair(
      (tools as Record<string, { execute?: Function }>).task,
    );
    await trace.write({
      type: "auth_fixture_deterministic_repair_finished",
      outputCharacters: repair.length,
    });
    process.stdout.write(`\n${repair}`);
  }
  process.stdout.write("\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await trace.write({ type: "run_error", error: message });
  console.error(`\nAgent stream failed: ${message}`);
  process.exitCode = 1;
} finally {
  await lifecycle.beforeStop?.(sandbox);
  await sandbox.stop();
}

// QuickJS uses a worker internally. Force a clean CLI exit after lifecycle
// cleanup so an idle runtime worker cannot keep this one-shot process alive.
process.exit(process.exitCode ?? 0);

function parseApprovalConfig(): ApprovalConfig {
  const mode = process.env.HARNESS_APPROVAL_MODE;
  if (mode === undefined || mode === "interactive") {
    return { mode: "interactive" };
  }
  if (mode === "background") {
    return { mode: "background" };
  }
  if (mode === "delegated") {
    const trust = (process.env.HARNESS_APPROVAL_TRUST ?? "")
      .split(",")
      .map((prefix) => prefix.trim())
      .filter((prefix) => prefix.length > 0);
    return { mode: "delegated", trust };
  }
  throw new Error(
    "HARNESS_APPROVAL_MODE must be interactive, background, or delegated.",
  );
}

function formatApprovalConfig(config: ApprovalConfig): string {
  if (config.mode !== "delegated") {
    return config.mode;
  }
  return `delegated (${config.trust.length} trusted prefixes)`;
}

function formatDelegationFallback(result: {
  role: "explorer" | "executor";
  task: string;
  output: string;
}): string {
  return [
    `[delegation fallback] Parent produced no final text after the ${result.role} subagent finished.`,
    `Delegated task: ${result.task}`,
    "",
    result.output,
  ].join("\n");
}

function formatAskUserFallback(result: {
  question: string;
  answer: string;
}): string {
  return [
    "[askUser fallback] Your answer was received, but the parent model produced no follow-up text after the question.",
    `Question: ${result.question}`,
    `Answer: ${result.answer}`,
    "",
    "Re-run with the selected choice stated explicitly if you want the implementation to proceed deterministically.",
  ].join("\n");
}

function shouldAutoContinueAfterAskUser(originalPrompt: string): boolean {
  if (/do not modify|report only|only the selected option|do not write/i.test(originalPrompt)) {
    return false;
  }
  return /\b(add|create|implement|build|fix|update|modify|write)\b/i.test(
    originalPrompt,
  );
}

function isAuthFixtureCryptoFailure(toolOutput: unknown): boolean {
  if (
    typeof toolOutput !== "object" ||
    toolOutput === null ||
    !("toolName" in toolOutput) ||
    !("input" in toolOutput) ||
    !("output" in toolOutput)
  ) {
    return false;
  }
  const typed = toolOutput as {
    toolName?: unknown;
    input?: { command?: unknown };
    output?: { success?: unknown; stderr?: unknown };
  };
  return (
    typed.toolName === "bash" &&
    typed.input?.command === "js-exec /workspace/auth.js" &&
    typed.output?.success === false &&
    typeof typed.output.stderr === "string" &&
    /crypto.*not available|Module 'crypto' is not available/i.test(
      typed.output.stderr,
    )
  );
}

function isAuthFixtureTaskFailure(toolOutput: unknown): boolean {
  if (
    typeof toolOutput !== "object" ||
    toolOutput === null ||
    !("toolName" in toolOutput) ||
    !("output" in toolOutput)
  ) {
    return false;
  }
  const typed = toolOutput as {
    toolName?: unknown;
    output?: unknown;
  };
  if (typed.toolName !== "task" || typeof typed.output !== "string") {
    return false;
  }
  return (
    /\/workspace\/auth\.js|auth\.js|auth fixture/i.test(typed.output) &&
    /(exit code:?\s*`?1`?|exitCode:?\s*1|failed|stderr:)/i.test(typed.output)
  );
}

async function runAuthFixtureRepair(
  taskTool: { execute?: Function } | undefined,
): Promise<string> {
  if (!taskTool?.execute) {
    return [
      "[auth fixture repair blocked]",
      "auth.js failed because crypto is unavailable, but no task/executor tool is available to repair it.",
    ].join("\n");
  }

  process.stdout.write(
    "\n[auth fixture repair]\ncrypto is unavailable in js-exec, so the harness is replacing auth.js with a plain-JS fixture.\n",
  );
  const output = await taskTool.execute(
    {
      subagentType: "executor",
      description:
        "Create /workspace/auth.js as a self-contained authentication fixture using only plain JavaScript, no imports, no require, no crypto. Then run js-exec /workspace/auth.js and report stdout, stderr, and exit code.",
    },
    {
      toolCallId: "auth-fixture-repair",
      messages: [],
      context: {},
    },
  );
  return typeof output === "string" ? output : JSON.stringify(output);
}

async function runAskUserContinuation({
  originalPrompt,
  question,
  answer,
  taskTool,
}: {
  originalPrompt: string;
  question: string;
  answer: string;
  taskTool: { execute?: Function } | undefined;
}): Promise<string> {
  if (!taskTool?.execute) {
    return [
      "[askUser continuation blocked]",
      "The user answered, but no task/executor tool is available to continue implementation automatically.",
    ].join("\n");
  }

  process.stdout.write(
    "\n[askUser continuation]\nThe model did not take an action after your answer, so the harness is delegating the selected implementation to executor.\n",
  );
  const output = await taskTool.execute(
    {
      subagentType: "executor",
      description: [
        `Original task: ${originalPrompt}`,
        `User question: ${question}`,
        `User selected: ${answer}`,
        "",
        "Continue the original task using the selected option.",
        "Make the smallest workspace change that implements it.",
        "The implementation must verify successfully. Do not introduce deliberate bugs unless the user explicitly asked for a failing fixture.",
        "Do not ask another question.",
        "After changing files, run the relevant allowed verification command and report exact stdout, stderr, and exit code.",
      ].join("\n"),
    },
    {
      toolCallId: "ask-user-continuation",
      messages: [],
      context: {},
    },
  );
  return typeof output === "string" ? output : JSON.stringify(output);
}

function isAnsweredAskUserOutput(toolOutput: unknown): boolean {
  return parseAnsweredAskUserOutput(toolOutput) !== undefined;
}

function parseAnsweredAskUserOutput(
  toolOutput: unknown,
):
  | {
      question: string;
      answer: string;
    }
  | undefined {
  if (
    typeof toolOutput === "object" &&
    toolOutput !== null &&
    "output" in toolOutput
  ) {
    const typedOutput = toolOutput as {
      input?: { question?: unknown };
      output?: unknown;
    };
    const output = typedOutput.output;
    if (typeof output !== "string" || !output.startsWith("User answered ")) {
      return undefined;
    }
    const answer = output.split("\n", 1)[0]?.replace(/^User answered option \d+:\s*/, "");
    return {
      question:
        typeof typedOutput.input?.question === "string"
          ? typedOutput.input.question
          : "askUser",
      answer: answer && answer.length > 0 ? answer : output,
    };
  }
  return undefined;
}

async function askUserInTerminal({
  question,
  options,
  abortSignal,
}: Parameters<AskUserHandler>[0]): ReturnType<AskUserHandler> {
  const automaticChoice = process.env.HARNESS_ASK_USER_CHOICE;
  if (automaticChoice) {
    const index = Number.parseInt(automaticChoice, 10) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) {
      return {
        status: "answered",
        optionIndex: index,
        answer: options[index]!,
      };
    }
    return {
      status: "unanswered",
      reason: `HARNESS_ASK_USER_CHOICE must be a number from 1 to ${options.length}.`,
    };
  }

  if (!process.stdin.isTTY) {
    return {
      status: "unanswered",
      reason:
        "stdin is not interactive. Re-run in a terminal or set HARNESS_ASK_USER_CHOICE to a numbered option.",
    };
  }

  const formattedOptions = options
    .map((option, index) => `${index + 1}. ${option}`)
    .join("\n");
  process.stdout.write(`\n[askUser]\n${question}\n${formattedOptions}\n`);

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = abortSignal
        ? await readline.question(`Choose 1-${options.length}: `, {
            signal: abortSignal,
          })
        : await readline.question(`Choose 1-${options.length}: `);
      const index = Number.parseInt(answer.trim(), 10) - 1;
      if (Number.isInteger(index) && index >= 0 && index < options.length) {
        return {
          status: "answered",
          optionIndex: index,
          answer: options[index]!,
        };
      }
      process.stdout.write(`Enter a number from 1 to ${options.length}.\n`);
    }
  } catch (error) {
    return {
      status: "unanswered",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    readline.close();
  }
}
