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
        id: "agy",
        label: "AGY",
        badge: "✦",
        color: "#1a73e8",
        command: "agy",
        args: [],
    },
    {
        id: "claude",
        label: "Claude",
        badge: "C",
        color: "#d97757",
        command: "claude",
        args: [],
    },
    {
        id: "codex",
        label: "Codex",
        badge: "X",
        color: "#10a37f",
        command: "codex",
        args: [],
    },
    {
        id: "powershell",
        label: "Shell",
        badge: ">_",
        color: "#5f6368",
        command: "powershell.exe",
        args: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
    },
];
function summarizeFirstLine(raw, label) {
    const firstLine = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
    if (!firstLine)
        return null;
    const lower = firstLine.toLowerCase();
    if (lower === "agy" ||
        lower === "claude" ||
        lower === "codex" ||
        lower === "gemini" ||
        lower === "powershell" ||
        lower === "powershell.exe") {
        return null;
    }
    const cleaned = firstLine.replace(/\s+/g, " ").slice(0, 26);
    return `${label} · ${cleaned}`;
}
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
        return {
            shellPath: "powershell.exe",
            shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
        };
    }
    if (trimmed.toLowerCase() === "cmd.exe" || trimmed.toLowerCase() === "cmd") {
        return { shellPath: "cmd.exe", shellArgs: [] };
    }
    return {
        shellPath: "powershell.exe",
        shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
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
    _defaultLocation = "editor";
    constructor(_context) {
        this._context = _context;
        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this._currentCwd = wsFolder || "D:\\Thulir Inc";
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
        const winAny = vscode.window;
        if (typeof winAny.onDidStartTerminalShellExecution === "function") {
            this._context.subscriptions.push(winAny.onDidStartTerminalShellExecution((e) => {
                const sess = this._sessions.find((s) => s.terminal === e.terminal);
                if (!sess || sess.hasCustomTitle)
                    return;
                const cmdValue = e.execution?.commandLine?.value || "";
                const autoTitle = summarizeFirstLine(cmdValue, sess.title);
                if (autoTitle) {
                    void this.renameSession(sess.id, autoTitle);
                }
            }));
        }
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
                case "setLocation":
                    this._defaultLocation =
                        msg.location === "panel" ? "panel" : "editor";
                    await this.refreshWebviewState();
                    break;
                case "spawnSession":
                    await this.spawnSession({
                        title: msg.title,
                        badge: msg.badge || ">_",
                        color: msg.color || "#1a73e8",
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
                case "renameSession":
                    if (typeof msg.id === "string" && typeof msg.title === "string") {
                        await this.renameSession(msg.id, msg.title);
                    }
                    break;
                case "sendQuickPrompt":
                    if (typeof msg.prompt === "string" && msg.prompt.trim()) {
                        this.sendQuickPromptToActiveAgent(msg.prompt.trim());
                    }
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
                    this.sendTextToActiveAgent("Read .agent/handoff.md and continue.", false);
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
            openLabel: "Select Working Directory",
        });
        if (picked && picked.length > 0) {
            this._currentCwd = picked[0].fsPath;
            await this.refreshWebviewState();
        }
    }
    async spawnSession(params) {
        let targetCwd = params.cwd.trim();
        if (!fs.existsSync(targetCwd) || !fs.statSync(targetCwd).isDirectory()) {
            vscode.window.showErrorMessage(`Directory does not exist: ${targetCwd}`);
            return;
        }
        let isWorktree = false;
        if (params.useWorktree) {
            const slug = (params.worktreeName || `wt-${Date.now().toString(36).slice(-4)}`)
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
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Worktree error: ${msg}`);
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
        const termName = `${params.title} · ${folderShort}`;
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
            color: params.color,
            command: params.command,
            args: params.args,
            cwd: targetCwd,
            branch,
            isWorktree,
            hasCustomTitle: false,
            location: params.location,
            terminal,
            createdAt: Date.now(),
        };
        this._sessions.push(session);
        this._activeSessionId = id;
        this._currentCwd = targetCwd;
        await this.refreshWebviewState();
    }
    async renameSession(id, newTitleRaw) {
        const trimmed = newTitleRaw.trim();
        if (!trimmed)
            return;
        const found = this._sessions.find((s) => s.id === id);
        if (!found)
            return;
        found.title = trimmed;
        found.hasCustomTitle = true;
        try {
            found.terminal.show(true);
            await vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name: trimmed });
        }
        catch {
            // ignore
        }
        await this.refreshWebviewState();
    }
    async promptRenameSession(id) {
        const targetId = id || this._activeSessionId;
        const found = this._sessions.find((s) => s.id === targetId) ??
            this._sessions[this._sessions.length - 1];
        if (!found)
            return;
        const input = await vscode.window.showInputBox({
            prompt: "Rename terminal session",
            value: found.title,
        });
        if (input && input.trim()) {
            await this.renameSession(found.id, input.trim());
        }
    }
    sendQuickPromptToActiveAgent(promptText) {
        const active = this._sessions.find((s) => s.id === this._activeSessionId) ??
            this._sessions[this._sessions.length - 1];
        if (active && !active.hasCustomTitle) {
            const autoTitle = summarizeFirstLine(promptText, active.title);
            if (autoTitle) {
                void this.renameSession(active.id, autoTitle);
            }
        }
        this.sendTextToActiveAgent(promptText, true);
    }
    focusSessionByIndex(indexZeroBased) {
        if (indexZeroBased < 0 || indexZeroBased >= this._sessions.length)
            return;
        this.focusSessionById(this._sessions[indexZeroBased].id);
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
        this._sessions[idx].terminal.dispose();
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
            vscode.window.showWarningMessage("Launch an agent session first.");
            return;
        }
        if (!active.hasCustomTitle) {
            const autoTitle = summarizeFirstLine(text, active.title);
            if (autoTitle) {
                void this.renameSession(active.id, autoTitle);
            }
        }
        active.terminal.show(false);
        active.terminal.sendText(text, addNewLine);
    }
    sendActiveEditorSelectionToAgent(targetSessionId) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage("Open a file in the editor first.");
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
            vscode.window.setStatusBarMessage("Saved .agent/handoff.md", 2000);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed saving handoff.md: ${msg}`);
        }
    }
    async openHandoffInEditor() {
        const p = this._getHandoffPath();
        if (!fs.existsSync(p)) {
            this._saveHandoffContent("# Handoff Notes\n\n");
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
            folderName: path.basename(this._currentCwd) || this._currentCwd,
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
                color: s.color,
                cwd: s.cwd,
                folderName: path.basename(s.cwd) || s.cwd,
                branch: s.branch,
                isWorktree: s.isWorktree,
            })),
        });
    }
    _getHtmlForWebview() {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --md-surface: var(--vscode-editor-background, #ffffff);
      --md-border: rgba(128, 134, 139, 0.36);
      --md-border-strong: rgba(128, 134, 139, 0.58);
      --md-primary: #1a73e8;
      --md-primary-bg: rgba(26, 115, 232, 0.12);
      --md-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.05);
      --md-shadow-md: 0 3px 6px rgba(0, 0, 0, 0.12), 0 2px 4px rgba(0, 0, 0, 0.08);
      --md-muted: var(--vscode-descriptionForeground, #5f6368);
      --md-radius: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Segoe UI", Roboto, -apple-system, sans-serif;
      font-size: 12px;
      color: var(--vscode-foreground);
      background: transparent;
      padding: 10px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 10px;
      user-select: none;
    }

    /* Material Top Bar */
    .top-bar {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cwd-btn {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      border-radius: var(--md-radius);
      box-shadow: var(--md-shadow-sm);
      padding: 6px 10px;
      cursor: pointer;
      overflow: hidden;
      font-size: 12px;
      color: var(--vscode-foreground);
      transition: all 0.15s ease;
    }
    .cwd-btn:hover {
      border-color: var(--md-primary);
      box-shadow: var(--md-shadow-md);
      transform: translateY(-1px);
    }
    .cwd-btn:active {
      transform: translateY(0);
    }
    .cwd-name {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .branch-chip {
      font-size: 10px;
      font-weight: 600;
      color: var(--md-primary);
      background: var(--md-primary-bg);
      padding: 1px 6px;
      border-radius: 99px;
      margin-left: auto;
      white-space: nowrap;
    }

    .chip-btn {
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      box-shadow: var(--md-shadow-sm);
      color: var(--md-muted);
      border-radius: var(--md-radius);
      padding: 6px 9px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .chip-btn:hover {
      border-color: var(--md-border-strong);
      color: var(--vscode-foreground);
      box-shadow: var(--md-shadow-md);
      transform: translateY(-1px);
    }
    .chip-btn.active {
      color: var(--md-primary);
      border-color: var(--md-primary);
      background: var(--md-primary-bg);
    }

    /* Material Agent Launch Buttons */
    .launch-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr) 34px;
      gap: 6px;
    }
    .md-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      border-radius: var(--md-radius);
      box-shadow: var(--md-shadow-sm);
      color: var(--vscode-foreground);
      padding: 7px 6px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .md-btn:hover {
      border-color: var(--md-primary);
      box-shadow: var(--md-shadow-md);
      transform: translateY(-1px);
    }
    .md-btn:active {
      transform: translateY(0);
      box-shadow: var(--md-shadow-sm);
    }
    .agent-dot {
      width: 16px;
      height: 16px;
      border-radius: 5px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 9.5px;
      font-weight: 700;
      color: #ffffff;
      flex-shrink: 0;
    }

    /* Custom Command Card */
    .custom-drawer {
      display: none;
      gap: 6px;
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      border-radius: var(--md-radius);
      box-shadow: var(--md-shadow-sm);
      padding: 8px;
    }
    .custom-drawer.open { display: flex; }

    input[type="text"], textarea {
      width: 100%;
      background: var(--md-surface);
      color: var(--vscode-foreground);
      border: 1px solid var(--md-border);
      border-radius: 6px;
      padding: 6px 9px;
      font-size: 11.5px;
      font-family: inherit;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.04);
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    input[type="text"]:focus, textarea:focus {
      outline: none;
      border-color: var(--md-primary);
      box-shadow: 0 0 0 2px rgba(26, 115, 232, 0.18);
    }

    /* Material Session Cards */
    .sessions-container {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 2px 1px;
    }
    .session-card {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      border-radius: var(--md-radius);
      box-shadow: var(--md-shadow-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .session-card:hover {
      border-color: var(--md-border-strong);
      box-shadow: var(--md-shadow-md);
      transform: translateY(-1px);
    }
    .session-card.active {
      border-color: var(--md-primary);
      border-left: 4px solid var(--md-primary);
      background: var(--md-primary-bg);
    }
    .s-title {
      flex: 1;
      font-weight: 600;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .s-rename-input {
      flex: 1;
      padding: 3px 6px !important;
      font-size: 11.5px !important;
    }
    .s-folder {
      font-size: 10.5px;
      font-weight: 500;
      color: var(--md-muted);
      background: rgba(128, 134, 139, 0.12);
      padding: 2px 6px;
      border-radius: 4px;
      white-space: nowrap;
    }
    .row-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .icon-action {
      width: 22px;
      height: 22px;
      border-radius: 5px;
      border: 1px solid var(--md-border);
      background: var(--md-surface);
      color: var(--md-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      transition: all 0.12s;
    }
    .icon-action:hover {
      color: var(--md-primary);
      border-color: var(--md-primary);
      background: var(--md-primary-bg);
    }
    .icon-action.danger:hover {
      color: #d93025;
      border-color: #d93025;
      background: rgba(217, 48, 37, 0.1);
    }

    .empty-card {
      margin: auto;
      padding: 18px 14px;
      border: 1px dashed var(--md-border);
      border-radius: var(--md-radius);
      color: var(--md-muted);
      font-size: 11.5px;
      text-align: center;
    }

    /* Footer Prompt & Material Action Bar */
    .footer-bar {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--md-border);
    }
    .prompt-box {
      display: flex;
      gap: 6px;
    }
    .send-btn {
      background: var(--md-primary);
      color: #ffffff;
      border: 1px solid var(--md-primary);
      border-radius: 6px;
      padding: 0 10px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: var(--md-shadow-sm);
      transition: all 0.15s;
    }
    .send-btn:hover {
      background: #1557b0;
      box-shadow: var(--md-shadow-md);
    }
    .footer-tabs {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }
    .footer-btn {
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      border-radius: var(--md-radius);
      box-shadow: var(--md-shadow-sm);
      color: var(--vscode-foreground);
      padding: 6px 8px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s ease;
    }
    .footer-btn:hover {
      border-color: var(--md-primary);
      box-shadow: var(--md-shadow-md);
      transform: translateY(-1px);
    }
    .footer-btn.active {
      color: var(--md-primary);
      border-color: var(--md-primary);
      background: var(--md-primary-bg);
    }

    .drawer-pane {
      display: none;
      flex-direction: column;
      gap: 5px;
      max-height: 145px;
      overflow-y: auto;
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      border-radius: var(--md-radius);
      padding: 8px;
      box-shadow: var(--md-shadow-sm);
    }
    .drawer-pane.open { display: flex; }
    .git-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      padding: 4px 6px;
      border-radius: 5px;
      border: 1px solid transparent;
    }
    .git-row:hover {
      border-color: var(--md-border);
      background: rgba(128, 134, 139, 0.06);
    }
    .git-st { color: #e37400; font-family: monospace; font-weight: 700; font-size: 10.5px; width: 14px; }
    .git-path {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: monospace;
      font-size: 10.5px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <!-- Material Top Row -->
  <div class="top-bar">
    <button id="cwd-pill" class="cwd-btn" title="Click to change working directory">
      <span>📁</span>
      <span id="cwd-name" class="cwd-name">workspace</span>
      <span id="branch-tag" class="branch-chip" style="display:none;"></span>
    </button>
    <button id="loc-toggle" class="chip-btn active" title="Toggle Editor Tab vs Bottom Panel">
      Tab
    </button>
    <button id="wt-toggle" class="chip-btn" title="Isolate next session in a new Git Worktree">
      WT
    </button>
  </div>

  <!-- Material Agent Launch Buttons -->
  <div class="launch-bar">
    <div id="preset-buttons" style="display:contents;"></div>
    <button id="custom-toggle" class="md-btn" title="Launch custom CLI command">+</button>
  </div>

  <div id="custom-drawer" class="custom-drawer">
    <input id="custom-cmd" type="text" placeholder="Command (e.g. agy, claude, aider)" />
    <button id="custom-go" class="send-btn">Run</button>
  </div>

  <!-- Material Session Cards -->
  <div id="session-list" class="sessions-container"></div>

  <!-- Material Footer -->
  <div class="footer-bar">
    <div id="git-drawer" class="drawer-pane"></div>
    <div id="notes-drawer" class="drawer-pane">
      <textarea id="handoff-text" rows="3" placeholder="Shared handoff notes (.agent/handoff.md)…"></textarea>
      <div style="display:flex;gap:6px;">
        <button id="save-notes" class="footer-btn" style="flex:1;">Save</button>
        <button id="send-notes" class="send-btn" style="flex:1;padding:6px;">Send to Agent</button>
      </div>
    </div>

    <div class="prompt-box">
      <input
        id="quick-prompt-input"
        type="text"
        placeholder="Prompt active agent (auto-names tab)…"
      />
      <button id="quick-prompt-btn" class="send-btn" title="Send prompt">↵</button>
    </div>

    <div class="footer-tabs">
      <button id="tab-git" class="footer-btn">Git (<span id="git-count">0</span>)</button>
      <button id="tab-notes" class="footer-btn">Notes</button>
      <button id="tab-send" class="footer-btn" title="Send editor @file:line selection (Ctrl+Alt+S)">@Line</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let state = {
      currentCwd: "",
      defaultLocation: "editor",
      useWorktree: false,
      activeFooter: null,
    };

    const cwdPill = document.getElementById("cwd-pill");
    const cwdName = document.getElementById("cwd-name");
    const branchTag = document.getElementById("branch-tag");
    const locToggle = document.getElementById("loc-toggle");
    const wtToggle = document.getElementById("wt-toggle");
    const presetButtons = document.getElementById("preset-buttons");
    const customToggle = document.getElementById("custom-toggle");
    const customDrawer = document.getElementById("custom-drawer");
    const customCmd = document.getElementById("custom-cmd");
    const customGo = document.getElementById("custom-go");
    const sessionList = document.getElementById("session-list");
    const quickPromptInput = document.getElementById("quick-prompt-input");
    const quickPromptBtn = document.getElementById("quick-prompt-btn");
    const gitDrawer = document.getElementById("git-drawer");
    const notesDrawer = document.getElementById("notes-drawer");
    const gitCount = document.getElementById("git-count");
    const handoffText = document.getElementById("handoff-text");
    const tabGit = document.getElementById("tab-git");
    const tabNotes = document.getElementById("tab-notes");

    cwdPill.addEventListener("click", () => {
      vscode.postMessage({ type: "browseCwd" });
    });

    locToggle.addEventListener("click", () => {
      const next = state.defaultLocation === "editor" ? "panel" : "editor";
      vscode.postMessage({ type: "setLocation", location: next });
    });

    wtToggle.addEventListener("click", () => {
      state.useWorktree = !state.useWorktree;
      wtToggle.classList.toggle("active", state.useWorktree);
    });

    customToggle.addEventListener("click", () => {
      customDrawer.classList.toggle("open");
      if (customDrawer.classList.contains("open")) customCmd.focus();
    });

    function launchCustom() {
      if (!customCmd.value.trim()) return;
      const parts = customCmd.value.trim().split(/\\s+/);
      vscode.postMessage({
        type: "spawnSession",
        title: parts[0],
        badge: ">_",
        color: "#5f6368",
        command: parts[0],
        args: parts.slice(1),
        cwd: state.currentCwd,
        location: state.defaultLocation,
        useWorktree: state.useWorktree,
      });
      customCmd.value = "";
      customDrawer.classList.remove("open");
    }

    customCmd.addEventListener("keydown", (e) => {
      if (e.key === "Enter") launchCustom();
    });
    customGo.addEventListener("click", launchCustom);

    function submitQuickPrompt() {
      if (!quickPromptInput.value.trim()) return;
      vscode.postMessage({
        type: "sendQuickPrompt",
        prompt: quickPromptInput.value.trim(),
      });
      quickPromptInput.value = "";
    }

    quickPromptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitQuickPrompt();
    });
    quickPromptBtn.addEventListener("click", submitQuickPrompt);

    tabGit.addEventListener("click", () => {
      state.activeFooter = state.activeFooter === "git" ? null : "git";
      gitDrawer.classList.toggle("open", state.activeFooter === "git");
      notesDrawer.classList.remove("open");
      tabGit.classList.toggle("active", state.activeFooter === "git");
      tabNotes.classList.remove("active");
      if (state.activeFooter === "git") vscode.postMessage({ type: "refreshGit" });
    });

    tabNotes.addEventListener("click", () => {
      state.activeFooter = state.activeFooter === "notes" ? null : "notes";
      notesDrawer.classList.toggle("open", state.activeFooter === "notes");
      gitDrawer.classList.remove("open");
      tabNotes.classList.toggle("active", state.activeFooter === "notes");
      tabGit.classList.remove("active");
    });

    document.getElementById("tab-send").addEventListener("click", () => {
      vscode.postMessage({ type: "sendSelection" });
    });

    document.getElementById("save-notes").addEventListener("click", () => {
      vscode.postMessage({ type: "saveHandoff", content: handoffText.value });
    });

    document.getElementById("send-notes").addEventListener("click", () => {
      vscode.postMessage({ type: "sendHandoff", content: handoffText.value });
    });

    function startInlineRename(row, session) {
      const titleEl = row.querySelector(".s-title");
      if (!titleEl) return;

      const input = document.createElement("input");
      input.type = "text";
      input.className = "s-rename-input";
      input.value = session.title;

      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        const val = input.value.trim();
        if (val && val !== session.title) {
          vscode.postMessage({ type: "renameSession", id: session.id, title: val });
        } else {
          vscode.postMessage({ type: "ready" });
        }
      };

      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          commit();
        } else if (e.key === "Escape") {
          committed = true;
          vscode.postMessage({ type: "ready" });
        }
      });
      input.addEventListener("blur", commit);

      titleEl.replaceWith(input);
      input.focus();
      input.select();
    }

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type !== "state") return;

      state.currentCwd = msg.currentCwd;
      state.defaultLocation = msg.defaultLocation;

      cwdName.textContent = msg.folderName || "workspace";
      cwdPill.title = msg.currentCwd;
      if (msg.gitBranch) {
        branchTag.style.display = "inline-block";
        branchTag.textContent = msg.gitBranch;
      } else {
        branchTag.style.display = "none";
      }

      locToggle.textContent = msg.defaultLocation === "editor" ? "Tab" : "Panel";
      locToggle.classList.toggle("active", msg.defaultLocation === "editor");

      // Material Agent Launch Buttons
      presetButtons.innerHTML = "";
      (msg.presets || []).forEach((p) => {
        const btn = document.createElement("button");
        btn.className = "md-btn";
        btn.title = "Launch " + p.label + " (" + p.command + ")";
        btn.innerHTML =
          '<span class="agent-dot" style="background:' + p.color + ';">' + p.badge + '</span>' +
          '<span>' + p.label + '</span>';
        btn.addEventListener("click", () => {
          vscode.postMessage({
            type: "spawnSession",
            title: p.label,
            badge: p.badge,
            color: p.color,
            command: p.command,
            args: p.args,
            cwd: state.currentCwd,
            location: state.defaultLocation,
            useWorktree: state.useWorktree,
          });
        });
        presetButtons.appendChild(btn);
      });

      // Material Session Cards
      sessionList.innerHTML = "";
      if (!msg.sessions || msg.sessions.length === 0) {
        sessionList.innerHTML = '<div class="empty-card">Click an agent button above to launch a session</div>';
      } else {
        msg.sessions.forEach((s) => {
          const card = document.createElement("div");
          card.className = "session-card" + (s.id === msg.activeSessionId ? " active" : "");
          card.title = "Click to focus · Double-click title to rename";
          card.innerHTML =
            '<span class="agent-dot" style="background:' + (s.color || "#1a73e8") + ';">' + s.badge + '</span>' +
            '<span class="s-title">' + s.title + '</span>' +
            '<span class="s-folder">' + s.folderName + '</span>' +
            '<div class="row-actions">' +
              '<button class="icon-action act-rename" title="Rename">✎</button>' +
              '<button class="icon-action act-send" title="Send @file:line">@</button>' +
              '<button class="icon-action danger act-close" title="Close">✕</button>' +
            '</div>';

          card.addEventListener("click", () => {
            vscode.postMessage({ type: "focusSession", id: s.id });
          });
          card.querySelector(".s-title").addEventListener("dblclick", (e) => {
            e.stopPropagation();
            startInlineRename(card, s);
          });
          card.querySelector(".act-rename").addEventListener("click", (e) => {
            e.stopPropagation();
            startInlineRename(card, s);
          });
          card.querySelector(".act-send").addEventListener("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "sendSelection", id: s.id });
          });
          card.querySelector(".act-close").addEventListener("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "closeSession", id: s.id });
          });
          sessionList.appendChild(card);
        });
      }

      // Git
      const changes = msg.gitChanges || [];
      gitCount.textContent = String(changes.length);
      gitDrawer.innerHTML = "";
      if (changes.length === 0) {
        gitDrawer.innerHTML = '<div style="color:var(--md-muted);text-align:center;padding:6px 0;">Clean working tree</div>';
      } else {
        changes.forEach((c) => {
          const r = document.createElement("div");
          r.className = "git-row";
          r.innerHTML =
            '<span class="git-st">' + c.status + '</span>' +
            '<span class="git-path" title="Click to view diff">' + c.file + '</span>' +
            '<button class="icon-action" title="Mention @file">@</button>';
          r.querySelector(".git-path").addEventListener("click", () => {
            vscode.postMessage({ type: "openFileDiff", file: c.file });
          });
          r.querySelector(".icon-action").addEventListener("click", () => {
            vscode.postMessage({ type: "mentionFile", file: c.file });
          });
          gitDrawer.appendChild(r);
        });
      }

      if (document.activeElement !== handoffText) {
        handoffText.value = msg.handoffContent || "";
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
                label: p.label,
                description: p.command,
                preset: p,
            })),
            {
                label: "Custom CLI Command…",
                description: "Enter executable",
                preset: null,
            },
        ], { placeHolder: "Launch Agent" });
        if (!picked)
            return;
        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "D:\\Thulir Inc";
        const cwd = await vscode.window.showInputBox({
            prompt: "Working Directory (cwd)",
            value: wsFolder,
        });
        if (!cwd)
            return;
        if (picked.preset) {
            await provider.spawnSession({
                title: picked.preset.label,
                badge: picked.preset.badge,
                color: picked.preset.color,
                command: picked.preset.command,
                args: picked.preset.args,
                cwd,
                location: "editor",
            });
        }
        else {
            const customCmd = await vscode.window.showInputBox({
                prompt: "CLI executable",
            });
            if (!customCmd)
                return;
            await provider.spawnSession({
                title: customCmd,
                badge: ">_",
                color: "#5f6368",
                command: customCmd,
                args: [],
                cwd,
                location: "editor",
            });
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("agentCockpit.renameSession", () => {
        void provider.promptRenameSession();
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