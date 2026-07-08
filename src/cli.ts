import "dotenv/config";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { pruneMessages, stepCountIs, ToolLoopAgent } from "ai";

import { createSandbox } from "./sandbox.js";
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
const tools = createCodingTools(sandbox, trace, {
  maximumReadCharacters: contextMode === "managed" ? 4_000 : undefined,
});

const agent = new ToolLoopAgent({
  model: openrouter.chat(modelId),
  instructions: [
    "You are a coding agent operating in a virtual workspace.",
    "Inspect relevant files before making claims about their contents.",
    "Inspect relevant files before editing.",
    "Use grep to locate symbols when the relevant file is unknown.",
    "Prefer edit over writeFile for small, exact changes.",
    "When asked to change code, verify the result with the available bash tool before claiming success.",
    "If a tool is denied by policy, adapt to the restriction rather than claiming it ran.",
  ].join("\n"),
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

await trace.write({ type: "run_started", modelId, contextMode, task: prompt });
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
