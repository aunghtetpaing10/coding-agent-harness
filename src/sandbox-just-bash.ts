import { readFileSync } from "node:fs";

import { Bash } from "just-bash";

import type { Sandbox } from "./sandbox.js";

const WORKING_DIRECTORY = "/workspace";
const projectInstructions = readFileSync(
  new URL("../fixtures/AGENTS.md", import.meta.url),
  "utf8",
);

export async function createJustBashSandbox(): Promise<Sandbox> {
  const diagnostics = [
    "TARGET: clamp behavior fails at both lower and upper boundaries.",
    ...Array.from(
      { length: 500 },
      (_, index) =>
        `diagnostic line ${index + 1}: repeated low-value historical output`,
    ),
  ].join("\n");

  const bash = new Bash({
    cwd: WORKING_DIRECTORY,
    javascript: true,
    commands: ["cat", "head", "ls", "rg", "tail", "tree", "wc"],
    executionLimits: {
      maxCommandCount: 100,
      maxLoopIterations: 100,
    },
    files: {
      "/workspace/AGENTS.md": projectInstructions,
      "/workspace/diagnostics.log": diagnostics,
      "/workspace/calculator.js": [
        "function divide(a, b) {",
        "  return a * b; // Deliberate bug for the learning experiment.",
        "}",
        "",
        "if (divide(10, 2) !== 5) {",
        '  throw new Error(`Expected divide(10, 2) to equal 5, received ${divide(10, 2)}`);',
        "}",
        "",
        'console.log("calculator test passed");',
      ].join("\n"),
      "/workspace/math.js": [
        "function clamp(value, min, max) {",
        "  return Math.min(min, Math.max(max, value)); // Deliberately reversed.",
        "}",
        "",
        "if (clamp(12, 0, 10) !== 10 || clamp(-2, 0, 10) !== 0) {",
        '  throw new Error("clamp specification failed");',
        "}",
        "",
        'console.log("clamp test passed");',
      ].join("\n"),
    },
  });

  return {
    type: "just-bash",
    workingDirectory: WORKING_DIRECTORY,
    readFile: (path) => bash.readFile(path),
    writeFile: (path, content) => bash.writeFile(path, content),
    fileExists: (path) => bash.fs.exists(path),
    exec: async (command) => {
      const result = await bash.exec(command);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
    stop: async () => {},
  };
}
