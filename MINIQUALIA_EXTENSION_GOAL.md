# MiniQualia Extension Goal

## Context

You are working in a fork of VS Code OSS at `/Users/eddywu/Projects/mq2`.

The goal is to build a one-day prototype called **MiniQualia** inspired by Quadrillion Labs' Qualia:

- Product site: https://quadrillion.io/
- Download page: https://quadrillion.io/download
- Docs: https://docs.quadrillion.io/

Qualia is positioned as a native desktop research agent that works with notebooks, runs experiments, organizes task graphs, tracks findings with provenance, supports parallel agents, skills, rules, MCP integrations, and autonomous updates.

This prototype should not attempt to reproduce Quadrillion's proprietary system. It should demonstrate that the developer understands the product architecture: notebooks as the source of truth, agents as task workers, tasks as a DAG, and findings as auditable claims linked back to evidence.

## Chosen Approach

Build MiniQualia as a **VS Code extension** running inside the VS Code OSS fork.

Do not modify core `src/vs/workbench` code unless absolutely necessary. Use the VS Code extension API first:

- Notebook APIs for `.ipynb` creation and editing.
- Tree views for Agents, Tasks, Findings, and Skills.
- Webviews for chat and task graph visualization.
- Terminal APIs for running local commands.
- Workspace storage or a `.miniqualia/state.json` file for project state.

This approach is fastest for a one-day build and still feels native because it runs inside the OSS Electron workbench.

## Product Goal

Create a compelling prototype where a user can:

1. Start a new research session.
2. Open or create a Jupyter notebook.
3. Ask a research question in a MiniQualia chat panel.
4. Generate a task DAG from that question.
5. Run tasks through local "agents" that append notebook cells.
6. Capture findings from task outputs or summaries.
7. Export a sourced Markdown writeup.

The expected demo should feel like:

> "I asked MiniQualia to compare three models on a dataset. It planned the work, created notebook cells, tracked tasks, captured findings with links to evidence, and exported a short research writeup."

## Non-Goals

Do not spend the day on these:

- Implementing a full Jupyter kernel protocol client.
- Building a full LLM agent runtime.
- Packaging a signed native app installer.
- Rebranding the whole VS Code product.
- Deep workbench patches.
- Real Slack integration.
- Real Snowflake, Google Drive, arXiv, or MCP integrations.
- Perfect visual design.

It is acceptable to simulate or stub advanced features as long as the UI and data model make the intended architecture clear.

## Recommended File Layout

Create a new extension in the repo:

```text
extensions/mini-qualia/
  package.json
  tsconfig.json
  src/
    extension.ts
    commands.ts
    model.ts
    storage.ts
    planner.ts
    agentRunner.ts
    notebook.ts
    writeup.ts
    views/
      agentsView.ts
      tasksView.ts
      findingsView.ts
      skillsView.ts
    webview/
      chatPanel.ts
      taskGraphPanel.ts
      media/
        chat.css
        chat.js
  README.md
```

If adding it under `extensions/` is too slow because of repo build plumbing, create it at:

```text
miniqualia-extension/
```

Then launch with `--extensionDevelopmentPath`.

Prefer the faster path if build integration becomes a distraction.

## Development Launch Strategy

First make sure the VS Code OSS client can launch:

```bash
cd /Users/eddywu/Projects/mq2
npm run compile-client
./scripts/code.sh
```

If the full `npm run compile` fails because of `extensions/copilot` dependency issues, do not block on that. MiniQualia can be developed and launched with the client build only.

For extension development, prefer:

```bash
cd /Users/eddywu/Projects/mq2
./scripts/code.sh --extensionDevelopmentPath=/Users/eddywu/Projects/mq2/extensions/mini-qualia
```

If the extension lives outside `extensions/`, update the path accordingly.

## Data Model

Implement a small typed model in `src/model.ts`.

```ts
export type TaskStatus =
	| 'planned'
	| 'in_progress'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'paused_by_user';

export interface MiniQualiaProject {
	id: string;
	name: string;
	notebookUri?: string;
	createdAt: string;
	updatedAt: string;
	agents: MiniQualiaAgent[];
	tasks: MiniQualiaTask[];
	findings: MiniQualiaFinding[];
	skills: MiniQualiaSkill[];
}

export interface MiniQualiaAgent {
	id: string;
	name: string;
	status: 'idle' | 'working' | 'blocked' | 'done';
	independence: 'low' | 'medium' | 'high' | 'infinity';
	taskIds: string[];
}

export interface MiniQualiaTask {
	id: string;
	title: string;
	objective: string;
	status: TaskStatus;
	dependencies: string[];
	assignedAgentId: string;
	requiredVars?: string[];
	resultFindingIds?: string[];
	createdAt: string;
	updatedAt: string;
}

export interface MiniQualiaFinding {
	id: string;
	kind: 'notebook-captured' | 'synthesized';
	claim: string;
	summary?: string;
	taskId?: string;
	source: MiniQualiaEvidenceSource;
	createdAt: string;
}

export interface MiniQualiaEvidenceSource {
	type: 'notebook-cell' | 'file' | 'terminal' | 'manual';
	uri?: string;
	cellIndex?: number;
	cellId?: string;
	command?: string;
}

export interface MiniQualiaSkill {
	id: string;
	name: string;
	slashCommand: string;
	description: string;
	template: string;
}
```

Persist this state either in:

```text
.miniqualia/state.json
```

or in `context.workspaceState`.

Prefer `.miniqualia/state.json` because it is visible and easy to explain in an interview.

## Required Commands

Contribute these commands in `package.json`:

- `miniQualia.newResearchSession`
- `miniQualia.openChat`
- `miniQualia.planResearchTasks`
- `miniQualia.runNextTask`
- `miniQualia.captureFinding`
- `miniQualia.openTaskGraph`
- `miniQualia.exportWriteup`
- `miniQualia.resetDemoState`

Display titles:

- `MiniQualia: New Research Session`
- `MiniQualia: Open Chat`
- `MiniQualia: Plan Research Tasks`
- `MiniQualia: Run Next Task`
- `MiniQualia: Capture Finding`
- `MiniQualia: Open Task Graph`
- `MiniQualia: Export Writeup`
- `MiniQualia: Reset Demo State`

## Required Views

Create an activity bar container named `MiniQualia`.

Views:

1. **Agents**
   - Shows agent cards/tree items.
   - Example labels:
     - `A-1 Research Lead - idle`
     - `A-2 Modeling Agent - working`
   - Tooltip should include independence level and assigned task count.

2. **Tasks**
   - Shows tasks grouped by status.
   - Include task ID, title, status, assignment, and dependency list.
   - Use codicons or status text for planned/in progress/completed/failed.

3. **Findings**
   - Shows claims like `K-1 Best model was logistic regression`.
   - Selecting a finding should open the source notebook/file if available.

4. **Skills**
   - Shows slash commands:
     - `/clean-data`
     - `/eda-pipeline`
     - `/stat-tests`
     - `/plot-styles`
     - `/literature-review`
   - Selecting a skill should insert or preview its template in chat.

## Chat Panel

Implement a webview panel or webview view called `MiniQualia Chat`.

It should have:

- A textarea for a research prompt.
- Buttons:
  - `Plan Tasks`
  - `Run Next Task`
  - `Capture Finding`
  - `Export Writeup`
- A simple transcript area.
- A project summary:
  - current notebook
  - task counts
  - findings count
  - active agent

The panel does not need to call a real LLM. For the demo, deterministic planning is more reliable.

If an API key is available later, make the planner pluggable:

```ts
interface ResearchPlanner {
	plan(prompt: string): Promise<MiniQualiaTask[]>;
}
```

Default implementation: deterministic templates.

## Planner Behavior

In `planner.ts`, map a research prompt into a small DAG.

For the demo prompt:

> Compare three models on the iris dataset, identify the best model, explain errors, and produce a short writeup with evidence.

Generate:

```text
T-1 Load and inspect the dataset
T-2 Train baseline logistic regression
T-3 Train random forest
T-4 Train support vector machine
T-5 Compare model metrics and choose best approach
T-6 Produce sourced research writeup
```

Dependencies:

```text
T-2 depends on T-1
T-3 depends on T-1
T-4 depends on T-1
T-5 depends on T-2, T-3, T-4
T-6 depends on T-5
```

Agents:

```text
A-1 Research Lead: T-1, T-5, T-6
A-2 Modeling Agent: T-2, T-3
A-3 Modeling Agent: T-4
```

For other prompts, still generate a generic research DAG:

```text
T-1 Understand data and objective
T-2 Clean and prepare data
T-3 Run analysis or experiment
T-4 Validate and compare results
T-5 Summarize findings
```

## Notebook Behavior

Implement `notebook.ts`.

Capabilities:

1. Create `analysis.ipynb` in the workspace if none exists.
2. Open the notebook in the VS Code notebook editor.
3. Append markdown and Python code cells for each task.
4. Add task IDs in markdown headings so provenance is visible.

Minimum viable notebook creation can write raw `.ipynb` JSON to disk:

```json
{
  "cells": [],
  "metadata": {
    "kernelspec": {
      "display_name": "Python 3",
      "language": "python",
      "name": "python3"
    },
    "language_info": {
      "name": "python",
      "pygments_lexer": "ipython3"
    }
  },
  "nbformat": 4,
  "nbformat_minor": 5
}
```

Then use `vscode.commands.executeCommand('vscode.open', uri)` to open it.

For appending cells, either:

- Use VS Code notebook workspace edits if straightforward.
- Or edit the `.ipynb` JSON directly and reopen/reveal the notebook.

For a one-day prototype, direct JSON manipulation is acceptable if it is reliable and scoped to notebooks created by MiniQualia.

## Demo Notebook Cells

Use Python code that is likely to work in a standard data science environment:

```python
from sklearn.datasets import load_iris
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.svm import SVC
from sklearn.metrics import accuracy_score, classification_report
import pandas as pd

iris = load_iris(as_frame=True)
X = iris.data
y = iris.target
df = iris.frame
df.head()
```

Model cells:

```python
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.25, random_state=42, stratify=y
)

models = {
    "logistic_regression": LogisticRegression(max_iter=1000),
    "random_forest": RandomForestClassifier(n_estimators=100, random_state=42),
    "svm": SVC(kernel="rbf", probability=True, random_state=42),
}

results = {}
for name, model in models.items():
    model.fit(X_train, y_train)
    preds = model.predict(X_test)
    results[name] = accuracy_score(y_test, preds)

pd.DataFrame(
    [{"model": name, "accuracy": score} for name, score in results.items()]
).sort_values("accuracy", ascending=False)
```

Comparison cell:

```python
best_model = max(results, key=results.get)
best_accuracy = results[best_model]
best_model, best_accuracy
```

These variables become the MiniQualia equivalent of Q_VARS:

- `results`
- `best_model`
- `best_accuracy`

Do not implement real automatic kernel namespace capture unless time remains. Instead, capture a finding from the generated comparison cell and describe the Q_VARS analogue in the README.

## Agent Runner

Implement `agentRunner.ts`.

The runner should:

1. Find the next unblocked planned task.
2. Mark it `in_progress`.
3. Append task-specific notebook cells.
4. Optionally create/show a terminal named `MiniQualia Agent`.
5. Mark the task `completed`.
6. Create a synthesized finding when appropriate.

Unblocked means:

```ts
task.dependencies.every(depId => taskById(depId)?.status === 'completed')
```

Task-specific behavior:

- `T-1`: append dataset loading and inspection cells.
- `T-2`, `T-3`, `T-4`: append model training cells or one combined model cell.
- `T-5`: append comparison cell and create finding `K-1`.
- `T-6`: export writeup and create finding `K-2`.

For visual drama, briefly show `in_progress` before completing. Do not add artificial long waits.

## Findings And Provenance

Implement `captureFinding` in `commands.ts` or `writeup.ts`.

Minimum finding fields:

- ID: `K-1`, `K-2`, etc.
- Claim text.
- Source type.
- Notebook URI.
- Cell index if known.
- Task ID.
- Timestamp.

Example claim:

```text
K-1: SVM achieved the highest held-out accuracy in the demo iris comparison.
```

If actual execution output is unavailable, the finding can be a synthesized claim based on the generated notebook code and task summary. Make that clear in the UI by setting `kind: 'synthesized'`.

The interview explanation should be:

> In production, notebook-captured findings would be validated against actual kernel outputs. In this prototype, synthesized findings demonstrate the provenance data model and UI.

## Task Graph Webview

Implement `taskGraphPanel.ts`.

The simplest acceptable version:

- Render tasks as cards in dependency order.
- Show arrows/dependency text.
- Show status badges.
- Show assigned agent.

Do not use heavyweight graph libraries unless already available. Plain HTML/CSS is fine.

Example card:

```text
T-5 Compare model metrics
Status: planned
Agent: A-1 Research Lead
Depends on: T-2, T-3, T-4
```

## Writeup Export

Implement `exportWriteup` to write:

```text
miniqualia-writeup.md
```

Content structure:

```markdown
# MiniQualia Research Writeup

## Objective

...

## Task Graph

...

## Findings

### K-1 ...

Source: analysis.ipynb, cell ...

## Notebook

analysis.ipynb

## Notes

This is a MiniQualia prototype built as a VS Code OSS extension.
```

Open the Markdown file after writing it.

## README

Add `extensions/mini-qualia/README.md`.

Include:

- What MiniQualia is.
- How it maps to Qualia concepts:
  - Chat -> chat webview
  - Notebooks -> VS Code `.ipynb`
  - Tasks -> local DAG
  - Agents -> task assignees/runners
  - Knowledge -> findings store
  - Q_VARS -> required variable names and provenance model
  - Skills -> slash-command templates
  - Autonomous mode -> simulated Infinity independence/log updates
- How to run it.
- Demo script.
- Known limitations.
- What would be built next with more time.

## Package Contributions

`package.json` should contribute:

- Commands.
- Activity bar container.
- Views.
- Activation events for the MiniQualia commands/views.

Use a simple icon if necessary. Codicons are enough for one day.

## Acceptance Criteria

The prototype is done when all of these work:

1. `MiniQualia: New Research Session` creates or opens `analysis.ipynb`.
2. `MiniQualia: Open Chat` opens a native-looking chat webview.
3. Entering the iris demo prompt and clicking `Plan Tasks` creates a six-task DAG.
4. Agents view shows three agents.
5. Tasks view shows task statuses and dependencies.
6. `Run Next Task` advances through tasks and appends notebook cells.
7. At least one finding appears in the Findings view with provenance to the notebook.
8. `Open Task Graph` shows a readable dependency visualization.
9. `Export Writeup` writes and opens `miniqualia-writeup.md`.
10. README contains a clear explanation and demo instructions.

## Stretch Goals

Only attempt these after the acceptance criteria:

1. Run selected notebook cells through VS Code's notebook execution command if a kernel is available.
2. Add an optional LLM planner provider using `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
3. Add a local Slack-style update transcript for Infinity independence.
4. Add `Q_VARS.get("best_model")` replacement in exported notebooks.
5. Bundle MiniQualia as a built-in extension in the VS Code fork.
6. Add branding in product name/icon/welcome page.

## Demo Script

Use this exact sequence for the interview demo:

1. Launch Code OSS with MiniQualia:

   ```bash
   cd /Users/eddywu/Projects/mq2
   ./scripts/code.sh --extensionDevelopmentPath=/Users/eddywu/Projects/mq2/extensions/mini-qualia
   ```

2. Run command: `MiniQualia: New Research Session`.
3. Open the MiniQualia activity bar.
4. Open chat and enter:

   ```text
   Compare three models on the iris dataset, identify the best model, explain errors, and produce a short writeup with evidence.
   ```

5. Click `Plan Tasks`.
6. Show the generated task DAG.
7. Click `Run Next Task` several times.
8. Show notebook cells being appended.
9. Show Findings view with claims and provenance.
10. Click `Export Writeup`.
11. Explain:

   ```text
   This is intentionally extension-first. VS Code OSS gives the native shell, notebooks, terminal, webviews, and extension model. MiniQualia adds the research-native layer: task DAGs, agent assignment, notebook-grounded execution, and findings with provenance.
   ```

## Implementation Order

Follow this order strictly:

1. Scaffold extension.
2. Add commands and activity bar views with static placeholder data.
3. Add persistent state.
4. Implement new research session and notebook creation.
5. Implement deterministic planner.
6. Wire planner to chat and views.
7. Implement agent runner and notebook cell append.
8. Implement findings.
9. Implement writeup export.
10. Add task graph webview.
11. Add README and demo polish.

Do not start with styling. Make the full flow work first.

## Time Budget

For a one-day build:

- 1 hour: launch/build sanity and extension scaffold.
- 2 hours: views, commands, state.
- 2 hours: notebook creation and cell append.
- 2 hours: planner and agent runner.
- 2 hours: findings and writeup.
- 1 hour: graph webview.
- 1 hour: README and demo script.
- 1 hour: buffer for bugs.

## Final Deliverables

At the end, the repository should contain:

- `extensions/mini-qualia/` extension source.
- A working MiniQualia launch path.
- `analysis.ipynb` generated during demo.
- `.miniqualia/state.json` generated during demo.
- `miniqualia-writeup.md` generated during demo.
- `extensions/mini-qualia/README.md` with demo instructions.

## Notes For Claude Code

Treat this file as the implementation goal.

Keep the implementation pragmatic. The prototype should impress by having a coherent end-to-end research workflow, not by being deeply complete.

When choosing between a reliable deterministic demo and a brittle LLM integration, choose the reliable deterministic demo.

When choosing between extension APIs and core VS Code workbench changes, choose extension APIs.

When unsure about exact notebook execution APIs, write valid `.ipynb` files and append cells directly. Notebook execution can remain a stretch goal.
