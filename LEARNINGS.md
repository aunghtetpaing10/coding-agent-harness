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

## Experiment 3: Focused search and minimal edits

### Hypothesis

Focused tools reduce unnecessary context and mutation risk. A literal-search
tool should locate the relevant file without reading the full workspace, and an
exact edit should modify only a unique intended span instead of resending the
whole file.

### Mechanism

In progress. `grep` caps returned text at 8,000 characters. `edit` requires an
exactly-once match and records the approved mutation without storing complete
file contents in the trace.

### Observation

The first run exposed two harness defects before it could serve as a clean tool
comparison. The `grep` wrapper used an incompatible argument form and returned
no matches, so the agent recovered through denied `find`, allowed `ls`, and two
parallel reads. It then used `edit` successfully and verified with `js-exec`.
The 60-second total timeout expired while the model was composing its final
answer, leaving truncated text and no complete usage aggregate.

### Conclusion

Tool schemas can be valid while their execution contract is wrong; integration
tests must cover the actual backend command. Time limits also need observability
and calibration: a timeout that prevents runaway work can invalidate an
otherwise successful run. The grep command is now integration-tested, timeout
failures are traced at the stream-consumer boundary, and the bounded total
timeout is 120 seconds.

After correcting the grep contract, the repeated run followed the intended
sequence: `grep`, `readFile`, `edit`, denied `node`, allowed `js-exec`, then a
grounded final response. It finished normally in six steps. Focused search
eliminated the earlier directory listing and unrelated calculator-file read.
The run still consumed 11,250 tokens (10,052 input, 1,198 output), showing that
fewer tool calls do not by themselves solve repeated-context cost.

## Experiment 4: Bounded output and message pruning

### Hypothesis

Tool-output caps prevent oversized observations from entering context, while
`prepareStep` plus `pruneMessages` removes stale reasoning and tool exchanges
before later model calls. Both controls should reduce repeated input without
changing task success.

### Mechanism

In progress. `HARNESS_CONTEXT_MODE=baseline` preserves full read output and
message history. The default `managed` mode caps each file read at 4,000
characters and prunes reasoning plus tool exchanges older than the last two
messages before each step. Each preparation records message counts and
serialized character counts before and after pruning.

### Observation

The unbounded baseline succeeded in nine steps but consumed 69,702 tokens:
68,117 input and 1,585 output. The first managed policy reduced usage to 14,539
tokens, a 79% reduction, but failed at the 10-step cap. Blanket pruning removed
earlier command denials and file evidence, so the agent repeatedly retried
`node`, forgot the existing self-contained verification, and created an
unnecessary test file.

### Conclusion

Context reduction is an information-retention policy, not a mechanical cleanup.
The cheapest trace is worthless if the task fails. Prevention is safer than
cleanup: cap oversized tool output before it enters context, remove stale model
reasoning, and prune replaceable search results while retaining mutations,
approvals, policy denials, and verification evidence. A calibrated managed run
then succeeded in seven steps using 17,088 tokens (15,901 input and 1,187
output). That is about 75% fewer tokens than the 69,702-token baseline while
preserving task success. The more aggressive 14,539-token policy was cheaper,
but its failure demonstrates that minimum token use is not the objective;
minimum sufficient context is.

## Experiment 5: Tool descriptions as routing contracts

### Hypothesis

As the toolset grows, short capability summaries are insufficient. Explicit
positive scenarios, soft redirects, hard negative boundaries, parameter rules,
and concrete examples should reduce ambiguity and counter the model's tendency
to route general work through `bash`.

### Mechanism

Every tool description now follows the Vercel Academy five-section contract:
WHEN TO USE, WHEN NOT TO USE, DO NOT USE FOR, USAGE, and EXAMPLES. Summaries
state the output shape, redirects name the appropriate alternative tool, and
usage text reflects this harness's actual path, size, and command policies.

### Observation

Three real-model routing checks each selected exactly one intended tool:

- Search-shaped prompt -> `grep` (2 steps, 4,652 tokens).
- Known-file prompt -> `readFile` (2 steps, 4,615 tokens).
- Directory-listing prompt -> `bash` (2 steps, 4,665 tokens).

No prompt leaked toward the more general `bash` tool when a focused tool was
appropriate.

### Conclusion

Descriptions are part of the model-facing routing API, not decorative
documentation. The repeated negative guidance is justified because the general
shell tool overlaps every narrower capability. Structural tests now prevent a
new tool from silently omitting any of the five contract sections; behavioral
routing still requires model-level evaluation.

## Experiment 6: Dynamic system prompt and verification contract

### Hypothesis

A typed, pure prompt builder makes agent behavior depend explicitly on runtime
state and makes critical instructions testable. A verification section should
reduce unsupported claims by requiring tool evidence and scoped reporting.

### Mechanism

`buildSystemPrompt(context)` now composes Agency, Guardrails, and Verification
sections from the working directory, sandbox type, actual tool names, and
runtime-specific verification guidance. Git branch and `AGENTS.md` project
context are optional sections. The verification contract distinguishes passed,
failed, blocked, unavailable, and timed-out checks and prohibits blanket success
claims without successful tool results.

### Observation

The behavioral run used the minimal sequence `readFile`, `edit`, `bash` and
selected the documented `js-exec /workspace/math.js` verifier directly. It did
not first attempt the unavailable `node` command. The final report named the
exact command, quoted the observed stdout (`clamp test passed`), reported exit
code 0, and scoped its claim to the built-in self-test. The run finished in four
steps using 11,921 tokens.

### Conclusion

Dynamic prompt construction makes runtime differences explicit and testable;
the same builder can later receive a reduced tool list for a subagent or
project-specific `AGENTS.md` context. Verification prompting does not prove
correctness by itself, but it improves claim discipline: successful reports
must be grounded in actual tool results, while blocked or unavailable checks
must remain visible.

## Experiment 7: Project context from AGENTS.md

### Hypothesis

Project-specific facts should come from the workspace rather than accumulating
in the generic harness prompt. Discovering `AGENTS.md` at startup makes those
instructions consistently available without requiring the model to choose a
retrieval tool first.

### Mechanism

The harness checks `/workspace/AGENTS.md` through the active sandbox backend,
loads non-empty content up to 8,000 characters, and passes it to
`buildSystemPrompt` as `projectContext`. Trace metadata records presence and
size without duplicating the content. The base prompt remains valid when the
file is absent.

### Observation

The trace recorded 490 project-context characters loaded. Asked for the project
codename and verification command, the agent answered `Pocket Harness` and
`js-exec /workspace/math.js` in one model step with zero tool calls. Those facts
were available before action selection because the harness injected them into
the system prompt.

### Conclusion

`AGENTS.md` is passive, project-owned configuration for facts that should affect
every step. It removes a retrieval decision from the model and keeps the generic
harness portable. Context still has a recurring token cost, so it should remain
concise; larger documentation belongs behind search and read tools.

## Experiment 8: Sandbox abstraction

### Hypothesis

Tools should depend on execution capabilities rather than the `just-bash`
library. A small async interface should allow backend replacement without
changing tool schemas, routing descriptions, or agent configuration.

### Mechanism

`Sandbox` defines backend identity, working directory, async read, write,
existence, command execution, and cleanup, with optional expiry and snapshot
capabilities for future cloud implementations. The `just-bash` adapter owns all
library-specific setup. A factory selects the backend through `SANDBOX`, tools
and project-context discovery accept only the interface, and lifecycle hooks
bracket each CLI run with cleanup in `finally`.

### Observation

After refactoring, a known-file prompt still routed to `readFile` and returned
the same first line from `math.js` in two model steps. The persisted event order
was `sandbox_started`, agent events, `run_finished`, then `sandbox_stopping`.
Fourteen tests pass, including backend selection, interface-level reads and
writes, unknown-backend rejection, and existing tool behavior. Neither
`tools.ts` nor project-context discovery imports `just-bash`, Node filesystem,
or child-process APIs.

### Conclusion

The abstraction boundary now sits below tools and project discovery. Backend
details are isolated in the adapter, while identity and lifecycle remain visible
to the harness. We intentionally did not add a local backend: the current
command policy and verification contract are designed for a disposable virtual
filesystem, and exposing host execution would require a separate trust model.
Cloud expiry and snapshots remain optional interface capabilities rather than
fake methods on simpler backends.

## Experiment 9: Subagent delegation

### Hypothesis

Delegation should reduce parent-context load by moving bounded research or
focused implementation into separate agent loops. The parent should keep
architectural decisions and user questions, while subagents return compact
summaries.

### Mechanism

The parent now exposes a `task` tool. It can route to:

- `explorer`: read-only investigation with `readFile`, `grep`, and read-only
  `bash`.
- `executor`: focused implementation with `readFile`, `grep`, `writeFile`,
  `edit`, and `bash`.

Each subagent is a fresh `ToolLoopAgent` with its own tool set, step cap,
timeouts, and trace events. The parent can configure separate OpenRouter model
IDs with `OPENROUTER_EXPLORER_MODEL` and `OPENROUTER_EXECUTOR_MODEL`, both
falling back to `OPENROUTER_MODEL`.

### Observation

Delegation worked for narrow tasks:

- Explorer found `clamp` references with `grep` and `readFile`.
- Executor fixed `/workspace/calculator.js`, ran
  `js-exec /workspace/calculator.js`, and returned exit code 0.
- The trace showed the nested sequence:
  `task -> executor -> readFile -> edit -> bash`.

Several harness defects appeared under real usage:

- Parent output sometimes stopped immediately after a `task` tool result.
  The subagent had completed, but the terminal looked like nothing happened.
- Tool markers printed to stderr could appear after stdout final text, making
  ordering misleading.
- Parent cancellation was not propagated into nested subagent runs. This could
  let a subagent keep spending model/tool time after the parent was aborted.
- Broad explorer prompts such as "explore the entire workspace" often gathered
  enough evidence, then timed out while composing the final summary.
- Executor subagents could time out before their first tool call when asked to
  synthesize a larger new file.

### Conclusion

Delegation is a harness boundary, not just a prompt pattern. A `task` tool must
handle lifecycle, cancellation, tracing, and terminal UX explicitly.

The fixes were:

- Store the latest delegation result and print a fallback if the parent
  produces no post-tool text.
- Trace parent `tool_execution_finished` events.
- Move `[tool]` markers to stdout for stable ordering.
- Pass the parent tool-call `abortSignal` into `runSubagent` and
  `agent.generate`.
- Add deterministic fallbacks for broad workspace exploration and the repeated
  `/workspace/auth.js` fixture creation path.

The main lesson is that delegation adds new failure surfaces: a child can
succeed while the parent fails to continue, or a child can fail after gathering
useful evidence. The harness should preserve and surface child results instead
of depending on one more model step to explain them.

## Experiment 10: Human in the loop

### Hypothesis

For materially ambiguous tasks, the harness should ask one structured question,
receive the user's choice, then continue the same run. The model should not
guess architecture, storage, authentication style, or other decisions that
change the result.

### Mechanism

The parent tool set now includes `askUser`. It accepts one question and 2-4
mutually exclusive options. In an interactive terminal, the CLI prints a
numbered prompt and waits for a numeric choice. In non-interactive runs,
`HARNESS_ASK_USER_CHOICE=1` can supply the selected option for smoke tests.

`askUser` traces:

- `ask_user_started`
- `ask_user_answered`
- `ask_user_unanswered`

The system prompt now includes a Handling Ambiguity section:

1. Search first so the question is informed.
2. Ask one structured question.
3. After the user answers, act on the selected option.

### Observation

The narrow smoke test worked:

```powershell
$env:HARNESS_ASK_USER_CHOICE="2"
npm run agent -- "Use askUser to ask which fixture to inspect next. Options should be calculator.js and math.js. After the answer, report only the selected option. Do not modify files."
```

The model called `askUser` and returned `math.js`.

The broader prompt exposed important edge cases:

```powershell
npm run agent -- "Add authentication to this project"
```

The model correctly identified ambiguity and asked which authentication
fixture to create. However, several continuation failures appeared:

- After the user selected an option, the model sometimes stopped with no
  post-answer action.
- Sometimes it produced only prose such as "I'll create auth.js" but did not
  call `writeFile`.
- Sometimes it used unavailable runtime features such as `require("crypto")`
  despite the virtual workspace constraints.
- Sometimes it created a deliberately failing fixture because existing sample
  files contain deliberate bugs, even though the user asked to add a feature,
  not create a failing exercise.

### Conclusion

Human-in-the-loop is not finished when the answer is collected. The harness
must make the post-answer continuation reliable.

The fixes were:

- `askUser` returns a tool result that explicitly says to continue with the
  selected answer.
- The CLI tracks when `askUser` was answered and applies stricter post-answer
  instructions.
- Parent `maxOutputTokens` was raised because the post-answer step was hitting
  length limits while planning.
- If the user answered but no action tool ran afterward, the CLI automatically
  delegates the selected implementation to `task/executor`.
- If `auth.js` verification fails due to unavailable `crypto`, or an auth
  fixture fails verification, the harness can repair it with a plain-JavaScript
  deterministic fixture.
- The system and executor prompts now state that new fixtures should verify
  successfully unless the user explicitly asks for a failing learning fixture.

The final verified behavior for the authentication scenario created
`/workspace/auth.js` and ran:

```text
js-exec /workspace/auth.js
```

with:

```text
stdout: auth test passed
stderr: empty
exit code: 0
```

The main lesson is that HITL creates a two-phase control problem: question
selection and answer continuation. A cheap model may handle the question but
stall or drift after the answer, so the harness needs continuation guards,
fallbacks, and verification repair paths.
