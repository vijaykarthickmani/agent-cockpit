# Agent Cockpit — VS Code Extension

Run and switch between interactive CLI coding agents (**Claude Code**, **Codex CLI**, **Gemini CLI**, **PowerShell**) as full-height VS Code Editor Tabs or Panel terminals.

## Key Features
- **Quick-Spawn CLI Presets & Custom Commands**: Launch `claude`, `codex`, `gemini`, or custom commands pointed at any working directory (`cwd`).
- **Full-Height Editor Tab or Bottom Panel Placement**: Toggle between opening agent terminals as full-height Editor Tabs side-by-side with your code or in the Bottom Terminal Panel.
- **Isolated Git Worktree Spawner**: Check *"Isolate in new Git Worktree"* to automatically run `git worktree add -b agent/<task>` and start the agent inside a dedicated worktree folder.
- **1-Click `@file:line` Context Injection (`Ctrl+Alt+S`)**: Highlight code in any editor and press `Ctrl+Alt+S` (or right-click → *Agent Cockpit: Send @file:line Selection to Active Agent*) to insert `@path/to/file.ts:10-25` into the active agent's terminal.
- **Live Git Status & Diff Viewer**: Inspect modified/untracked files in the active session's `cwd`, open VS Code's native side-by-side Git diff in one click, or `@File` mention them directly into the terminal.
- **Handoff Scratchpad (`.agent/handoff.md`)**: Save and send task handoff context between agents.
