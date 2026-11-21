"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const DEFAULT_PRESETS = [
    {
        id: "claude",
        label: "Claude Code",
        badge: "CC",
        command: "claude",
        args: [],
    },
    {
        id: "codex",
        label: "Codex CLI",
        badge: "CX",
        command: "codex",
        args: [],
    },
    {
        id: "gemini",
        label: "Gemini CLI",
        badge: "GM",
        command: "gemini",
        args: [],
    },
    {
        id: "powershell",
        label: "PowerShell",
        badge: "PS",
        command: "powershell.exe",
        args: ["-NoLogo"],
    },
];
function execGit(cwd, args) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)("git", args, { cwd, timeout: 6000 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr?.trim() || err.message));
                return;
            }
            resolve(stdout);
        });
    });
}
function findExecutableOnWindows(cmd) {
    const trimmed = cmd.trim();
    if (trimmed.toLowerCase() === "powershell.exe" ||
        trimmed.toLowerCase() === "powershell") {
        return { shellPath: "powershell.exe", shellArgs: ["-NoLogo"] };
    }
    if (trimmed.toLowerCase() === "cmd.exe" || trimmed.toLowerCase() === "cmd") {
        return { shellPath: "cmd.exe", shellArgs: [] };
    }
    // Launch interactive CLI agents inside PowerShell so PATH, .cmd wrappers (gemini.cmd, codex.cmd),
    // and post-exit shell inspection work seamlessly on Windows.
    return {
        shellPath: "powershell.exe",
        shellArgs: ["-NoLogo"],
        initialCommand: trimmed,
    };
}
class AgentCockpitProvider {
    _context;
    static viewType = "agentCockpit.sidebarView";
    _view;
    _sessions = [];
    _activeSessionId = null;
    _currentCwd;
    _recentCwds = [];
    _defaultLocation = "editor";
    constructor(_context) {
        this._context = _context;
        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this._currentCwd = wsFolder || "D:\\Thulir Inc";
        this._registerRecentCwd(this._currentCwd);
        vscode.window.onDidCloseTerminal((closedTerm) => {
            const idx = this._sessions.findIndex((s) => s.terminal === closedTerm);
            if (idx !== -1) {
                const removed = this._sessions[idx];
                this._sessions.splice(idx, 1);
                if (this._activeSessionId === removed.id) {
                    this._activeSessionId =
                        this._sessions.length > 0
                            ? this._sessions[this._sessions.length - 1].id
                            : null;
                }
                this.refreshWebviewState();
            }
        });
        vscode.window.onDidChangeActiveTerminal((activeTerm) => {
            if (!activeTerm)
                return;
            const found = this._sessions.find((s) => s.terminal === activeTerm);
            if (found && found.id !== this._activeSessionId) {
                this._activeSessionId = found.id;
                this._currentCwd = found.cwd;
                this.refreshWebviewState();
            }
        });
    }
    _registerRecentCwd(cwd) {
        if (!cwd)
            return;
        this._recentCwds = [
            cwd,
            ...this._recentCwds.filter((p) => p.toLowerCase() !== cwd.toLowerCase()),
        ].slice(0, 5);
    }
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = this._getHtmlForWebview();
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case "ready":
                    await this.refreshWebviewState();
                    break;
                case "browseCwd":
                    await this._handleBrowseCwd();
                    break;
                case "setCwd":
                    if (typeof msg.cwd === "string" && msg.cwd.trim()) {
                        this._currentCwd = msg.cwd.trim();
                        this._registerRecentCwd(this._currentCwd);
                        await this.refreshWebviewState();
                    }
                    break;
                case "setLocation":
                    this._defaultLocation =
                        msg.location === "panel" ? "panel" : "editor";
                    await this.refreshWebviewState();
                    break;
                case "spawnSession":
                    await this.spawnSession({
                        title: msg.title,
                        badge: msg.badge || "CLI",
                        command: msg.command,
                        args: msg.args || [],
                        cwd: msg.cwd || this._currentCwd,
                        location: msg.location || this._defaultLocation,
                        useWorktree: Boolean(msg.useWorktree),
                        worktreeName: msg.worktreeName || "",
                    });
                    break;
                case "focusSession":
                    this.focusSessionById(msg.id);
                    break;
                case "closeSession":
                    await this.closeSessionById(msg.id);
                    break;
                case "sendSelection":
                    this.sendActiveEditorSelectionToAgent(msg.id);
                    break;
                case "mentionFile":
                    this.sendTextToActiveAgent(`@${msg.file} `, false);
                    break;
                case "openFileDiff":
                    await this._openGitDiffForFile(msg.file);
                    break;
                case "saveHandoff":
                    this._saveHandoffContent(msg.content || "");
                    break;
                case "sendHandoff":
                    this._saveHandoffContent(msg.content || "");
                    this.sendTextToActiveAgent("Please read .agent/handoff.md for current task context and continue from there.", false);
                    break;
                case "refreshGit":
                    await this.refreshWebviewState();
                    break;
            }
        });
    }
    async _handleBrowseCwd() {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(this._currentCwd),
            openLabel: "Select Agent Working Directory (cwd)",
        });
        if (picked && picked.length > 0) {
            this._currentCwd = picked[0].fsPath;
            this._registerRecentCwd(this._currentCwd);
            await this.refreshWebviewState();
        }
    }
    async spawnSession(params) {
        let targetCwd = params.cwd.trim();
        if (!fs.existsSync(targetCwd) || !fs.statSync(targetCwd).isDirectory()) {
            vscode.window.showErrorMessage(`Agent Cockpit: Directory does not exist: ${targetCwd}`);
            return;
        }
        let isWorktree = false;
        if (params.useWorktree) {
            const slug = (params.worktreeName || `task-${Date.now().toString(36)}`)
                .trim()
                .replace(/[^a-zA-Z0-9-_]/g, "-");
            const parentDir = path.dirname(targetCwd);
            const baseName = path.basename(targetCwd);
            const worktreeRoot = path.join(parentDir, `${baseName}-worktrees`);
            const worktreeDir = path.join(worktreeRoot, slug);
            const branchName = `agent/${slug}`;
            try {
                fs.mkdirSync(worktreeRoot, { recursive: true });
                await execGit(targetCwd, [
                    "worktree",
                    "add",
                    "-b",
                    branchName,
                    worktreeDir,
                ]);
                targetCwd = worktreeDir;
                isWorktree = true;
                vscode.window.showInformationMessage(`Created isolated Git worktree at ${worktreeDir} (${branchName})`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Failed to create Git worktree: ${msg}`);
                return;
            }
        }
        let branch;
        try {
            branch = (await execGit(targetCwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        }
        catch {
            branch = undefined;
        }
        const folderShort = path.basename(targetCwd) || targetCwd;
        const termName = `[${params.badge}] ${params.title} (${folderShort})`;
        const resolved = findExecutableOnWindows(params.command);
        const terminalLocation = params.location === "editor"
            ? vscode.TerminalLocation.Editor
            : vscode.TerminalLocation.Panel;
        const terminal = vscode.window.createTerminal({
            name: termName,
            cwd: targetCwd,
            shellPath: resolved.shellPath,
            shellArgs: resolved.shellArgs,
            location: terminalLocation,
        });
        terminal.show(false);
        if (resolved.initialCommand) {
            const fullCmd = params.args.length > 0
                ? `${resolved.initialCommand} ${params.args.join(" ")}`
                : resolved.initialCommand;
            terminal.sendText(fullCmd, true);
        }
        const id = `sess-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 6)}`;
        const session = {
            id,
            title: params.title,
            badge: params.badge,
            command: params.command,
            args: params.args,
            cwd: targetCwd,
            branch,
            isWorktree,
            location: params.location,
            terminal,
            createdAt: Date.now(),
        };
        this._sessions.push(session);
        this._activeSessionId = id;
        this._currentCwd = targetCwd;
        this._registerRecentCwd(targetCwd);
        await this.refreshWebviewState();
    }
    focusSessionByIndex(indexZeroBased) {
        if (indexZeroBased < 0 || indexZeroBased >= this._sessions.length)
            return;
        const target = this._sessions[indexZeroBased];
        this.focusSessionById(target.id);
    }
    focusSessionById(id) {
        const found = this._sessions.find((s) => s.id === id);
        if (!found)
            return;
        this._activeSessionId = found.id;
        this._currentCwd = found.cwd;
        found.terminal.show(false);
        this.refreshWebviewState();
    }
    async closeSessionById(id) {
        const idx = this._sessions.findIndex((s) => s.id === id);
        if (idx === -1)
            return;
        const target = this._sessions[idx];
        target.terminal.dispose();
        this._sessions.splice(idx, 1);
        if (this._activeSessionId === id) {
            this._activeSessionId =
                this._sessions.length > 0
                    ? this._sessions[this._sessions.length - 1].id
                    : null;
        }
        await this.refreshWebviewState();
    }
    sendTextToActiveAgent(text, addNewLine = false) {
        const active = this._sessions.find((s) => s.id === this._activeSessionId) ??
            this._sessions[this._sessions.length - 1];
        if (!active) {
            const activeVsTerm = vscode.window.activeTerminal;
            if (activeVsTerm) {
                activeVsTerm.show(false);
                activeVsTerm.sendText(text, addNewLine);
                return;
            }
            vscode.window.showWarningMessage("Agent Cockpit: No active agent session. Launch a session first!");
            return;
        }
        active.terminal.show(false);
        active.terminal.sendText(text, addNewLine);
    }
    sendActiveEditorSelectionToAgent(targetSessionId) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Agent Cockpit: Open a file in the editor first to send @file:line context.");
            return;
        }
        if (targetSessionId) {
            this._activeSessionId = targetSessionId;
        }
        const activeSession = this._sessions.find((s) => s.id === this._activeSessionId) ??
            this._sessions[this._sessions.length - 1];
        const baseCwd = activeSession?.cwd || this._currentCwd;
        const filePath = editor.document.uri.fsPath;
        let relPath = path.relative(baseCwd, filePath).replace(/\\/g, "/");
        if (relPath.startsWith("..")) {
            relPath = filePath.replace(/\\/g, "/");
        }
        const sel = editor.selection;
        const startLine = sel.start.line + 1;
        const endLine = sel.end.line + 1;
        const refText = !sel.isEmpty && startLine !== endLine
            ? `@${relPath}:${startLine}-${endLine} `
            : `@${relPath}:${startLine} `;
        this.sendTextToActiveAgent(refText, false);
    }
    async _openGitDiffForFile(relFile) {
        const fullPath = path.join(this._currentCwd, relFile);
        if (!fs.existsSync(fullPath))
            return;
        const uri = vscode.Uri.file(fullPath);
        try {
            await vscode.commands.executeCommand("git.openChange", uri);
        }
        catch {
            await vscode.window.showTextDocument(uri);
        }
    }
    _getHandoffPath() {
        return path.join(this._currentCwd, ".agent", "handoff.md");
    }
    _readHandoffContent() {
        const p = this._getHandoffPath();
        try {
            if (fs.existsSync(p)) {
                return fs.readFileSync(p, "utf8");
            }
        }
        catch {
            // ignore
        }
        return "";
    }
    _saveHandoffContent(content) {
        const p = this._getHandoffPath();
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content, "utf8");
            vscode.window.setStatusBarMessage("Agent Cockpit: Saved .agent/handoff.md", 2500);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed saving handoff.md: ${msg}`);
        }
    }
    async openHandoffInEditor() {
        const p = this._getHandoffPath();
        if (!fs.existsSync(p)) {
            this._saveHandoffContent("# Agent Handoff Scratchpad\n\n## Current Goal\n- \n\n## Key Files Modified\n- \n\n## Next Steps for Next Agent\n- \n");
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
        await vscode.window.showTextDocument(doc);
    }
    async _getGitChanges(cwd) {
        try {
            const branch = (await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
            const rawStatus = await execGit(cwd, ["status", "--porcelain"]);
            const changes = rawStatus
                .split(/\r?\n/)
                .filter((line) => line.trim().length > 0)
                .map((line) => ({
                status: line.slice(0, 2).trim() || "M",
                file: line.slice(3).trim(),
            }))
                .slice(0, 25);
            return { branch, changes };
        }
        catch {
            return { branch: null, changes: [] };
        }
    }
    async refreshWebviewState() {
        if (!this._view)
            return;
        const gitInfo = await this._getGitChanges(this._currentCwd);
        const handoffContent = this._readHandoffContent();
        this._view.webview.postMessage({
            type: "state",
            currentCwd: this._currentCwd,
            recentCwds: this._recentCwds,
            defaultLocation: this._defaultLocation,
            activeSessionId: this._activeSessionId,
            presets: DEFAULT_PRESETS,
            gitBranch: gitInfo.branch,
            gitChanges: gitInfo.changes,
            handoffContent,
            sessions: this._sessions.map((s, idx) => ({
                id: s.id,
                index: idx + 1,
                title: s.title,
                badge: s.badge,
                command: s.command,
                args: s.args,
                cwd: s.cwd,
                folderName: path.basename(s.cwd) || s.cwd,
                branch: s.branch,
                isWorktree: s.isWorktree,
                location: s.location,
            })),
        });
    }
    _getHtmlForWebview() {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agent Cockpit</title>
  <style>
    :root {
      --bg-card: rgba(255, 255, 255, 0.04);
      --bg-card-hover: rgba(255, 255, 255, 0.08);
      --border: var(--vscode-panel-border, rgba(255, 255, 255, 0.12));
      --accent: var(--vscode-button-background, #2f81f7);
      --accent-fg: var(--vscode-button-foreground, #ffffff);
      --text-muted: var(--vscode-descriptionForeground, #8b949e);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .section {
      display: flex;
      flex-direction: column;
      gap: 6px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 10px;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }
    .row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    input[type="text"], textarea {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      padding: 5px 7px;
      font-size: 11.5px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    textarea {
      min-height: 74px;
      resize: vertical;
      font-family: var(--vscode-font-family);
    }
    button {
      background: var(--vscode-button-secondaryBackground, var(--bg-card));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 5px 8px;
      font-size: 11.5px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--bg-card-hover));
    }
    button.primary {
      background: var(--accent);
      color: var(--accent-fg);
      font-weight: 600;
    }
    button.primary:hover {
      background: var(--vscode-button-hoverBackground, #388bfd);
    }
    .preset-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 5px;
    }
    .preset-btn {
      justify-content: flex-start;
      padding: 6px 8px;
      font-weight: 500;
    }
    .badge {
      font-family: monospace;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
      background: rgba(47, 129, 247, 0.2);
      color: #79c0ff;
    }
    .toggle-group {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
    }
    .toggle-btn.active {
      border-color: var(--accent);
      background: rgba(47, 129, 247, 0.18);
      font-weight: 600;
    }
    .session-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 7px 8px;
      display: flex;
      flex-direction: column;
      gap: 5px;
      cursor: pointer;
    }
    .session-card.active {
      border-color: var(--accent);
      background: rgba(47, 129, 247, 0.12);
    }
    .session-top {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .session-title {
      flex: 1;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .session-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10.5px;
      color: var(--text-muted);
      gap: 4px;
    }
    .git-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 150px;
      overflow-y: auto;
    }
    .git-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      padding: 3px 5px;
      border-radius: 4px;
      background: var(--bg-card);
      font-family: monospace;
      font-size: 11px;
    }
    .git-file {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .git-status {
      font-weight: 700;
      color: #e3b341;
      width: 18px;
    }
    .btn-xs {
      padding: 2px 5px;
      font-size: 10px;
    }
    .worktree-box {
      display: flex;
      flex-direction: column;
      gap: 5px;
      background: var(--bg-card);
      padding: 6px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }
    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 11.5px;
    }
    .empty-hint {
      color: var(--text-muted);
      font-size: 11px;
      font-style: italic;
    }
  </style>
</head>
<body>
  <!-- 1. Working Directory & Terminal Placement -->
  <div class="section">
    <div class="section-header">
      <span>1. Working Directory (cwd)</span>
      <span id="git-branch-pill"></span>
    </div>
    <div class="row">
      <input id="cwd-input" type="text" placeholder="D:\\Thulir Inc\\..." />
      <button id="browse-btn" title="Pick folder">Browse…</button>
    </div>
    <div class="toggle-group">
      <button id="loc-editor" class="toggle-btn active" title="Open as Full-Height Editor Tab">
        📑 Editor Tab
      </button>
      <button id="loc-panel" class="toggle-btn" title="Open in VS Code Bottom Terminal Panel">
        ▤ Bottom Panel
      </button>
    </div>
    <div class="worktree-box">
      <label class="checkbox-label">
        <input id="worktree-check" type="checkbox" />
        <span>Isolate in new Git Worktree</span>
      </label>
      <input
        id="worktree-name"
        type="text"
        placeholder="Worktree task slug (e.g. feat-auth)"
        style="display: none;"
      />
    </div>
  </div>

  <!-- 2. Quick-Spawn CLI Agents -->
  <div class="section">
    <div class="section-header">
      <span>2. Quick-Spawn CLI Agent</span>
    </div>
    <div id="preset-grid" class="preset-grid"></div>
    <details>
      <summary style="cursor:pointer;font-size:11px;color:var(--text-muted);margin-top:2px;">
        + Custom Command / Arguments…
      </summary>
      <div style="display:flex;flex-direction:column;gap:5px;margin-top:6px;">
        <input id="custom-title" type="text" placeholder="Session Title (e.g. Aider / Custom)" />
        <input id="custom-cmd" type="text" placeholder="Executable (e.g. claude, gemini, python)" />
        <input id="custom-args" type="text" placeholder="Optional arguments" />
        <button id="custom-launch-btn" class="primary">Launch Custom Session</button>
      </div>
    </details>
  </div>

  <!-- 3. Active Sessions Switcher -->
  <div class="section">
    <div class="section-header">
      <span>3. Active Sessions (<span id="session-count">0</span>)</span>
      <button id="send-sel-btn" class="btn-xs" title="Send active editor @file:line selection (Ctrl+Alt+S)">
        Send @file:line
      </button>
    </div>
    <div id="session-list" style="display:flex;flex-direction:column;gap:5px;"></div>
  </div>

  <!-- 4. Live Git Status & Diff Drawer -->
  <div class="section">
    <div class="section-header">
      <span>4. Live Git Changes</span>
      <button id="refresh-git-btn" class="btn-xs">↻ Refresh</button>
    </div>
    <div id="git-list" class="git-list"></div>
  </div>

  <!-- 5. Handoff Scratchpad (.agent/handoff.md) -->
  <div class="section" style="border-bottom:none;">
    <div class="section-header">
      <span>5. Handoff (.agent/handoff.md)</span>
      <button id="save-handoff-btn" class="btn-xs">Save</button>
    </div>
    <textarea
      id="handoff-textarea"
      placeholder="Summarize progress or context to hand off between Claude, Codex, and Gemini..."
    ></textarea>
    <button id="send-handoff-btn">Send Handoff Prompt to Active Agent</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const cwdInput = document.getElementById("cwd-input");
    const browseBtn = document.getElementById("browse-btn");
    const locEditorBtn = document.getElementById("loc-editor");
    const locPanelBtn = document.getElementById("loc-panel");
    const worktreeCheck = document.getElementById("worktree-check");
    const worktreeNameInput = document.getElementById("worktree-name");
    const presetGrid = document.getElementById("preset-grid");
    const sessionList = document.getElementById("session-list");
    const sessionCount = document.getElementById("session-count");
    const gitList = document.getElementById("git-list");
    const gitBranchPill = document.getElementById("git-branch-pill");
    const handoffTextarea = document.getElementById("handoff-textarea");

    let currentState = {
      currentCwd: "",
      defaultLocation: "editor",
      presets: [],
      sessions: [],
    };

    worktreeCheck.addEventListener("change", () => {
      worktreeNameInput.style.display = worktreeCheck.checked ? "block" : "none";
    });

    cwdInput.addEventListener("change", () => {
      vscode.postMessage({ type: "setCwd", cwd: cwdInput.value });
    });

    browseBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "browseCwd" });
    });

    locEditorBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "setLocation", location: "editor" });
    });

    locPanelBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "setLocation", location: "panel" });
    });

    document.getElementById("custom-launch-btn").addEventListener("click", () => {
      const cmd = document.getElementById("custom-cmd").value.trim();
      if (!cmd) return;
      const title = document.getElementById("custom-title").value.trim() || cmd;
      const rawArgs = document.getElementById("custom-args").value.trim();
      const args = rawArgs ? rawArgs.split(/\\s+/) : [];
      vscode.postMessage({
        type: "spawnSession",
        title,
        badge: "CLI",
        command: cmd,
        args,
        cwd: cwdInput.value.trim(),
        location: currentState.defaultLocation,
        useWorktree: worktreeCheck.checked,
        worktreeName: worktreeNameInput.value.trim(),
      });
    });

    document.getElementById("send-sel-btn").addEventListener("click", () => {
      vscode.postMessage({ type: "sendSelection" });
    });

    document.getElementById("refresh-git-btn").addEventListener("click", () => {
      vscode.postMessage({ type: "refreshGit" });
    });

    document.getElementById("save-handoff-btn").addEventListener("click", () => {
      vscode.postMessage({
        type: "saveHandoff",
        content: handoffTextarea.value,
      });
    });

    document.getElementById("send-handoff-btn").addEventListener("click", () => {
      vscode.postMessage({
        type: "sendHandoff",
        content: handoffTextarea.value,
      });
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type !== "state") return;
      currentState = msg;

      cwdInput.value = msg.currentCwd || "";
      gitBranchPill.textContent = msg.gitBranch ? "🌿 " + msg.gitBranch : "";

      locEditorBtn.classList.toggle("active", msg.defaultLocation === "editor");
      locPanelBtn.classList.toggle("active", msg.defaultLocation === "panel");

      // Render Presets
      presetGrid.innerHTML = "";
      (msg.presets || []).forEach((p) => {
        const btn = document.createElement("button");
        btn.className = "preset-btn";
        btn.innerHTML = '<span class="badge">' + p.badge + "</span><span>" + p.label + "</span>";
        btn.addEventListener("click", () => {
          vscode.postMessage({
            type: "spawnSession",
            title: p.label,
            badge: p.badge,
            command: p.command,
            args: p.args,
            cwd: cwdInput.value.trim(),
            location: currentState.defaultLocation,
            useWorktree: worktreeCheck.checked,
            worktreeName: worktreeNameInput.value.trim(),
          });
        });
        presetGrid.appendChild(btn);
      });

      // Render Active Sessions
      sessionCount.textContent = String((msg.sessions || []).length);
      sessionList.innerHTML = "";
      if (!msg.sessions || msg.sessions.length === 0) {
        sessionList.innerHTML = '<div class="empty-hint">No running sessions. Click a preset above to launch.</div>';
      } else {
        msg.sessions.forEach((s) => {
          const card = document.createElement("div");
          card.className = "session-card" + (s.id === msg.activeSessionId ? " active" : "");
          card.innerHTML =
            '<div class="session-top">' +
              '<span class="badge">' + s.badge + "</span>" +
              '<span class="session-title">' + s.title + "</span>" +
              '<span style="font-family:monospace;font-size:10px;color:var(--text-muted);">^Alt+' + s.index + "</span>" +
              '<button class="btn-xs send-btn" title="Send @file:line to this agent">@</button>' +
              '<button class="btn-xs close-btn" title="Kill session">✕</button>' +
            "</div>" +
            '<div class="session-meta">' +
              '<span title="' + s.cwd + '">📁 ' + s.folderName + (s.branch ? " (" + s.branch + ")" : "") + "</span>" +
              '<span>' + (s.location === "editor" ? "Editor Tab" : "Panel") + "</span>" +
            "</div>";

          card.addEventListener("click", () => {
            vscode.postMessage({ type: "focusSession", id: s.id });
          });
          card.querySelector(".send-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "sendSelection", id: s.id });
          });
          card.querySelector(".close-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "closeSession", id: s.id });
          });
          sessionList.appendChild(card);
        });
      }

      // Render Git Status
      gitList.innerHTML = "";
      if (!msg.gitChanges || msg.gitChanges.length === 0) {
        gitList.innerHTML = '<div class="empty-hint">Working tree clean (or not a Git repo).</div>';
      } else {
        msg.gitChanges.forEach((c) => {
          const row = document.createElement("div");
          row.className = "git-item";
          row.innerHTML =
            '<span class="git-status">' + c.status + "</span>" +
            '<span class="git-file" title="' + c.file + '">' + c.file + "</span>" +
            '<button class="btn-xs diff-btn" title="Open Git Diff">Diff</button>' +
            '<button class="btn-xs mention-btn" title="Insert @file into active agent">@File</button>';
          row.querySelector(".diff-btn").addEventListener("click", () => {
            vscode.postMessage({ type: "openFileDiff", file: c.file });
          });
          row.querySelector(".mention-btn").addEventListener("click", () => {
            vscode.postMessage({ type: "mentionFile", file: c.file });
          });
          gitList.appendChild(row);
        });
      }

      if (document.activeElement !== handoffTextarea) {
        handoffTextarea.value = msg.handoffContent || "";
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
    }
}
function activate(context) {
    const provider = new AgentCockpitProvider(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentCockpitProvider.viewType, provider, { webviewOptions: { retainContextWhenHidden: true } }));
    context.subscriptions.push(vscode.commands.registerCommand("agentCockpit.newSession", async () => {
        const picked = await vscode.window.showQuickPick([
            ...DEFAULT_PRESETS.map((p) => ({
                label: `[${p.badge}] ${p.label}`,
                description: p.command,
                preset: p,
            })),
            {
                label: "[CLI] Custom CLI Command…",
                description: "Enter any executable and arguments",
                preset: null,
            },
        ], { placeHolder: "Select CLI Agent to launch in Agent Cockpit" });
        if (!picked)
            return;
        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "D:\\Thulir Inc";
        const cwd = await vscode.window.showInputBox({
            prompt: "Working Directory (cwd) for this session",
            value: wsFolder,
        });
        if (!cwd)
            return;
        if (picked.preset) {
            await provider.spawnSession({
                title: picked.preset.label,
                badge: picked.preset.badge,
                command: picked.preset.command,
                args: picked.preset.args,
                cwd,
                location: "editor",
            });
        }
        else {
            const customCmd = await vscode.window.showInputBox({
                prompt: "Enter CLI executable (e.g. claude, codex, gemini, aider)",
            });
            if (!customCmd)
                return;
            await provider.spawnSession({
                title: customCmd,
                badge: "CLI",
                command: customCmd,
                args: [],
                cwd,
                location: "editor",
            });
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("agentCockpit.sendSelection", () => {
        provider.sendActiveEditorSelectionToAgent();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("agentCockpit.openHandoff", () => {
        provider.openHandoffInEditor();
    }));
    for (let i = 1; i <= 5; i++) {
        context.subscriptions.push(vscode.commands.registerCommand(`agentCockpit.switchSession${i}`, () => {
            provider.focusSessionByIndex(i - 1);
        }));
    }
}
function deactivate() { }
//# sourceMappingURL=extension.js.map