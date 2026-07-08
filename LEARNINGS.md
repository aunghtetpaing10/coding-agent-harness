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
- The experimental tool-start callback did not produce its expected event,
  even though tool execution and the step-level trace prove that the call ran.
  This is an observability gap to investigate before adding more tools.

### Conclusion

An agent loop requires a second model call after tool execution. The first call
can choose an action, but only the later call can interpret the observation and
produce a grounded final response. Step-level traces are more reliable evidence
than terminal presentation alone, and observability hooks themselves require
verification.
