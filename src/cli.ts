import "dotenv/config";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { pruneMessages, stepCountIs, ToolLoopAgent } from "ai";

import { loadProjectContext } from "./project-context.js";
import { createSandbox } from "./sandbox.js";
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
  throw new Error('Provide a task, for example: npm run agent -- "Read /workspace/calculator.ts and explain the bug."');
}

const modelId = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4-flash";
const contextMode = process.env.HARNESS_CONTEXT_MODE === "baseline" ? "baseline" : "managed";
const openrouter = createOpenRouter({ apiKey });
const trace = new RunTrace();

const sandbox = createSandbox();
const projectContext = await loadProjectContext(sandbox);
const tools = createCodingTools(sandbox, trace, {
  maximumReadCharacters: contextMode === "managed" ? 4_000 : undefined,
});

const agent = new ToolLoopAgent({
  model: openrouter.chat(modelId),
  instructions: buildSystemPrompt({
    workingDirectory: "/workspace",
    sandboxType:
      "just-bash in-memory virtual filesystem with restricted QuickJS execution",
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
  contextMode,
  projectContextLoaded: projectContext !== undefined,
  projectContextCharacters: projectContext?.length ?? 0,
  task: prompt,
});
console.log(`model: ${modelId}`);
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
    console.error(`\n[tool] ${toolCall.toolName}`);
    await trace.write({
      type: "tool_call",
      tool: toolCall.toolName,
      input: toolCall.input,
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
  onFinish: async ({ totalUsage, steps, finishReason }) => {
    await trace.write({
      type: "run_finished",
      steps: steps.length,
      finishReason,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      totalTokens: totalUsage.totalTokens,
    });
  },
});

try {
  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }
  process.stdout.write("\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await trace.write({ type: "run_error", error: message });
  console.error(`\nAgent stream failed: ${message}`);
  process.exitCode = 1;
}

// QuickJS uses a worker internally. Force a clean CLI exit after all stream
// callbacks and trace writes have completed so an idle runtime worker cannot
// keep this one-shot process alive.
process.exit(process.exitCode ?? 0);
