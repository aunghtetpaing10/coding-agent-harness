import { Bash } from "just-bash";

export function createSandbox(): Bash {
  return new Bash({
    cwd: "/workspace",
    javascript: true,
    commands: ["cat", "head", "ls", "rg", "tail", "tree", "wc"],
    executionLimits: {
      maxCommandCount: 100,
      maxLoopIterations: 100,
    },
    files: {
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
    },
  });
}
