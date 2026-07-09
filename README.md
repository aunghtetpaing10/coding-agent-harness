# AI SDK Agent Harness Learning Project

This repository is a learning-oriented coding-agent harness built with the Vercel AI SDK. The point is not to ship a polished product. The point is to understand the moving parts behind an agent that can inspect files, choose tools, make changes, verify results, manage context, delegate to subagents, ask structured questions, and apply approval gates.

## What this project demonstrates

This harness demonstrates the core building blocks of an AI SDK agent system:

- Agent loops with `ToolLoopAgent`
- Typed tools with Zod schemas
- Tool descriptions as routing contracts
- File inspection, search, writes, exact edits, and constrained command execution
- Verification gates based on actual tool results
- Dynamic system prompt construction
- Project context loaded from `AGENTS.md`
- Context management with tool-output caps and message pruning
- Sandbox abstraction over the execution backend
- Subagent delegation with explorer and executor roles
- Human-in-the-loop structured questions
- Approval gates for command execution
- JSONL tracing for observability and debugging

## High-level architecture

```text
CLI task
  |
  v
src/cli.ts
  - loads env config
  - creates OpenRouter models
  - creates sandbox
  - loads AGENTS.md project context
  - builds tools
  - runs ToolLoopAgent
  - streams output
  - writes trace events
  |
  v
ToolLoopAgent
  |
  +-- readFile
  +-- grep
  +-- writeFile
  +-- edit
  +-- bash
  +-- askUser
  +-- task
        |
        +-- explorer subagent
        +-- executor subagent
```

The important separation is:

```text
Prompt      -> tells the model how to behave
Tools       -> define what actions the model can request
Approval    -> decides whether a command should pause before execution
Sandbox     -> enforces what can actually execute
Trace       -> records what happened
Tests       -> keep the harness behavior stable
```

## Main source files

| File | Purpose |
| --- | --- |
| [src/cli.ts](./src/cli.ts) | Entry point. Wires config, model, sandbox, tools, prompt, tracing, streaming, and fallback behavior. |
| [src/tools.ts](./src/tools.ts) | Defines the agent tools: `readFile`, `grep`, `writeFile`, `edit`, `bash`, `askUser`, and `task`. |
| [src/system.ts](./src/system.ts) | Builds the dynamic system prompt from runtime context. |
| [src/approval.ts](./src/approval.ts) | Defines simple approval-gate config for bash commands. |
| [src/sandbox.ts](./src/sandbox.ts) | Sandbox interface used by tools. |
| [src/sandbox-just-bash.ts](./src/sandbox-just-bash.ts) | `just-bash` sandbox adapter. |
| [src/sandbox-factory.ts](./src/sandbox-factory.ts) | Selects the sandbox backend from environment config. |
| [src/project-context.ts](./src/project-context.ts) | Loads project instructions from `/workspace/AGENTS.md`. |
| [src/trace.ts](./src/trace.ts) | Writes JSONL run traces into `.runs/`. |

## Requirements

- Node.js
- npm
- OpenRouter API key

The project uses OpenRouter through `@openrouter/ai-sdk-provider`. The default model is:

```text
deepseek/deepseek-v4-flash
```

You can change it with environment variables.

## Setup

Install dependencies:

```powershell
npm install
```

Create `.env`:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` and set:

```text
OPENROUTER_API_KEY=your_key_here
```

Do not commit `.env`.

## Running the agent

Basic command:

```powershell
npm run agent -- "Read /workspace/calculator.js and explain the bug."
```

Example implementation task:

```powershell
npm run agent -- "In /workspace/calculator.js, fix divide so divide(10, 2) equals 5, then run js-exec /workspace/calculator.js and report the result."
```

Example delegation task:

```powershell
npm run agent -- "Delegate to an executor: in /workspace/calculator.js, fix divide so divide(10, 2) equals 5, then run js-exec /workspace/calculator.js and report the result. Use the task tool."
```

Example human-in-the-loop task:

```powershell
npm run agent -- "Add authentication to this project"
```

If the model asks a structured question, choose the numbered option in the terminal.

For non-interactive testing, you can preselect an answer:

```powershell
$env:HARNESS_ASK_USER_CHOICE="1"
npm run agent -- "Add authentication to this project"
```

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | none | Required API key for OpenRouter. |
| `OPENROUTER_MODEL` | `deepseek/deepseek-v4-flash` | Parent agent model. |
| `OPENROUTER_EXPLORER_MODEL` | `OPENROUTER_MODEL` | Explorer subagent model. |
| `OPENROUTER_EXECUTOR_MODEL` | `OPENROUTER_MODEL` | Executor subagent model. |
| `SANDBOX` | `just-bash` | Sandbox backend. Currently only `just-bash` is implemented. |
| `HARNESS_CONTEXT_MODE` | `managed` | `managed` enables output caps and message pruning. `baseline` keeps more raw context. |
| `HARNESS_ASK_USER_CHOICE` | none | Optional numbered answer for non-interactive `askUser` runs. |
| `HARNESS_APPROVAL_MODE` | `interactive` | Approval-gate mode for bash commands. |
| `HARNESS_APPROVAL_TRUST` | none | Comma-separated trusted command prefixes for delegated approval mode. |

## Approval gates

Approval gates currently apply to the `bash` tool.

`HARNESS_APPROVAL_MODE` chooses the approval behavior:

| Mode | Meaning |
| --- | --- |
| `interactive` | Default. Known safe command prefixes pass; unknown commands are blocked as requiring approval. |
| `background` | Approval does not block commands. Useful for testing automation behavior. |
| `delegated` | Only commands matching trusted prefixes pass approval. |

`HARNESS_APPROVAL_TRUST` is only used in delegated mode.

Example:

```powershell
$env:HARNESS_APPROVAL_MODE="delegated"
$env:HARNESS_APPROVAL_TRUST="js-exec /workspace/math.js,ls"
npm run agent -- "Run js-exec /workspace/math.js"
```

Important distinction:

```text
Approval gate  -> should this command pause before execution?
Sandbox policy -> is this command actually allowed to execute?
```

For example, in `background` mode the approval gate may allow `node /workspace/math.js`, but the sandbox command policy still blocks it because this learning backend uses `js-exec`, not Node.

## Available tools

### `readFile`

Reads one known UTF-8 file from the virtual workspace.

Use it when the agent already knows the file path.

### `grep`

Searches for a literal string across workspace files.

Use it to locate unknown files, functions, imports, or error messages.

### `writeFile`

Creates or fully replaces one file in `/workspace`.

Use it for new files or complete replacement of tiny fixtures.

### `edit`

Replaces one exact, unique span in an existing file.

Use it for small targeted changes after reading the current file.

### `bash`

Runs allowlisted workspace commands.

The learning backend supports:

- `js-exec /workspace/<file>.js`
- read-only inspection commands such as `ls`, `tree`, `rg`, `cat`, `head`, `tail`, and `wc`

It intentionally does not support `node`, `npm`, package installation, network access, or destructive commands.

### `askUser`

Asks one structured multiple-choice question.

Use it when the task has materially different valid approaches and guessing would change the result.

### `task`

Delegates work to a subagent.

It supports two roles:

- `explorer`: read-only investigation
- `executor`: focused implementation plus verification

Delegation is useful for learning how parent and child agent loops interact, but it adds failure surfaces: timeouts, missing final summaries, cancellation propagation, and trust boundaries.

## Verification

Run type checking:

```powershell
npm run typecheck
```

Run tests:

```powershell
npm test
```

Expected result at the time this README was written:

```text
5 test files passed
25 tests passed
```

## Traces

Each agent run writes a JSONL trace under `.runs/`.

The trace records events such as:

- sandbox start/stop
- run start/finish
- context preparation
- tool calls
- tool results
- subagent starts/finishes/errors
- approval decisions
- askUser events

These traces are important because terminal output alone can be misleading. For example, a subagent may finish successfully while the parent model fails to produce final text. The trace shows what actually happened.

## Project context

The sandbox workspace includes an `AGENTS.md` fixture. It provides project-specific instructions such as:

- project codename
- fixture style
- verification command
- unavailable runtime features

The harness loads this into the dynamic system prompt before the first model step. That means the model can use project facts without spending a tool call to discover them.

## Context management

`HARNESS_CONTEXT_MODE=managed` is the default.

Managed mode:

- caps file-read output
- prunes stale reasoning and some older tool exchanges
- keeps important recent evidence

The point is not to minimize tokens at all costs. The point is to keep enough context for the task to succeed while avoiding unnecessary repeated input.

`HARNESS_CONTEXT_MODE=baseline` keeps more raw message history and is useful for comparison.

## Sandbox model

The current sandbox backend is `just-bash`.

The harness talks to it through the `Sandbox` interface rather than importing `just-bash` directly throughout the codebase. That keeps tool logic separate from backend details.

Current limitation:

```text
SANDBOX=just-bash
```

is the only implemented backend.

A real local filesystem backend or cloud sandbox would require a separate trust model. This project intentionally stops short of that because the learning goal is harness architecture, not production execution infrastructure.

## What this is not

This is not:

- a production coding agent
- a secure general-purpose shell runner
- a full cloud sandbox
- a dependency-installing project builder
- a polished developer product
- a benchmarked eval harness

It is a compact learning harness for studying the architecture and behavior of agent systems.
