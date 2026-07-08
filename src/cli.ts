import "dotenv/config";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { stepCountIs, tool, ToolLoopAgent } from "ai";
import { Bash } from "just-bash";
import { z } from "zod";

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
const openrouter = createOpenRouter({ apiKey });
const trace = new RunTrace();

const sandbox = new Bash({
  cwd: "/workspace",
  files: {
    "/workspace/calculator.ts": [
      "export function divide(a: number, b: number): number {",
      "  return a * b; // Deliberate bug for the first experiment.",
      "}",
    ].join("\n"),
  },
});

const readFile = tool({
  description:
    "Read a UTF-8 text file from the virtual workspace. Use this when the task depends on file contents you have not observed. Paths must start with /workspace/.",
  inputSchema: z.object({
    path: z.string().startsWith("/workspace/"),
  }),
  execute: async ({ path }) => {
    const startedAt = performance.now();
    const result = await sandbox.exec(`cat -- ${shellQuote(path)}`);
    const output = {
      path,
      content: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
    await trace.write({
      type: "tool_result",
      tool: "readFile",
      path,
      exitCode: result.exitCode,
      durationMs: Math.round(performance.now() - startedAt),
      outputCharacters: result.stdout.length,
    });
    return output;
  },
});

const agent = new ToolLoopAgent({
  model: openrouter.chat(modelId),
  instructions: [
    "You are a coding agent operating in a virtual workspace.",
    "Inspect relevant files before making claims about their contents.",
    "For this first experiment you are read-only: explain findings and do not claim to have changed files.",
  ].join("\n"),
  tools: { readFile },
  stopWhen: stepCountIs(6),
});

await trace.write({ type: "run_started", modelId, task: prompt });
console.log(`model: ${modelId}`);
console.log(`trace: ${trace.filePath}\n`);

const result = await agent.stream({
  prompt,
  experimental_onToolCallStart: async ({ toolCall }) => {
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
  onFinish: async ({ totalUsage, steps }) => {
    await trace.write({
      type: "run_finished",
      steps: steps.length,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      totalTokens: totalUsage.totalTokens,
    });
  },
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
process.stdout.write("\n");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
