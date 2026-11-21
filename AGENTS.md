# Agent Cockpit — Repository Guidelines

## What We Are Building
A standalone desktop terminal-first cockpit (**Tauri v2 + React + TypeScript + xterm.js + tauri-plugin-pty**) for running and switching between multiple interactive CLI coding agents (Claude Code, Codex CLI, Gemini CLI, shells) in a single workspace.

## Core Principles & Non-Negotiables
- **Preserve raw interactive TUI/PTY behavior**: Do NOT wrap CLI output in fake chat bubbles. Render raw ANSI/VT sequences through `xterm.js` backed by real OS pseudo-terminals (`tauri-plugin-pty`).
- **Persistent background sessions**: Keep inactive terminal sessions alive in the background (mounted and listening to PTY data) and re-fit/resize cleanly (`FitAddon` + `pty.resize()`) on tab switch or window resize.
- **Clean working directory (`cwd`) & worktree isolation**: Every session explicitly tracks its `id`, `title`, `command`, `args`, `cwd`, optional `worktreePath`, and runtime status (`working | idle | needs-input`).
- **Fast, minimal, keyboard-friendly UI**: Keep layout lean and dark-themed for daily use alongside a code editor, with `Ctrl/Cmd + 1..9` session switching and `Ctrl/Cmd + N` to open the new-session / custom-command + `cwd` picker modal.
- **Incremental vertical slices**: Avoid over-engineering abstractions before a feature is needed in the current phase.

## Directory Structure
```text
agent-cockpit/
├── AGENTS.md                  # Architecture invariants & repo rules for Antigravity
├── package.json               # Frontend dependencies & scripts
├── index.html                 # App entry HTML
├── vite.config.ts             # Vite config for Tauri v2 (port 1420)
├── tsconfig.json              # Strict TypeScript configuration
├── src/
│   ├── main.tsx               # React entry point
│   ├── App.tsx                # Cockpit layout, session switcher, & keyboard shortcuts
│   ├── App.css                # Minimal dark cockpit styles + xterm layout rules
│   ├── types/
│   │   └── session.ts         # Session, Preset, and RuntimeStatus types
│   └── components/
│       ├── TerminalPane.tsx   # xterm.js + FitAddon + tauri-plugin-pty lifecycle
│       └── NewSessionModal.tsx# Working directory (cwd) picker & custom command modal
└── src-tauri/
    ├── Cargo.toml             # Rust dependencies (tauri v2, tauri-plugin-pty, tauri-plugin-dialog)
    ├── build.rs               # Tauri build script
    ├── tauri.conf.json        # Tauri v2 configuration
    ├── capabilities/
    │   └── default.json       # Tauri v2 capabilities (core:default, pty:default, dialog:default)
    └── src/
        ├── main.rs            # Binary entry point
        └── lib.rs             # Tauri builder registering pty & dialog plugins + helper commands
```

## Build & Verification Commands
- **Install frontend dependencies**: `npm install`
- **Type-check & build frontend**: `npm run build`
- **Check Rust backend compilation**: `cargo check --manifest-path src-tauri/Cargo.toml`
- **Run desktop app in dev mode**: `npm run tauri dev`
