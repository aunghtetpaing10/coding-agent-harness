# Agent Harness Learning Log

## Goal

Understand how an AI SDK coding-agent harness controls model calls, tools, execution, context, safety, observability, and delegation. Working code is evidence for the concepts, not the final objective.

## Experiment 1: From response generator to agent loop

### Hypothesis

Giving `ToolLoopAgent` a typed file-reading tool lets the model inspect an environment it could not otherwise observe. A successful run should contain at least two model steps: one that requests the tool and one that uses its result.

### Mechanism

The CLI creates a `ToolLoopAgent` with one typed `readFile` tool. The tool reads
from a `just-bash` virtual filesystem. The agent may take at most six model
steps. Lifecycle callbacks and tool execution write sanitized JSONL events to
an ignored `.runs/` directory.

### Observation

- Step 0 ended with `finishReason: "tool-calls"` and requested `readFile`.
- The tool read 116 characters from `/workspace/calculator.ts` in 22 ms.
- Step 1 received the tool result and ended with `finishReason: "stop"`.
- Total usage was 1,340 tokens: 909 input and 431 output.
- The final response correctly identified multiplication in a function named
  `divide` and distinguished the direct bug from an additional division-by-zero
  concern.
- The deprecated experimental tool-start callback did not produce its expected
  event, even though tool execution and the step-level trace proved that the
  call ran. Inspection of AI SDK 7.0.17 showed that `ToolLoopAgent.stream()`
  forwards the stable `onToolExecutionStart` callback. Switching to that API
  closed the observability gap.

### Conclusion

An agent loop requires a second model call after tool execution. The first call
can choose an action, but only the later call can interpret the observation and
produce a grounded final response. Step-level traces are more reliable evidence
than terminal presentation alone, and observability hooks themselves require
verification.

## Experiment 2: Write and verify under executable policy

### Hypothesis

A coding agent needs both mutation and execution capabilities, but the harness
must enforce their boundaries independently of model instructions.

### Mechanism

In progress. `writeFile` is confined to normalized `/workspace` paths and emits
an automatic approval event for the disposable virtual filesystem. `bash`
accepts only a small allowlist of read-only commands and `js-exec` against a
workspace JavaScript or TypeScript file.

### Observation

`just-bash` 3.0.3 executes self-contained JavaScript through QuickJS. A
controlled integration test showed that relative user-module loading fails in
this configuration, so it is not a substitute for a full Node runtime. The
learning fixture is therefore a self-contained executable specification.

### Conclusion

The agent completed the task in five model steps:

1. Read the file.
2. Replaced multiplication with division; the virtual write was auto-approved.
3. Tried `node`, which executable policy denied.
4. Adapted to the denial and ran the allowed `js-exec` command successfully.
5. Reported completion only after observing `calculator test passed`.

The run consumed 5,430 tokens (4,943 input and 487 output). Input context grew
on every step because prior calls and results remained in the conversation.
The model's recovery from a policy denial demonstrates why structured tool
errors should be returned to the loop rather than hidden or treated as fatal.

The agent finished in about 19 seconds, but the CLI remained alive because the
QuickJS execution worker held the process open. Agent lifecycle completion and
host-process lifecycle are separate concerns. The CLI now applies total,
per-step, and inter-chunk timeouts and exits explicitly after the completed
stream and trace callbacks.
