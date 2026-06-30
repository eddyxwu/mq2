# MiniQualia

A working prototype of [Quadrillion Labs' **Qualia**](https://quadrillion.io/) — *"a coding agent for researchers"* — built as a VS Code extension. MiniQualia is an **agentic research IDE layer**: you chat with an agent that works in your real workspace and a Jupyter notebook, reads and edits files, runs the shell, writes and executes code cells, organizes work into a **task DAG**, captures **findings (claims) with provenance**, passes **Q_VARS** between tasks, follows **rules** and **skills**, and can run **autonomously**.

It runs natively inside VS Code OSS and is powered by Claude (you supply an Anthropic API key). Closely modeled on the [Qualia docs](https://docs.quadrillion.io/).

## What it does (and where it maps to Qualia)

| Qualia concept ([docs](https://docs.quadrillion.io/)) | MiniQualia |
| --- | --- |
| **Chat & AI** — *"every action appears as a notebook cell you can inspect"* | Agentic chat in the secondary side bar; the agent uses tools and streams its reasoning (`src/llm/agent.ts`) |
| **Workspace tools** (files, shell, search) | `read_file`, `list_dir`, `grep`, `write_file`, `edit_file`, `run_command` over the real project (`src/workspace.ts`) |
| **Notebooks** | `run_code` appends + executes a cell with the kernel and returns output; `add_markdown` (`src/notebook.ts`) |
| **Tasks** — DAG, statuses incl. **failed**, blocking | LLM-planned DAG; tasks run in parallel waves and **fail** on cell errors; `set_task_status` (`src/agentRunner.ts`) |
| **Agents** — parallel, independence | Agents own tasks and fan out concurrently; **independence** low→infinity drives behavior |
| **Knowledge** — claims, high-level, validation, graph | A searchable/filterable/sortable **Knowledge panel** of claims (notebook-captured/synthesized) with multi/claim links, **Validate / Validate upstream**, high-level claims injected into context, **Import Knowledge**, and a **claim graph** (`src/knowledge.ts`, `views/knowledgeViewProvider.ts`) |
| **Q_VARS** — pass variables between tasks | A file-backed `Q_VARS.get(task_ids=[...])` shim is injected into the kernel; captures persist to `.miniqualia/qvars.json` |
| **Rules** — CLAUDE.md / AGENTS.md | Workspace `CLAUDE.md`, `AGENTS.md`, `MINIQUALIA.md`, and `.miniqualia/rules/*.md` are injected; `@rule:name` (`src/context.ts`) |
| **Skills** — `/skill`, importable | Built-in + `.claude/skills`, `.claude/commands`, Cursor skills; `/skill` autocomplete in chat; agent auto-invokes (`src/context.ts`) |
| **Autonomous Mode** — Infinity + Slack | Independence = Infinity runs without asking; posts progress to a Slack webhook if configured |
| **Writeups** | Sourced Markdown writeup with the task graph, findings, and measured Q_VARS (`src/writeup.ts`) |
| **Model selection** | Model + independence pickers in the chat header; `miniQualia.model` setting |

Built on the Anthropic Messages API via `fetch` (no bundled SDK). Default model **Claude Opus 4.8**.

### Product polish

Markdown-rendered chat with **folded, expandable tool output**; a **Stop** button (cancels the run and any shell command); **API retry/backoff**; a live **token-usage** readout; a **persisted transcript** (survives reloads); **command approval + allowlist** (the agent asks before running shell commands unless independence is high/infinity); a welcoming empty state with example prompts; model + independence pickers and slash-skill autocomplete.

## Run it

MiniQualia lives under `extensions/mini-qualia`, so VS Code OSS from source loads it automatically.

```bash
cd /Users/eddywu/Projects/mq2
npm run compile-client && ./scripts/code.sh
# rebuild just this extension after edits:
node_modules/.bin/tsc -p extensions/mini-qualia/tsconfig.json
```

**To use the agent:**
1. **Open a folder** (your real project).
2. Run **MiniQualia: Set Anthropic API Key** (stored in SecretStorage), or set `ANTHROPIC_API_KEY`.
3. Select a **Python/Jupyter kernel** on `analysis.ipynb` so the agent's cells run and capture measured results (without a kernel, cells are added but not executed, and findings are synthesized).
4. Open the **MiniQualia Chat** panel (secondary side bar) and talk to it.

### Try (like the Qualia demo)

- *"Explore this codebase and tell me what it does. Set up a venv, install deps, and run the tests."* → the agent greps/reads files, runs shell commands (folded as "Ran N tools"), writes notebook cells, and reports back.
- *"Compare three models on the iris dataset, pick the best, and write it up."* → plans a DAG, runs tasks in parallel, captures a high-level finding with the measured accuracy, exports the writeup.
- `/eda-pipeline run EDA on data.csv` → invokes a skill. Put an `MINIQUALIA.md`/`CLAUDE.md` in the repo to set persistent rules.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `miniQualia.model` | `claude-opus-4-8` | Model (also `claude-sonnet-4-6`, `claude-haiku-4-5`) |
| `miniQualia.independence` | `high` | `low`/`medium`/`high`/`infinity` — how much the agent asks vs. assumes |
| `miniQualia.curiosity` | `medium` | How far the agent explores beyond the request |
| `miniQualia.planner` | `auto` | LLM planner when a key is set, else deterministic |
| `miniQualia.enableNotebookExecution` | `true` | Execute cells with the kernel to capture measured results |
| `miniQualia.maxParallelAgents` | `3` | Concurrency for parallel task waves |
| `miniQualia.allowShellCommands` | `true` | Allow the `run_command` tool |
| `miniQualia.slackWebhookUrl` | `""` | Slack webhook for Infinity-independence autonomous updates |

## Commands

`New Research Session` · `Open Chat` · `Plan Research Tasks` · `Run Next Task` · `Run Ready Tasks (Parallel)` · `Capture Finding` · `Open Task Graph` · `Export Writeup` · `Run Autonomously (Infinity)` · `Import Skills (Claude Code / Cursor)` · `Select Model` · `Set/Clear Anthropic API Key` · `Reset Demo State`.

## Architecture

```
src/
  extension.ts      activation: store, tree views, chat view, planner factory, commands
  model.ts          data model (tasks/agents/findings + qvars, high-level, code)
  storage.ts        .miniqualia/state.json persistence
  core.ts           shared session/plan logic
  planner.ts        deterministic + LLM planners (DAG + per-task code)
  notebook.ts       create/run cells, Q_VARS shim, capture output
  agentRunner.ts    runTask pipeline, parallel waves, failures, findings
  writeup.ts        findings + Markdown writeup
  workspace.ts      file + shell tools (read/list/grep/write/edit/run)
  context.ts        rules + skills loading/injection
  commands.ts       command handlers
  llm/
    anthropicClient.ts  Messages API (create + stream + tool use)
    apiKey.ts           SecretStorage key
    agent.ts            agentic tool loop (workspace + notebook + research)
  views/            Agents/Tasks/Findings/Skills trees + chat WebviewView
  webview/          task-graph panel
media/              chat.css, chat.js
```

## Honest limitations vs. real Qualia

- **One shared kernel**: cell execution is serialized; parallelism is at the agent/orchestration layer (not per-agent kernels).
- **No real Slack/MCP/data-warehouse integrations** beyond an optional Slack webhook; web search is not wired.
- **Q_VARS** is file-backed (`.miniqualia/qvars.json`) rather than a live kernel-API channel, and exported notebooks don't yet substitute `Q_VARS.get()` with literals.
- **Agents** are task owners with shared history rather than fully independent per-agent chat sessions.
- It's a side-panel extension, not a standalone forked IDE; it doesn't replace the editor/terminal as a product.
- Findings fall back to `synthesized` (clearly marked) when no kernel is available.
```
