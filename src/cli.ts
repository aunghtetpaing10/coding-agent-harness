import "dotenv/config";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { pruneMessages, stepCountIs, ToolLoopAgent } from "ai";

import { loadProjectContext } from "./project-context.js";
import { createSandboxByType } from "./sandbox-factory.js";
import type { SandboxLifecycle } from "./sandbox.js";
import { buildSystemPrompt } from "./system.js";
import { createCodingTools } from "./tools.js";
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
const openrouter = createOpenRouter({ apiKey });
const trace = new RunTrace();
let lastDelegationResult:
  | {
      role: "explorer" | "executor";
      task: string;
      output: string;
    }
  | undefined;

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
        "Use bash with js-exec on a self-contained workspace .js or .ts file. node, npm, and external binaries are unavailable.",
    }),
    tools,
    stopWhen: stepCountIs(10),
    maxOutputTokens: 800,
    prepareStep: async ({ stepNumber, messages }) => {
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
      });
      return { messages: preparedMessages };
    },
  });

  await trace.write({
    type: "run_started",
    modelId,
    explorerModelId,
    executorModelId,
    contextMode,
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
  console.log(`trace: ${trace.filePath}\n`);

  const result = await agent.stream({
    prompt,
    timeout: {
      totalMs: 120_000,
      stepMs: 45_000,
      chunkMs: 30_000,
    },
    onToolExecutionStart: async ({ toolCall }) => {
      process.stdout.write(`\n[tool] ${toolCall.toolName}\n`);
      await trace.write({
        type: "tool_call",
        tool: toolCall.toolName,
        input: toolCall.input,
      });
    },
    onToolExecutionEnd: async ({ toolCall, toolOutput }) => {
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

  let streamedText = "";
  for await (const chunk of result.textStream) {
    streamedText += chunk;
    process.stdout.write(chunk);
  }
  if (streamedText.trim().length === 0 && lastDelegationResult) {
    const fallback = formatDelegationFallback(lastDelegationResult);
    await trace.write({
      type: "delegation_fallback_printed",
      role: lastDelegationResult.role,
      task: lastDelegationResult.task,
      outputCharacters: lastDelegationResult.output.length,
    });
    process.stdout.write(fallback);
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
