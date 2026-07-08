import { describe, expect, it } from "vitest";

import { createJustBashSandbox } from "../src/sandbox-just-bash.js";

describe("just-bash JavaScript runtime", () => {
  it("executes a self-contained JavaScript file", async () => {
    const sandbox = await createJustBashSandbox();
    await sandbox.writeFile("/workspace/self-contained.js", "console.log(1 + 2);");

    const result = await sandbox.exec("js-exec self-contained.js");

    expect(result).toMatchObject({ exitCode: 0, stdout: "3\n", stderr: "" });
  });

  it("documents the current relative-module loading limitation", async () => {
    const sandbox = await createJustBashSandbox();
    await sandbox.writeFile(
      "/workspace/importer.js",
      'require("./calculator.js");',
    );

    const result = await sandbox.exec("js-exec importer.js");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Cannot find module|Invalid URL/);
  });

  it("executes the calculator specification after the bug is fixed", async () => {
    const sandbox = await createJustBashSandbox();
    const buggy = await sandbox.readFile("/workspace/calculator.js");
    await sandbox.writeFile(
      "/workspace/calculator.js",
      buggy.replace("return a * b", "return a / b"),
    );

    const result = await sandbox.exec("js-exec calculator.js");

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "calculator test passed\n",
      stderr: "",
    });
  });

  it("supports the literal-search command used by the grep tool", async () => {
    const sandbox = await createJustBashSandbox();

    const result = await sandbox.exec("rg -F clamp /workspace");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/workspace/math.js:1:function clamp");
  });
});
