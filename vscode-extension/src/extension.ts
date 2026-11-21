import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";

interface AgentPreset {
  id: string;
  label: string;
  badge: string;
  command: string;
  args: string[];
}

const DEFAULT_PRESETS: AgentPreset[] = [
  {
    id: "agy",
    label: "AGY",
    badge: "AGY",
    command: "agy",
    args: [],
  },
  {
    id: "claude",
    label: "Claude",
    badge: "CC",
    command: "claude",
    args: [],
  },
  {
    id: "codex",
    label: "Codex",
    badge: "CX",
    command: "codex",
    args: [],
  },
  {
    id: "powershell",
    label: "Shell",
    badge: "PS",
    command: "powershell.exe",
    args: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
  },
];

interface CockpitSession {
  id: string;
  title: string;
  badge: string;
  command: string;
  args: string[];
  cwd: string;
  branch?: string;
  isWorktree?: boolean;
  hasCustomTitle: boolean;
  location: "editor" | "panel";
  terminal: vscode.Terminal;
  createdAt: number;
}

interface GitFileChange {
  status: string;
  file: string;
}

function summarizeFirstLine(raw: string, badge: string): string | null {
  const firstLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;

  // Ignore the initial agent launch command itself (e.g. "agy", "claude", "codex")
  const lower = firstLine.toLowerCase();
  if (
    lower === "agy" ||
    lower === "claude" ||
    lower === "codex" ||
    lower === "gemini" ||
    lower === "powershell" ||
    lower === "powershell.exe"
  ) {
    return null;
  }

  const cleaned = firstLine.replace(/\s+/g, " ").slice(0, 28);
  return `${badge} · ${cleaned}`;
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 6000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function findExecutableOnWindows(cmd: string): {
  shellPath?: string;
  shellArgs?: string[];
  initialCommand?: string;
} {
  const trimmed = cmd.trim();
  if (
    trimmed.toLowerCase() === "powershell.exe" ||
    trimmed.toLowerCase() === "powershell"
  ) {
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

class AgentCockpitProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentCockpit.sidebarView";

  private _view?: vscode.WebviewView;
  private _sessions: CockpitSession[] = [];
  private _activeSessionId: string | null = null;
  private _currentCwd: string;
  private _defaultLocation: "editor" | "panel" = "editor";

  constructor(private readonly _context: vscode.ExtensionContext) {
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
      if (!activeTerm) return;
      const found = this._sessions.find((s) => s.terminal === activeTerm);
      if (found && found.id !== this._activeSessionId) {
        this._activeSessionId = found.id;
        this._currentCwd = found.cwd;
        this.refreshWebviewState();
      }
    });

    // Auto-rename session based on first executed command via VS Code Shell Integration (if available)
    const winAny = vscode.window as unknown as {
      onDidStartTerminalShellExecution?: (
        listener: (e: {
          terminal: vscode.Terminal;
          execution: { commandLine?: { value?: string } };
        }) => void
      ) => vscode.Disposable;
    };

    if (typeof winAny.onDidStartTerminalShellExecution === "function") {
      this._context.subscriptions.push(
        winAny.onDidStartTerminalShellExecution((e) => {
          const sess = this._sessions.find((s) => s.terminal === e.terminal);
          if (!sess || sess.hasCustomTitle) return;
          const cmdValue = e.execution?.commandLine?.value || "";
          const autoTitle = summarizeFirstLine(cmdValue, sess.badge);
          if (autoTitle) {
            this.renameSession(sess.id, autoTitle);
          }
        })
      );
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView
  ): void | Thenable<void> {
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
        case "renameSession":
          if (typeof msg.id === "string" && typeof msg.title === "string") {
            await this.renameSession(msg.id, msg.title);
          }
          break;
        case "promptRenameSession":
          if (typeof msg.id === "string") {
            await this.promptRenameSession(msg.id);
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
          this.sendTextToActiveAgent(
            "Read .agent/handoff.md and continue.",
            false
          );
          break;
        case "refreshGit":
          await this.refreshWebviewState();
          break;
      }
    });
  }

  private async _handleBrowseCwd() {
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

  public async spawnSession(params: {
    title: string;
    badge: string;
    command: string;
    args: string[];
    cwd: string;
    location: "editor" | "panel";
    useWorktree?: boolean;
    worktreeName?: string;
  }) {
    let targetCwd = params.cwd.trim();
    if (!fs.existsSync(targetCwd) || !fs.statSync(targetCwd).isDirectory()) {
      vscode.window.showErrorMessage(`Directory does not exist: ${targetCwd}`);
      return;
    }

    let isWorktree = false;
    if (params.useWorktree) {
      const slug = (
        params.worktreeName || `wt-${Date.now().toString(36).slice(-4)}`
      )
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Worktree error: ${msg}`);
        return;
      }
    }

    let branch: string | undefined;
    try {
      branch = (
        await execGit(targetCwd, ["rev-parse", "--abbrev-ref", "HEAD"])
      ).trim();
    } catch {
      branch = undefined;
    }

    const folderShort = path.basename(targetCwd) || targetCwd;
    const termName = `${params.title} · ${folderShort}`;
    const resolved = findExecutableOnWindows(params.command);

    const terminalLocation =
      params.location === "editor"
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
      const fullCmd =
        params.args.length > 0
          ? `${resolved.initialCommand} ${params.args.join(" ")}`
          : resolved.initialCommand;
      terminal.sendText(fullCmd, true);
    }

    const id = `sess-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;

    const session: CockpitSession = {
      id,
      title: params.title,
      badge: params.badge,
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

  public async renameSession(id: string, newTitleRaw: string) {
    const trimmed = newTitleRaw.trim();
    if (!trimmed) return;
    const found = this._sessions.find((s) => s.id === id);
    if (!found) return;

    found.title = trimmed;
    found.hasCustomTitle = true;

    // Also update the VS Code terminal tab title
    try {
      found.terminal.show(true);
      await vscode.commands.executeCommand(
        "workbench.action.terminal.renameWithArg",
        { name: trimmed }
      );
    } catch {
      // ignore if command unavailable
    }

    await this.refreshWebviewState();
  }

  public async promptRenameSession(id?: string) {
    const targetId = id || this._activeSessionId;
    const found =
      this._sessions.find((s) => s.id === targetId) ??
      this._sessions[this._sessions.length - 1];
    if (!found) return;

    const input = await vscode.window.showInputBox({
      prompt: "Rename terminal session",
      value: found.title,
    });
    if (input && input.trim()) {
      await this.renameSession(found.id, input.trim());
    }
  }

  public sendQuickPromptToActiveAgent(promptText: string) {
    const active =
      this._sessions.find((s) => s.id === this._activeSessionId) ??
      this._sessions[this._sessions.length - 1];

    if (active && !active.hasCustomTitle) {
      const autoTitle = summarizeFirstLine(promptText, active.badge);
      if (autoTitle) {
        void this.renameSession(active.id, autoTitle);
      }
    }

    this.sendTextToActiveAgent(promptText, true);
  }

  public focusSessionByIndex(indexZeroBased: number) {
    if (indexZeroBased < 0 || indexZeroBased >= this._sessions.length) return;
    this.focusSessionById(this._sessions[indexZeroBased].id);
  }

  public focusSessionById(id: string) {
    const found = this._sessions.find((s) => s.id === id);
    if (!found) return;
    this._activeSessionId = found.id;
    this._currentCwd = found.cwd;
    found.terminal.show(false);
    this.refreshWebviewState();
  }

  public async closeSessionById(id: string) {
    const idx = this._sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
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

  public sendTextToActiveAgent(text: string, addNewLine = false) {
    const active =
      this._sessions.find((s) => s.id === this._activeSessionId) ??
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
      const autoTitle = summarizeFirstLine(text, active.badge);
      if (autoTitle) {
        void this.renameSession(active.id, autoTitle);
      }
    }

    active.terminal.show(false);
    active.terminal.sendText(text, addNewLine);
  }

  public sendActiveEditorSelectionToAgent(targetSessionId?: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Open a file in the editor first.");
      return;
    }

    if (targetSessionId) {
      this._activeSessionId = targetSessionId;
    }

    const activeSession =
      this._sessions.find((s) => s.id === this._activeSessionId) ??
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
    const refText =
      !sel.isEmpty && startLine !== endLine
        ? `@${relPath}:${startLine}-${endLine} `
        : `@${relPath}:${startLine} `;

    this.sendTextToActiveAgent(refText, false);
  }

  private async _openGitDiffForFile(relFile: string) {
    const fullPath = path.join(this._currentCwd, relFile);
    if (!fs.existsSync(fullPath)) return;
    const uri = vscode.Uri.file(fullPath);
    try {
      await vscode.commands.executeCommand("git.openChange", uri);
    } catch {
      await vscode.window.showTextDocument(uri);
    }
  }

  private _getHandoffPath(): string {
    return path.join(this._currentCwd, ".agent", "handoff.md");
  }

  private _readHandoffContent(): string {
    const p = this._getHandoffPath();
    try {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, "utf8");
      }
    } catch {
      // ignore
    }
    return "";
  }

  private _saveHandoffContent(content: string) {
    const p = this._getHandoffPath();
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
      vscode.window.setStatusBarMessage("Saved .agent/handoff.md", 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed saving handoff.md: ${msg}`);
    }
  }

  public async openHandoffInEditor() {
    const p = this._getHandoffPath();
    if (!fs.existsSync(p)) {
      this._saveHandoffContent("# Handoff Notes\n\n");
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
    await vscode.window.showTextDocument(doc);
  }

  private async _getGitChanges(cwd: string): Promise<{
    branch: string | null;
    changes: GitFileChange[];
  }> {
    try {
      const branch = (
        await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
      ).trim();
      const rawStatus = await execGit(cwd, ["status", "--porcelain"]);
      const changes: GitFileChange[] = rawStatus
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => ({
          status: line.slice(0, 2).trim() || "M",
          file: line.slice(3).trim(),
        }))
        .slice(0, 25);
      return { branch, changes };
    } catch {
      return { branch: null, changes: [] };
    }
  }

  public async refreshWebviewState() {
    if (!this._view) return;
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
        cwd: s.cwd,
        folderName: path.basename(s.cwd) || s.cwd,
        branch: s.branch,
        isWorktree: s.isWorktree,
      })),
    });
  }

  private _getHtmlForWebview(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --surface: rgba(255, 255, 255, 0.035);
      --surface-hover: rgba(255, 255, 255, 0.075);
      --border: rgba(255, 255, 255, 0.08);
      --accent: var(--vscode-button-background, #2f81f7);
      --muted: var(--vscode-descriptionForeground, #7d8590);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 12px;
      color: var(--vscode-foreground);
      background: transparent;
      padding: 8px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 8px;
      user-select: none;
    }

    /* Top workspace bar */
    .top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
    }
    .cwd-pill {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 5px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 4px 8px;
      cursor: pointer;
      overflow: hidden;
      font-size: 11.5px;
      color: var(--vscode-foreground);
    }
    .cwd-pill:hover { background: var(--surface-hover); }
    .cwd-name {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .branch-tag {
      font-size: 10px;
      color: var(--muted);
      margin-left: auto;
      white-space: nowrap;
    }
    .icon-toggle {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: 5px;
      padding: 4px 6px;
      font-size: 10.5px;
      cursor: pointer;
    }
    .icon-toggle:hover { color: var(--vscode-foreground); background: var(--surface-hover); }
    .icon-toggle.active {
      color: #79c0ff;
      border-color: rgba(56, 139, 253, 0.45);
      background: rgba(56, 139, 253, 0.14);
    }

    /* Compact 1-Row Launch Bar */
    .launch-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr) 26px;
      gap: 4px;
    }
    .launch-btn {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--vscode-foreground);
      border-radius: 5px;
      padding: 5px 4px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      text-align: center;
      transition: background 0.1s, border-color 0.1s;
    }
    .launch-btn:hover {
      background: var(--surface-hover);
      border-color: rgba(255, 255, 255, 0.2);
    }

    /* Optional Custom Popover */
    .custom-drawer {
      display: none;
      flex-direction: column;
      gap: 4px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 6px;
    }
    .custom-drawer.open { display: flex; }

    input[type="text"], textarea {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 11px;
      font-family: inherit;
    }
    input[type="text"]:focus, textarea:focus {
      outline: none;
      border-color: var(--accent);
    }

    /* Minimal Session List */
    .sessions-container {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .session-row {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 8px;
      border-radius: 5px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 0.1s;
    }
    .session-row:hover {
      background: var(--surface);
    }
    .session-row.active {
      background: rgba(47, 129, 247, 0.13);
      border-color: rgba(47, 129, 247, 0.4);
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #3fb950;
      flex-shrink: 0;
    }
    .s-title {
      flex: 1;
      font-weight: 500;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .s-rename-input {
      flex: 1;
      padding: 2px 5px !important;
      font-size: 11.5px !important;
    }
    .s-folder {
      font-size: 10.5px;
      color: var(--muted);
      margin-left: auto;
      white-space: nowrap;
    }
    .row-actions {
      display: none;
      align-items: center;
      gap: 2px;
      margin-left: 4px;
    }
    .session-row:hover .row-actions { display: flex; }
    .session-row:hover .s-folder { display: none; }

    .mini-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 11px;
    }
    .mini-btn:hover {
      color: var(--vscode-foreground);
      background: var(--surface-hover);
    }
    .empty-state {
      margin: auto;
      color: var(--muted);
      font-size: 11px;
      text-align: center;
    }

    /* Quick prompt bar (also auto-renames on first line) */
    .quick-prompt-row {
      display: flex;
      gap: 4px;
    }

    /* Minimal Footer Tabs (Git & Notes) */
    .footer-bar {
      border-top: 1px solid var(--border);
      padding-top: 6px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .footer-tabs {
      display: flex;
      gap: 4px;
    }
    .footer-tab {
      flex: 1;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 10.5px;
      cursor: pointer;
      text-align: center;
    }
    .footer-tab:hover, .footer-tab.active {
      color: var(--vscode-foreground);
      border-color: rgba(255, 255, 255, 0.22);
    }
    .drawer-pane {
      display: none;
      flex-direction: column;
      gap: 4px;
      max-height: 140px;
      overflow-y: auto;
    }
    .drawer-pane.open { display: flex; }
    .git-row {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      padding: 3px 4px;
      border-radius: 4px;
    }
    .git-row:hover { background: var(--surface); }
    .git-st { color: #e3b341; font-family: monospace; font-size: 10px; width: 14px; }
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
  <!-- Compact Workspace & Mode Row -->
  <div class="top-bar">
    <div id="cwd-pill" class="cwd-pill" title="Click to change folder">
      <span>📁</span>
      <span id="cwd-name" class="cwd-name">workspace</span>
      <span id="branch-tag" class="branch-tag"></span>
    </div>
    <button id="loc-toggle" class="icon-toggle active" title="Toggle Editor Tab vs Bottom Panel">
      Tab
    </button>
    <button id="wt-toggle" class="icon-toggle" title="Isolate next session in a new Git Worktree">
      WT
    </button>
  </div>

  <!-- 1-Row Quick Launch Bar -->
  <div class="launch-bar">
    <div id="preset-buttons" style="display:contents;"></div>
    <button id="custom-toggle" class="launch-btn" title="Custom command">+</button>
  </div>

  <div id="custom-drawer" class="custom-drawer">
    <input id="custom-cmd" type="text" placeholder="Command (e.g. agy, claude, aider)" />
  </div>

  <!-- Clean Session List (Double-click or click ✎ to rename) -->
  <div id="session-list" class="sessions-container"></div>

  <!-- Collapsible Footer (Quick Prompt, Git & Handoff) -->
  <div class="footer-bar">
    <div class="quick-prompt-row">
      <input
        id="quick-prompt-input"
        type="text"
        placeholder="Send prompt to active agent (auto-names tab)…"
      />
    </div>
    <div id="git-drawer" class="drawer-pane"></div>
    <div id="notes-drawer" class="drawer-pane">
      <textarea id="handoff-text" rows="3" placeholder="Shared handoff notes (.agent/handoff.md)…"></textarea>
      <div style="display:flex;gap:4px;">
        <button id="save-notes" class="footer-tab">Save</button>
        <button id="send-notes" class="footer-tab">Send to Agent</button>
      </div>
    </div>
    <div class="footer-tabs">
      <button id="tab-git" class="footer-tab">Git (<span id="git-count">0</span>)</button>
      <button id="tab-notes" class="footer-tab">Notes</button>
      <button id="tab-send" class="footer-tab" title="Send editor @file:line selection (Ctrl+Alt+S)">@Line</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let state = {
      currentCwd: "",
      defaultLocation: "editor",
      useWorktree: false,
      activeFooter: null,
      editingId: null,
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
    const sessionList = document.getElementById("session-list");
    const quickPromptInput = document.getElementById("quick-prompt-input");
    const gitDrawer = document.getElementById("git-drawer");
    const notesDrawer = document.getElementById("notes-drawer");
    const gitCount = document.getElementById("git-count");
    const handoffText = document.getElementById("handoff-text");

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

    customCmd.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && customCmd.value.trim()) {
        const parts = customCmd.value.trim().split(/\\s+/);
        vscode.postMessage({
          type: "spawnSession",
          title: parts[0],
          badge: "CLI",
          command: parts[0],
          args: parts.slice(1),
          cwd: state.currentCwd,
          location: state.defaultLocation,
          useWorktree: state.useWorktree,
        });
        customCmd.value = "";
        customDrawer.classList.remove("open");
      }
    });

    quickPromptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && quickPromptInput.value.trim()) {
        vscode.postMessage({
          type: "sendQuickPrompt",
          prompt: quickPromptInput.value.trim(),
        });
        quickPromptInput.value = "";
      }
    });

    document.getElementById("tab-git").addEventListener("click", () => {
      state.activeFooter = state.activeFooter === "git" ? null : "git";
      gitDrawer.classList.toggle("open", state.activeFooter === "git");
      notesDrawer.classList.remove("open");
      if (state.activeFooter === "git") vscode.postMessage({ type: "refreshGit" });
    });

    document.getElementById("tab-notes").addEventListener("click", () => {
      state.activeFooter = state.activeFooter === "notes" ? null : "notes";
      notesDrawer.classList.toggle("open", state.activeFooter === "notes");
      gitDrawer.classList.remove("open");
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
      branchTag.textContent = msg.gitBranch ? msg.gitBranch : "";

      locToggle.textContent = msg.defaultLocation === "editor" ? "Tab" : "Panel";
      locToggle.classList.toggle("active", msg.defaultLocation === "editor");

      // Presets
      presetButtons.innerHTML = "";
      (msg.presets || []).forEach((p) => {
        const btn = document.createElement("button");
        btn.className = "launch-btn";
        btn.textContent = p.label;
        btn.title = "Launch " + p.label + " (" + p.command + ")";
        btn.addEventListener("click", () => {
          vscode.postMessage({
            type: "spawnSession",
            title: p.label,
            badge: p.badge,
            command: p.command,
            args: p.args,
            cwd: state.currentCwd,
            location: state.defaultLocation,
            useWorktree: state.useWorktree,
          });
        });
        presetButtons.appendChild(btn);
      });

      // Sessions
      sessionList.innerHTML = "";
      if (!msg.sessions || msg.sessions.length === 0) {
        sessionList.innerHTML = '<div class="empty-state">Click an agent above to start</div>';
      } else {
        msg.sessions.forEach((s) => {
          const row = document.createElement("div");
          row.className = "session-row" + (s.id === msg.activeSessionId ? " active" : "");
          row.title = "Click to focus · Double-click title to rename";
          row.innerHTML =
            '<span class="dot"></span>' +
            '<span class="s-title">' + s.title + '</span>' +
            '<span class="s-folder">' + s.folderName + '</span>' +
            '<div class="row-actions">' +
              '<button class="mini-btn act-rename" title="Rename">✎</button>' +
              '<button class="mini-btn act-send" title="Send @file:line">@</button>' +
              '<button class="mini-btn act-close" title="Close">✕</button>' +
            '</div>';

          row.addEventListener("click", () => {
            vscode.postMessage({ type: "focusSession", id: s.id });
          });
          row.querySelector(".s-title").addEventListener("dblclick", (e) => {
            e.stopPropagation();
            startInlineRename(row, s);
          });
          row.querySelector(".act-rename").addEventListener("click", (e) => {
            e.stopPropagation();
            startInlineRename(row, s);
          });
          row.querySelector(".act-send").addEventListener("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "sendSelection", id: s.id });
          });
          row.querySelector(".act-close").addEventListener("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "closeSession", id: s.id });
          });
          sessionList.appendChild(row);
        });
      }

      // Git
      const changes = msg.gitChanges || [];
      gitCount.textContent = String(changes.length);
      gitDrawer.innerHTML = "";
      if (changes.length === 0) {
        gitDrawer.innerHTML = '<div class="empty-state" style="padding:6px 0;">Clean working tree</div>';
      } else {
        changes.forEach((c) => {
          const r = document.createElement("div");
          r.className = "git-row";
          r.innerHTML =
            '<span class="git-st">' + c.status + '</span>' +
            '<span class="git-path" title="Click to view diff">' + c.file + '</span>' +
            '<button class="mini-btn">@</button>';
          r.querySelector(".git-path").addEventListener("click", () => {
            vscode.postMessage({ type: "openFileDiff", file: c.file });
          });
          r.querySelector(".mini-btn").addEventListener("click", () => {
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

export function activate(context: vscode.ExtensionContext) {
  const provider = new AgentCockpitProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AgentCockpitProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentCockpit.newSession", async () => {
      const picked = await vscode.window.showQuickPick(
        [
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
        ],
        { placeHolder: "Launch Agent" }
      );
      if (!picked) return;

      const wsFolder =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "D:\\Thulir Inc";
      const cwd = await vscode.window.showInputBox({
        prompt: "Working Directory (cwd)",
        value: wsFolder,
      });
      if (!cwd) return;

      if (picked.preset) {
        await provider.spawnSession({
          title: picked.preset.label,
          badge: picked.preset.badge,
          command: picked.preset.command,
          args: picked.preset.args,
          cwd,
          location: "editor",
        });
      } else {
        const customCmd = await vscode.window.showInputBox({
          prompt: "CLI executable",
        });
        if (!customCmd) return;
        await provider.spawnSession({
          title: customCmd,
          badge: "CLI",
          command: customCmd,
          args: [],
          cwd,
          location: "editor",
        });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentCockpit.renameSession", () => {
      void provider.promptRenameSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentCockpit.sendSelection", () => {
      provider.sendActiveEditorSelectionToAgent();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentCockpit.openHandoff", () => {
      provider.openHandoffInEditor();
    })
  );

  for (let i = 1; i <= 5; i++) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`agentCockpit.switchSession${i}`, () => {
        provider.focusSessionByIndex(i - 1);
      })
    );
  }
}

export function deactivate() {}
