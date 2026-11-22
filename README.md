# Agent Cockpit

> A terminal-first multi-agent workspace for **VS Code** and **Antigravity IDE** — run, switch, organize, hand off, and schedule interactive CLI coding agents (`agy`, `claude`, `codex`, `gemini`, `powershell`, `cmd`) without wrapping them in chat bubbles.

[![Interactive Demo](https://img.shields.io/badge/Live%20Demo-docs%2Findex.html-3b82f6?style=flat-square)](docs/index.html)
[![Report Bug](https://img.shields.io/badge/Report%20a%20Bug-GitHub%20Issues-ef4444?style=flat-square)](https://github.com/vijaykarthick4588/agent-cockpit/issues/new?labels=bug&title=%5BBug%5D+)
[![Feature Request](https://img.shields.io/badge/Feature%20Request%20%2F%20Feedback-GitHub%20Issues-10b981?style=flat-square)](https://github.com/vijaykarthick4588/agent-cockpit/issues/new?labels=enhancement&title=%5BFeature%5D+)

---

## Why Agent Cockpit?

Modern CLI coding agents (`agy`, `claude`, `codex`, `gemini`) shine in a real interactive PTY/TUI — with arrow-key menus, `Shift+Tab` mode toggles, streaming diffs, and tool approval prompts. Agent Cockpit gives you a native VS Code sidebar to manage all your parallel agent terminals cleanly:

- **Auto-Detected Installed CLIs** — Scans your PC for installed CLIs (`agy`, `claude`, `codex`, `gemini`, `aider`, `powershell`, `cmd`) and lets you 1-click launch your last used CLI or pick another from the dropdown.
- **Pinned + Project-Grouped Conversations** — Pin important chats to the top; all other sessions are automatically grouped and sorted by project/folder name.
- **Explicit Resume / Stop Controls** — Clicking a paused session selects it to view its timeline without accidentally spawning a terminal; hover and click **`▶` Resume** or **`■` Stop** when you're ready.
- **1-Click Chat-to-Chat Handoff (`⇄`)** — Extracts recent user requests, assistant progress, and Git status from one chat's transcript (`agy` / `claude`), writes `.agent/handoff.md`, and sends it to any existing chat or a brand-new chat with your chosen CLI.
- **Native Expandable Chat Timeline** — A collapsible VS Code `Chat Timeline` panel (just like VS Code's built-in Outline/Timeline) listing every question asked in the selected chat, expandable to preview the AI's reply, with inline Copy and Re-ask actions.
- **In-IDE Automated Scheduled Jobs** — Schedule recurring CLI prompts or shell commands (*Every 5m / 15m / 30m / 1h*, *Daily*, or *Weekdays*) right inside the `Jobs` tab.
- **Highlight → Run or Send** — Highlight any command or text in a terminal or editor and press `Ctrl+Alt+R` (Run in Shell), `Ctrl+Alt+T` (Send to Terminal), or click the **`▶` / `>_`** icons in the terminal tab title bar.
- **MCP & Skills Discovery** — Live visibility into configured MCP servers and available Skills/Subagents in the workspace and plugins.
- **Zen Mode, Git Worktrees (`WT`), & Smart Chime** — Toggle redundant top editor tabs (`Zen`), spin up isolated Git worktrees (`WT`), and get a single subtle Web Audio chime when an agent finishes a turn.

---

## Supported CLIs (Works with Every CLI)

Agent Cockpit is **CLI-agnostic** — it auto-detects whichever CLIs are installed on your machine and supports full start, resume, Chat Timeline, and 1-Click Handoff across all major coding agents:

| CLI | Start | Exact Resume / Continue | Chat Timeline & Handoff |
| :--- | :--- | :--- | :---: |
| **Claude Code (`claude`)** | `claude --session-id "<uuid>"` | `claude --resume "<id>"` → `--continue` | Full transcript |
| **Antigravity (`agy`)** | `agy` | `agy --conversation "<id>"` → `--continue` | Full transcript |
| **Gemini CLI (`gemini`)** | `gemini --session-id "<uuid>"` | `gemini --resume "<id>"` → `--resume latest` | Full transcript |
| **Codex CLI (`codex`)** | `codex` | `codex resume "<id>"` → `resume --last` | Full transcript |
| **Aider (`aider`)** | `aider` | `aider --restore-chat-history` | `.aider.chat.history.md` |
| **PowerShell / CMD / Custom** | Runs any executable in saved `cwd` | Reopens in saved `cwd` | Workspace + Git handoff |

---

## Installation

### VS Code / Antigravity IDE Extension

```powershell
# Install in VS Code
code --install-extension .\vscode-extension\agent-cockpit-vscode-0.1.1.vsix --force

# Install in Antigravity IDE
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension .\vscode-extension\agent-cockpit-vscode-0.1.1.vsix --force
```

Then reload your window (`Ctrl+Shift+P` → **Developer: Reload Window**) and click the **Agent Cockpit** HUD icon in the Activity Bar.

---

## How to Use

1. **Launch an Agent**
   - Pick your workspace folder in the top bar (optional: toggle **`WT`** to isolate the next session in a new Git worktree).
   - Click **`+ New <CLI>`** to launch your last used CLI, or choose another installed CLI from the dropdown.
2. **Organize & Control Sessions**
   - **Click** a running session to focus its terminal tab; **click** a paused session to inspect its **Chat Timeline**.
   - **Hover** any session row for quick actions:
     - **`▶` / `■`** — Resume paused session or Stop running session (keeps history)
     - **`⇄`** — 1-Click Handoff to an existing chat or a new chat with a selected CLI
     - **Pin** — Pin/unpin to the top `PINNED` section
     - **Color** — Color-code the session dot
     - **Rename** — Inline rename (or double-click the title)
     - **`@`** — Inject `@file:line` from your active editor selection
     - **`×`** — Close and remove session
3. **Inspect Chat Timeline**
   - Expand **`Chat Timeline`** below `Cockpit Control` to browse every question asked in the selected chat and expand any turn to preview the AI's response.
4. **Run Highlighted Commands**
   - Highlight any command in a terminal or editor (hold `Shift` while dragging inside mouse-capturing TUIs) and press **`Ctrl+Alt+R`** or click **`▶`** in the terminal tab title bar to run it in Shell.
5. **Schedule Recurring Jobs**
   - Open the **`Jobs`** tab in the footer → click **`+ New Scheduled Job`** → set name, CLI, prompt/command, and schedule.

---

## Keyboard Shortcuts

| Shortcut (Windows/Linux) | Shortcut (macOS) | Action |
| :--- | :--- | :--- |
| `Ctrl+Alt+N` | `Cmd+Alt+N` | Launch New CLI Agent Session |
| `Ctrl+Alt+1` … `Ctrl+Alt+5` | `Cmd+Alt+1` … `Cmd+Alt+5` | Switch to Agent Session 1–5 |
| `Ctrl+Alt+R` | `Cmd+Alt+R` | Run Highlighted Command in Shell |
| `Ctrl+Alt+T` | `Cmd+Alt+T` | Send Highlighted Text to Active Terminal |
| `Ctrl+Alt+S` | `Cmd+Alt+S` | Send `@file:line` Selection to Active Agent (in Editor) |

---

## Interactive Demo Page

Open [docs/index.html](docs/index.html) directly in your browser (or enable **GitHub Pages** from `/docs` on `main` to publish it at `https://vijaykarthick4588.github.io/agent-cockpit/`).

---

## Feedback, Issues & Feature Requests

Found a bug or have an idea to make Agent Cockpit better?

- **Report a Bug**: [Create a Bug Ticket](https://github.com/vijaykarthick4588/agent-cockpit/issues/new?labels=bug&title=%5BBug%5D+)
- **Request a Feature / Feedback**: [Submit Feature Request](https://github.com/vijaykarthick4588/agent-cockpit/issues/new?labels=enhancement&title=%5BFeature%5D+)
- **Browse Open Issues**: [github.com/vijaykarthick4588/agent-cockpit/issues](https://github.com/vijaykarthick4588/agent-cockpit/issues)

---

## Building from Source

```powershell
cd vscode-extension
npm install
npm run compile
```
