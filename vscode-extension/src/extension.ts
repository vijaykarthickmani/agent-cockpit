import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { execFile } from "child_process";

type RuntimeState = "working" | "needs-input" | "idle" | "stopped";

interface AgentPreset {
  id: string;
  label: string;
  badge: string;
  color: string;
  command: string;
  args: string[];
}

const DEFAULT_PRESETS: AgentPreset[] = [
  {
    id: "agy",
    label: "AGY",
    badge: "✦",
    color: "#3b82f6",
    command: "agy",
    args: [],
  },
  {
    id: "claude",
    label: "Claude",
    badge: "C",
    color: "#e07a5f",
    command: "claude",
    args: [],
  },
  {
    id: "codex",
    label: "Codex",
    badge: "X",
    color: "#10b981",
    command: "codex",
    args: [],
  },
  {
    id: "powershell",
    label: "Shell",
    badge: ">_",
    color: "#64748b",
    command: "powershell.exe",
    args: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
  },
];

interface StoredSessionMeta {
  id: string;
  cliSessionId?: string;
  cliSessionName?: string;
  title: string;
  badge: string;
  color: string;
  command: string;
  args: string[];
  cwd: string;
  branch?: string;
  isWorktree?: boolean;
  hasCustomTitle: boolean;
  userRenamed?: boolean;
  location: "editor" | "panel";
  createdAt: number;
}

interface CockpitSession extends StoredSessionMeta {
  status: RuntimeState;
  lastActivityAt: number;
  terminal?: vscode.Terminal;
}

interface GitFileChange {
  status: string;
  file: string;
}

interface DiscoveredCliSession {
  cliSessionId: string;
  title: string;
  cwd: string;
  mtimeMs: number;
  runtimeHint: "working" | "needs-input" | "idle";
  agentType: "claude" | "agy";
}

const STORAGE_KEY = "agentCockpit.retainedSessions.v3";
const DISMISSED_KEY = "agentCockpit.dismissedCliIds.v1";

function isTerminalAlive(term?: vscode.Terminal): term is vscode.Terminal {
  if (!term) return false;
  if (term.exitStatus !== undefined) return false;
  return vscode.window.terminals.includes(term);
}

/**
 * Safely quote a file path or @file:line reference if it contains spaces
 */
function formatAtFileRef(relPath: string, lineRange?: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const suffix = lineRange ? `:${lineRange}` : "";
  if (/\s/.test(normalized)) {
    return `@"${normalized}${suffix}" `;
  }
  return `@${normalized}${suffix} `;
}

function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function discoverAgySessions(defaultCwd: string): DiscoveredCliSession[] {
  const results: DiscoveredCliSession[] = [];
  const home = os.homedir();
  const agyRoot = path.join(home, ".gemini", "antigravity-cli");
  const annotationsDir = path.join(agyRoot, "annotations");
  const brainDir = path.join(agyRoot, "brain");

  const ids = new Set<string>();
  if (fs.existsSync(annotationsDir)) {
    try {
      for (const f of fs.readdirSync(annotationsDir)) {
        if (f.endsWith(".pbtxt")) {
          ids.add(path.basename(f, ".pbtxt"));
        }
      }
    } catch {
      // ignore
    }
  }
  if (fs.existsSync(brainDir)) {
    try {
      for (const d of fs.readdirSync(brainDir)) {
        if (/^[0-9a-fA-F-]{32,36}$/.test(d)) {
          ids.add(d);
        }
      }
    } catch {
      // ignore
    }
  }

  const now = Date.now();
  for (const convId of ids) {
    let title: string | null = null;
    let mtimeMs = 0;
    let runtimeHint: "working" | "needs-input" | "idle" = "idle";

    const pbtxtPath = path.join(annotationsDir, `${convId}.pbtxt`);
    if (fs.existsSync(pbtxtPath)) {
      try {
        const stat = fs.statSync(pbtxtPath);
        mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
        const raw = fs.readFileSync(pbtxtPath, "utf8");
        const match = raw.match(/title:\s*"([^"]+)"/);
        if (match && match[1].trim()) {
          title = match[1].trim();
        }
      } catch {
        // ignore
      }
    }

    const transcriptPath = path.join(
      brainDir,
      convId,
      ".system_generated",
      "logs",
      "transcript.jsonl"
    );
    if (fs.existsSync(transcriptPath)) {
      try {
        const stat = fs.statSync(transcriptPath);
        mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
        const content = fs.readFileSync(transcriptPath, "utf8");
        const lines = content.split(/\r?\n/).filter((l) => l.trim());
        if (!title && lines.length > 0) {
          const obj = JSON.parse(lines[0]);
          if (typeof obj.content === "string") {
            const reqMatch = obj.content.match(
              /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/
            );
            const candidate = (reqMatch ? reqMatch[1] : obj.content).trim();
            if (candidate) {
              title = candidate.replace(/\s+/g, " ").slice(0, 32);
            }
          }
        }
        if (lines.length > 0) {
          const lastObj = JSON.parse(lines[lines.length - 1]);
          if (now - stat.mtimeMs < 4500) {
            runtimeHint = "working";
          } else if (
            typeof lastObj.content === "string" &&
            /\?\s*$|\[y\/n\]|approve|allow/i.test(lastObj.content.slice(-200))
          ) {
            runtimeHint = "needs-input";
          }
        }
      } catch {
        // ignore
      }
    }

    if (title) {
      results.push({
        cliSessionId: convId,
        title,
        cwd: defaultCwd,
        mtimeMs: mtimeMs || now,
        runtimeHint,
        agentType: "agy",
      });
    }
  }

  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function parseClaudeJsonlMeta(filePath: string): {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  runtimeHint: "working" | "needs-input" | "idle";
} {
  const sessionId = path.basename(filePath, ".jsonl");
  let customTitle: string | null = null;
  let firstUserPrompt: string | null = null;
  let detectedCwd: string | null = null;
  let lastRole: string | null = null;
  let lastText = "";

  try {
    const stat = fs.statSync(filePath);
    const isVeryRecent = Date.now() - stat.mtimeMs < 4500;
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (!detectedCwd && typeof obj.cwd === "string") {
          detectedCwd = obj.cwd;
        }
        if (
          obj.type === "custom-title" &&
          typeof obj.customTitle === "string" &&
          obj.customTitle.trim()
        ) {
          customTitle = obj.customTitle.trim();
        } else if (
          obj.type === "summary" &&
          typeof obj.summary === "string" &&
          obj.summary.trim()
        ) {
          customTitle = obj.summary.trim();
        } else if (
          typeof obj.sessionName === "string" &&
          obj.sessionName.trim()
        ) {
          customTitle = obj.sessionName.trim();
        } else if (obj.type === "user" && obj.message?.role === "user") {
          lastRole = "user";
          const rawContent = obj.message.content;
          if (!firstUserPrompt) {
            if (typeof rawContent === "string" && rawContent.trim()) {
              firstUserPrompt = rawContent.trim();
            } else if (Array.isArray(rawContent)) {
              const textPart = rawContent.find(
                (p: { type?: string; text?: string }) =>
                  p && p.type === "text" && typeof p.text === "string"
              );
              if (textPart && textPart.text.trim()) {
                firstUserPrompt = textPart.text.trim();
              }
            }
          }
        } else if (
          obj.type === "assistant" &&
          obj.message?.role === "assistant"
        ) {
          lastRole = "assistant";
          const rawContent = obj.message.content;
          if (Array.isArray(rawContent)) {
            const toolUse = rawContent.find(
              (p: { type?: string }) => p && p.type === "tool_use"
            );
            const textPart = rawContent.find(
              (p: { type?: string; text?: string }) =>
                p && p.type === "text" && typeof p.text === "string"
            );
            lastText = toolUse
              ? "[tool_use]"
              : textPart?.text || "";
          }
        }
      } catch {
        // skip
      }
    }

    let runtimeHint: "working" | "needs-input" | "idle" = "idle";
    if (isVeryRecent || lastRole === "user") {
      runtimeHint = "working";
    } else if (
      lastText === "[tool_use]" ||
      /\?\s*$|\[y\/n\]|approve|allow/i.test(lastText.slice(-180))
    ) {
      runtimeHint = "needs-input";
    }

    const chosen = customTitle || firstUserPrompt;
    const cleaned = chosen
      ? chosen.replace(/\s+/g, " ").trim().slice(0, 32)
      : null;

    return {
      sessionId,
      title: cleaned,
      cwd: detectedCwd,
      runtimeHint,
    };
  } catch {
    return {
      sessionId,
      title: null,
      cwd: null,
      runtimeHint: "idle",
    };
  }
}

function discoverClaudeSessionsForCwd(cwd: string): DiscoveredCliSession[] {
  const results: DiscoveredCliSession[] = [];
  const home = os.homedir();
  const projectsRoot = path.join(home, ".claude", "projects");
  if (!fs.existsSync(projectsRoot)) return results;

  const targetSlug = claudeProjectSlug(cwd).toLowerCase();
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return results;
  }

  for (const dirName of dirs) {
    if (dirName.toLowerCase() !== targetSlug) continue;
    const fullDir = path.join(projectsRoot, dirName);
    let files: string[] = [];
    try {
      files = fs.readdirSync(fullDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const fullPath = path.join(fullDir, file);
      try {
        const stat = fs.statSync(fullPath);
        const meta = parseClaudeJsonlMeta(fullPath);
        if (meta.title) {
          results.push({
            cliSessionId: meta.sessionId,
            title: meta.title,
            cwd: meta.cwd || cwd,
            mtimeMs: stat.mtimeMs,
            runtimeHint: meta.runtimeHint,
            agentType: "claude",
          });
        }
      } catch {
        // ignore
      }
    }
  }

  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function summarizeFirstLine(raw: string, label: string): string | null {
  const firstLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;

  const lower = firstLine.toLowerCase();
  if (
    lower === "agy" ||
    lower === "claude" ||
    lower === "codex" ||
    lower === "gemini" ||
    lower === "powershell" ||
    lower === "powershell.exe" ||
    lower.startsWith("claude ") ||
    lower.startsWith("agy ") ||
    lower.startsWith("gemini ") ||
    lower.startsWith("codex ")
  ) {
    return null;
  }

  const cleaned = firstLine.replace(/\s+/g, " ").slice(0, 28);
  const baseLabel = label.split("·")[0].trim();
  return `${baseLabel} · ${cleaned}`;
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

function buildShellLaunch(
  session: CockpitSession,
  isResume: boolean
): {
  shellPath: string;
  shellArgs: string[];
  initialCommand?: string;
} {
  const trimmed = session.command.trim();
  const lower = trimmed.toLowerCase();
  const extraArgs = session.args.length > 0 ? ` ${session.args.join(" ")}` : "";
  const sessionId = session.cliSessionId;
  const safeName = (session.cliSessionName || session.title || "")
    .replace(/"/g, "")
    .trim();

  if (lower === "powershell.exe" || lower === "powershell") {
    return {
      shellPath: "powershell.exe",
      shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
    };
  }
  if (lower === "cmd.exe" || lower === "cmd") {
    return { shellPath: "cmd.exe", shellArgs: [] };
  }

  if (lower === "agy" || lower === "agy.cmd" || lower === "agy.exe") {
    if (isResume) {
      if (sessionId) {
        return {
          shellPath: "powershell.exe",
          shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
          initialCommand: `agy --conversation "${sessionId}"${extraArgs}; if ($LASTEXITCODE -ne 0) { agy --continue${extraArgs} }; if ($LASTEXITCODE -ne 0) { agy${extraArgs} }`,
        };
      }
      return {
        shellPath: "powershell.exe",
        shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
        initialCommand: `agy --continue${extraArgs}; if ($LASTEXITCODE -ne 0) { agy${extraArgs} }`,
      };
    }
    return {
      shellPath: "powershell.exe",
      shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
      initialCommand: `agy${extraArgs}`,
    };
  }

  if (lower === "claude" || lower === "claude.exe") {
    const nameArg =
      session.hasCustomTitle && safeName ? ` -n "${safeName}"` : "";
    if (isResume) {
      const targetKey = sessionId || session.cliSessionName;
      if (targetKey) {
        return {
          shellPath: "powershell.exe",
          shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
          initialCommand: `claude --resume "${targetKey}"${nameArg}${extraArgs}; if ($LASTEXITCODE -ne 0) { claude --continue${nameArg}${extraArgs} }; if ($LASTEXITCODE -ne 0) { claude${
            sessionId ? ` --session-id "${sessionId}"` : ""
          }${nameArg}${extraArgs} }`,
        };
      }
      return {
        shellPath: "powershell.exe",
        shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
        initialCommand: `claude --continue${nameArg}${extraArgs}; if ($LASTEXITCODE -ne 0) { claude${extraArgs} }`,
      };
    }

    return {
      shellPath: "powershell.exe",
      shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
      initialCommand: `claude${
        sessionId ? ` --session-id "${sessionId}"` : ""
      }${nameArg}${extraArgs}`,
    };
  }

  if (lower === "gemini" || lower === "gemini.cmd") {
    if (isResume) {
      const resumeTarget = sessionId || "latest";
      return {
        shellPath: "powershell.exe",
        shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
        initialCommand: `gemini --resume "${resumeTarget}"${extraArgs}; if ($LASTEXITCODE -ne 0) { gemini --resume latest${extraArgs} }; if ($LASTEXITCODE -ne 0) { gemini${extraArgs} }`,
      };
    }
    return {
      shellPath: "powershell.exe",
      shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
      initialCommand: `gemini${extraArgs}`,
    };
  }

  if (lower === "codex" || lower === "codex.cmd") {
    if (isResume) {
      return {
        shellPath: "powershell.exe",
        shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
        initialCommand: `codex resume --last${extraArgs}; if ($LASTEXITCODE -ne 0) { codex${extraArgs} }`,
      };
    }
  }

  return {
    shellPath: "powershell.exe",
    shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
    initialCommand: `${trimmed}${extraArgs}`,
  };
}

class AgentCockpitProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "agentCockpit.sidebarView";

  private _view?: vscode.WebviewView;
  private _sessions: CockpitSession[] = [];
  private _dismissedCliIds: Set<string>;
  private _activeSessionId: string | null = null;
  private _currentCwd: string;
  private _defaultLocation: "editor" | "panel" = "editor";
  private _singleTabZen = true;
  private _pollTimer: NodeJS.Timeout;

  constructor(private readonly _context: vscode.ExtensionContext) {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this._currentCwd = wsFolder || "D:\\Thulir Inc";

    const savedDismissed =
      this._context.globalState.get<string[]>(DISMISSED_KEY) || [];
    this._dismissedCliIds = new Set<string>(savedDismissed);

    const saved =
      this._context.globalState.get<StoredSessionMeta[]>(STORAGE_KEY) || [];
    // Filter out any previously auto-imported historical sessions or dismissed sessions
    this._sessions = saved
      .filter(
        (meta) =>
          !meta.id.startsWith("sess-agy-") &&
          !meta.id.startsWith("sess-cli-") &&
          (!meta.cliSessionId || !this._dismissedCliIds.has(meta.cliSessionId))
      )
      .map((meta) => ({
        ...meta,
        status: "stopped",
        lastActivityAt: meta.createdAt,
        terminal: undefined,
      }));

    this._syncCliStoredSessionNames();

    if (this._sessions.length > 0) {
      this._activeSessionId = this._sessions[this._sessions.length - 1].id;
    }

    this._pollTimer = setInterval(() => {
      if (this._syncCliStoredSessionNames()) {
        void this.refreshWebviewState();
      }
    }, 2500);
    this._context.subscriptions.push({
      dispose: () => clearInterval(this._pollTimer),
    });

    vscode.window.onDidCloseTerminal((closedTerm) => {
      let changed = false;
      for (const s of this._sessions) {
        if (s.terminal === closedTerm || !isTerminalAlive(s.terminal)) {
          if (s.status !== "stopped" || s.terminal !== undefined) {
            s.terminal = undefined;
            s.status = "stopped";
            changed = true;
          }
        }
      }
      this._syncCliStoredSessionNames();
      if (changed) {
        this._persistSessions();
        void this.refreshWebviewState();
      }
    });

    vscode.window.onDidChangeActiveTerminal((activeTerm) => {
      if (!activeTerm) return;
      const found = this._sessions.find((s) => s.terminal === activeTerm);
      if (found && found.id !== this._activeSessionId) {
        this._activeSessionId = found.id;
        this._currentCwd = found.cwd;
        void this.refreshWebviewState();
      }
    });

    const winAny = vscode.window as unknown as {
      onDidStartTerminalShellExecution?: (
        listener: (e: {
          terminal: vscode.Terminal;
          execution: { commandLine?: { value?: string } };
        }) => void
      ) => vscode.Disposable;
      onDidEndTerminalShellExecution?: (
        listener: (e: { terminal: vscode.Terminal }) => void
      ) => vscode.Disposable;
    };

    if (typeof winAny.onDidStartTerminalShellExecution === "function") {
      this._context.subscriptions.push(
        winAny.onDidStartTerminalShellExecution((e) => {
          const sess = this._sessions.find((s) => s.terminal === e.terminal);
          if (!sess) return;
          sess.status = "working";
          sess.lastActivityAt = Date.now();
          if (!sess.userRenamed) {
            const cmdValue = e.execution?.commandLine?.value || "";
            const autoTitle = summarizeFirstLine(cmdValue, sess.title);
            if (autoTitle) {
              void this.renameSession(sess.id, autoTitle, false);
              return;
            }
          }
          void this.refreshWebviewState();
        })
      );
    }

    if (typeof winAny.onDidEndTerminalShellExecution === "function") {
      this._context.subscriptions.push(
        winAny.onDidEndTerminalShellExecution((e) => {
          const sess = this._sessions.find((s) => s.terminal === e.terminal);
          if (!sess) return;
          if (isTerminalAlive(sess.terminal)) {
            sess.status = "idle";
            void this.refreshWebviewState();
          }
        })
      );
    }
  }

  /**
   * Toggle VS Code's top editor tab bar visibility so the left sidebar can act as the
   * single source of truth without a redundant duplicate top tab strip (+35px height).
   */
  private async _toggleTopEditorTabBar() {
    const wbConfig = vscode.workspace.getConfiguration("workbench.editor");
    const current = wbConfig.get<string>("showTabs") || "multiple";
    const next = current === "none" ? "multiple" : "none";
    try {
      await wbConfig.update(
        "showTabs",
        next,
        vscode.ConfigurationTarget.Global
      );
      this._singleTabZen = next === "none";
    } catch {
      // Fallback command
      await vscode.commands.executeCommand(
        next === "none"
          ? "workbench.action.hideEditorTabs"
          : "workbench.action.showMultipleEditorTabs"
      );
    }
    await this.refreshWebviewState();
  }

  private _syncCliStoredSessionNames(): boolean {
    let changed = false;

    const agyDiscovered = discoverAgySessions(this._currentCwd);
    for (const disc of agyDiscovered) {
      if (this._dismissedCliIds.has(disc.cliSessionId)) continue;

      let match = this._sessions.find(
        (s) => s.cliSessionId === disc.cliSessionId
      );

      if (!match) {
        // Bind to an unbound AGY session launched in Agent Cockpit after or near this conversation's timestamp
        match = this._sessions.find(
          (s) =>
            s.command.toLowerCase().startsWith("agy") &&
            !s.cliSessionId &&
            !this._sessions.some((other) => other.cliSessionId === disc.cliSessionId) &&
            disc.mtimeMs >= s.createdAt - 15000
        );
        if (match) {
          match.cliSessionId = disc.cliSessionId;
          changed = true;
        }
      }

      if (match) {
        match.cliSessionName = disc.title;
        if (isTerminalAlive(match.terminal)) {
          if (match.status !== disc.runtimeHint) {
            match.status = disc.runtimeHint;
            changed = true;
          }
        }
        if (!match.userRenamed && match.title !== disc.title) {
          match.title = disc.title;
          match.hasCustomTitle = true;
          changed = true;
          if (isTerminalAlive(match.terminal)) {
            void vscode.commands
              .executeCommand("workbench.action.terminal.renameWithArg", {
                name: disc.title,
              })
              .then(undefined, () => {});
          }
        }
      }
    }

    const cwdsToScan = new Set<string>([this._currentCwd]);
    for (const s of this._sessions) {
      if (s.cwd) cwdsToScan.add(s.cwd);
    }

    for (const cwd of cwdsToScan) {
      const discovered = discoverClaudeSessionsForCwd(cwd);
      for (const disc of discovered) {
        if (this._dismissedCliIds.has(disc.cliSessionId)) continue;

        let match = this._sessions.find(
          (s) => s.cliSessionId === disc.cliSessionId
        );

        if (!match) {
          match = this._sessions.find(
            (s) =>
              s.command.toLowerCase().startsWith("claude") &&
              s.cwd.toLowerCase() === cwd.toLowerCase() &&
              !discovered.some((d) => d.cliSessionId === s.cliSessionId) &&
              disc.mtimeMs >= s.createdAt - 15000
          );
          if (match) {
            match.cliSessionId = disc.cliSessionId;
            changed = true;
          }
        }

        if (match) {
          match.cliSessionName = disc.title;
          if (isTerminalAlive(match.terminal)) {
            if (match.status !== disc.runtimeHint) {
              match.status = disc.runtimeHint;
              changed = true;
            }
          }
          if (!match.userRenamed && match.title !== disc.title) {
            match.title = disc.title;
            match.hasCustomTitle = true;
            changed = true;
            if (isTerminalAlive(match.terminal)) {
              void vscode.commands
                .executeCommand("workbench.action.terminal.renameWithArg", {
                  name: disc.title,
                })
                .then(undefined, () => {});
            }
          }
        }
      }
    }

    if (changed) {
      this._persistSessions();
    }
    return changed;
  }

  private _syncLiveness() {
    for (const s of this._sessions) {
      if (isTerminalAlive(s.terminal)) {
        if (s.status === "stopped") {
          s.status = "idle";
        }
      } else {
        s.terminal = undefined;
        s.status = "stopped";
      }
    }
  }

  private _persistSessions() {
    const serializable: StoredSessionMeta[] = this._sessions.map((s) => ({
      id: s.id,
      cliSessionId: s.cliSessionId,
      cliSessionName: s.cliSessionName,
      title: s.title,
      badge: s.badge,
      color: s.color,
      command: s.command,
      args: s.args,
      cwd: s.cwd,
      branch: s.branch,
      isWorktree: s.isWorktree,
      hasCustomTitle: s.hasCustomTitle,
      userRenamed: s.userRenamed,
      location: s.location,
      createdAt: s.createdAt,
    }));
    void this._context.globalState.update(STORAGE_KEY, serializable);
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
          this._syncCliStoredSessionNames();
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
        case "toggleTopTabs":
          await this._toggleTopEditorTabBar();
          break;
        case "spawnSession":
          await this.spawnSession({
            title: msg.title,
            badge: msg.badge || ">_",
            color: msg.color || "#3b82f6",
            command: msg.command,
            args: msg.args || [],
            cwd: msg.cwd || this._currentCwd,
            location: msg.location || this._defaultLocation,
            useWorktree: Boolean(msg.useWorktree),
            worktreeName: msg.worktreeName || "",
          });
          break;
        case "focusSession":
          await this.focusOrRelaunchSessionById(msg.id);
          break;
        case "relaunchSession":
          await this.relaunchSessionById(msg.id, true);
          break;
        case "renameSession":
          if (typeof msg.id === "string" && typeof msg.title === "string") {
            await this.renameSession(msg.id, msg.title, true);
          }
          break;
        case "sendQuickPrompt":
          if (typeof msg.prompt === "string" && msg.prompt.trim()) {
            await this.sendQuickPromptToActiveAgent(msg.prompt.trim());
          }
          break;
        case "deleteSession":
          await this.deleteSessionById(msg.id);
          break;
        case "sendSelection":
          await this.sendActiveEditorSelectionToAgent(msg.id);
          break;
        case "mentionFile":
          await this.sendTextToActiveAgent(formatAtFileRef(msg.file), false);
          break;
        case "openFileDiff":
          await this._openGitDiffForFile(msg.file);
          break;
        case "saveHandoff":
          this._saveHandoffContent(msg.content || "");
          break;
        case "sendHandoff":
          this._saveHandoffContent(msg.content || "");
          await this.sendTextToActiveAgent(
            "Read .agent/handoff.md and continue.",
            false
          );
          break;
        case "refreshGit":
          this._syncCliStoredSessionNames();
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
      this._syncCliStoredSessionNames();
      await this.refreshWebviewState();
    }
  }

  private _createVsTerminalForSession(
    session: CockpitSession,
    isResume: boolean
  ): vscode.Terminal {
    const folderShort = path.basename(session.cwd) || session.cwd;
    const termName = `${session.title} · ${folderShort}`;
    const resolved = buildShellLaunch(session, isResume);

    const terminalLocation =
      session.location === "editor"
        ? vscode.TerminalLocation.Editor
        : vscode.TerminalLocation.Panel;

    const terminal = vscode.window.createTerminal({
      name: termName,
      cwd: session.cwd,
      shellPath: resolved.shellPath,
      shellArgs: resolved.shellArgs,
      location: terminalLocation,
    });

    terminal.show(false);

    if (resolved.initialCommand) {
      terminal.sendText(resolved.initialCommand, true);
    }

    return terminal;
  }

  public async spawnSession(params: {
    title: string;
    badge: string;
    color: string;
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

    const id = `sess-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const isClaude = params.command.toLowerCase().startsWith("claude");
    const cliSessionId = isClaude ? crypto.randomUUID() : undefined;

    const session: CockpitSession = {
      id,
      cliSessionId,
      title: params.title,
      badge: params.badge,
      color: params.color,
      command: params.command,
      args: params.args,
      cwd: targetCwd,
      branch,
      isWorktree,
      hasCustomTitle: false,
      userRenamed: false,
      location: params.location,
      status: "idle",
      lastActivityAt: Date.now(),
      createdAt: Date.now(),
    };

    session.terminal = this._createVsTerminalForSession(session, false);

    this._sessions.push(session);
    this._activeSessionId = id;
    this._currentCwd = targetCwd;
    this._persistSessions();
    await this.refreshWebviewState();
  }

  public async renameSession(
    id: string,
    newTitleRaw: string,
    userInitiated = true
  ) {
    const trimmed = newTitleRaw.trim();
    if (!trimmed) return;
    const found = this._sessions.find((s) => s.id === id);
    if (!found) return;

    found.title = trimmed;
    found.hasCustomTitle = true;
    if (userInitiated) {
      found.userRenamed = true;
      found.cliSessionName = trimmed;

      if (
        found.command.toLowerCase().startsWith("agy") &&
        found.cliSessionId
      ) {
        try {
          const pbtxtPath = path.join(
            os.homedir(),
            ".gemini",
            "antigravity-cli",
            "annotations",
            `${found.cliSessionId}.pbtxt`
          );
          fs.mkdirSync(path.dirname(pbtxtPath), { recursive: true });
          fs.writeFileSync(
            pbtxtPath,
            `title:"${trimmed.replace(/"/g, "")}"\n`,
            "utf8"
          );
        } catch {
          // ignore
        }
      }
    }
    this._persistSessions();

    if (isTerminalAlive(found.terminal)) {
      try {
        found.terminal.show(true);
        await vscode.commands.executeCommand(
          "workbench.action.terminal.renameWithArg",
          { name: trimmed }
        );
      } catch {
        // ignore
      }
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
      await this.renameSession(found.id, input.trim(), true);
    }
  }

  public async sendQuickPromptToActiveAgent(promptText: string) {
    const active =
      this._sessions.find((s) => s.id === this._activeSessionId) ??
      this._sessions[this._sessions.length - 1];

    if (active) {
      active.status = "working";
      active.lastActivityAt = Date.now();
      if (!active.hasCustomTitle) {
        const autoTitle = summarizeFirstLine(promptText, active.title);
        if (autoTitle) {
          await this.renameSession(active.id, autoTitle, false);
        }
      }
    }

    await this.sendTextToActiveAgent(promptText, true);

    // Immediately move keyboard focus into the terminal canvas so follow-up TUI keystrokes
    // (y, Esc, Shift+Tab, arrows) go straight to the interactive CLI!
    try {
      await vscode.commands.executeCommand("workbench.action.terminal.focus");
    } catch {
      // ignore
    }
  }

  public focusSessionByIndex(indexZeroBased: number) {
    if (indexZeroBased < 0 || indexZeroBased >= this._sessions.length) return;
    void this.focusOrRelaunchSessionById(this._sessions[indexZeroBased].id);
  }

  public async focusOrRelaunchSessionById(id: string) {
    const found = this._sessions.find((s) => s.id === id);
    if (!found) return;
    this._activeSessionId = found.id;
    this._currentCwd = found.cwd;

    if (isTerminalAlive(found.terminal)) {
      if (found.status === "stopped") found.status = "idle";
      found.terminal.show(false);
      try {
        await vscode.commands.executeCommand("workbench.action.terminal.focus");
      } catch {
        // ignore
      }
      await this.refreshWebviewState();
    } else {
      await this.relaunchSessionById(id, true);
    }
  }

  public async relaunchSessionById(id: string, isResume = true) {
    const found = this._sessions.find((s) => s.id === id);
    if (!found) return;

    if (found.terminal && isTerminalAlive(found.terminal)) {
      try {
        found.terminal.dispose();
      } catch {
        // ignore
      }
    }

    const cwd = fs.existsSync(found.cwd) ? found.cwd : this._currentCwd;
    found.cwd = cwd;
    found.terminal = this._createVsTerminalForSession(found, isResume);
    found.status = "idle";
    this._activeSessionId = found.id;
    this._currentCwd = cwd;
    this._persistSessions();
    try {
      await vscode.commands.executeCommand("workbench.action.terminal.focus");
    } catch {
      // ignore
    }
    await this.refreshWebviewState();
  }

  public async deleteSessionById(id: string) {
    const idx = this._sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const target = this._sessions[idx];
    if (target.cliSessionId) {
      this._dismissedCliIds.add(target.cliSessionId);
      void this._context.globalState.update(
        DISMISSED_KEY,
        Array.from(this._dismissedCliIds)
      );
    }
    if (isTerminalAlive(target.terminal)) {
      try {
        target.terminal.dispose();
      } catch {
        // ignore
      }
    }
    this._sessions.splice(idx, 1);
    if (this._activeSessionId === id) {
      this._activeSessionId =
        this._sessions.length > 0
          ? this._sessions[this._sessions.length - 1].id
          : null;
    }
    this._persistSessions();
    await this.refreshWebviewState();
  }

  public async sendTextToActiveAgent(text: string, addNewLine = false) {
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

    if (!isTerminalAlive(active.terminal)) {
      await this.relaunchSessionById(active.id, true);
    }

    if (!active.hasCustomTitle) {
      const autoTitle = summarizeFirstLine(text, active.title);
      if (autoTitle) {
        await this.renameSession(active.id, autoTitle, false);
      }
    }

    active.terminal?.show(false);
    active.terminal?.sendText(text, addNewLine);
    try {
      await vscode.commands.executeCommand("workbench.action.terminal.focus");
    } catch {
      // ignore
    }
  }

  public async sendActiveEditorSelectionToAgent(targetSessionId?: string) {
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
    const lineRange =
      !sel.isEmpty && startLine !== endLine
        ? `${startLine}-${endLine}`
        : `${startLine}`;

    await this.sendTextToActiveAgent(
      formatAtFileRef(relPath, lineRange),
      false
    );
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
          file: line.slice(3).trim().replace(/^"(.*)"$/, "$1"),
        }))
        .slice(0, 25);
      return { branch, changes };
    } catch {
      return { branch: null, changes: [] };
    }
  }

  public async refreshWebviewState() {
    if (!this._view) return;
    this._syncLiveness();
    const gitInfo = await this._getGitChanges(this._currentCwd);
    const handoffContent = this._readHandoffContent();
    const wbConfig = vscode.workspace.getConfiguration("workbench.editor");
    const showTabs = wbConfig.get<string>("showTabs") || "multiple";

    this._view.webview.postMessage({
      type: "state",
      currentCwd: this._currentCwd,
      folderName: path.basename(this._currentCwd) || this._currentCwd,
      defaultLocation: this._defaultLocation,
      topTabsHidden: showTabs === "none",
      activeSessionId: this._activeSessionId,
      presets: DEFAULT_PRESETS,
      gitBranch: gitInfo.branch,
      gitChanges: gitInfo.changes,
      handoffContent,
      sessions: this._sessions.map((s, idx) => ({
        id: s.id,
        cliSessionId: s.cliSessionId,
        index: idx + 1,
        title: s.title,
        badge: s.badge,
        color: s.color,
        cwd: s.cwd,
        folderName: path.basename(s.cwd) || s.cwd,
        branch: s.branch,
        isWorktree: s.isWorktree,
        status: s.status,
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
    /* Auto-adapt to VS Code theme: Light if Light Theme, Dark if Dark Theme */
    :root,
    body.vscode-dark,
    body.vscode-high-contrast {
      --bg-shell: var(--vscode-sideBar-background, #0f141c);
      --md-surface: #171f2c;
      --md-surface-hover: #1e293b;
      --md-fg: var(--vscode-foreground, #e2e8f0);
      --md-muted: var(--vscode-descriptionForeground, #94a3b8);
      --md-border: #2a3649;
      --md-border-strong: #475569;
      --md-primary: #3b82f6;
      --md-primary-bg: rgba(59, 130, 246, 0.16);
      --md-shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.35);
      --md-shadow-md: 0 4px 10px rgba(0, 0, 0, 0.45);
      --md-radius: 8px;
      --st-working: #22c55e;
      --st-needs-input: #f59e0b;
      --st-idle: #38bdf8;
      --st-stopped: #64748b;
    }

    body.vscode-light,
    body.vscode-high-contrast-light {
      --bg-shell: var(--vscode-sideBar-background, #f3f4f6);
      --md-surface: #ffffff;
      --md-surface-hover: #f8fafc;
      --md-fg: var(--vscode-foreground, #0f172a);
      --md-muted: var(--vscode-descriptionForeground, #64748b);
      --md-border: #cbd5e1;
      --md-border-strong: #94a3b8;
      --md-primary: #2563eb;
      --md-primary-bg: rgba(37, 99, 235, 0.1);
      --md-shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.08), 0 1px 3px rgba(15, 23, 42, 0.05);
      --md-shadow-md: 0 3px 6px rgba(15, 23, 42, 0.12), 0 2px 4px rgba(15, 23, 42, 0.07);
      --st-working: #16a34a;
      --st-needs-input: #d97706;
      --st-idle: #0284c7;
      --st-stopped: #94a3b8;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Segoe UI", Roboto, -apple-system, sans-serif;
      font-size: 12px;
      color: var(--md-fg);
      background: var(--bg-shell);
      padding: 10px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 9px;
      user-select: none;
    }

    /* Material Top Bar */
    .top-bar {
      display: flex;
      align-items: center;
      gap: 5px;
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
      padding: 6px 9px;
      cursor: pointer;
      overflow: hidden;
      font-size: 11.5px;
      color: var(--md-fg);
      transition: all 0.14s ease;
    }
    .cwd-btn:hover {
      border-color: var(--md-primary);
      background: var(--md-surface-hover);
      box-shadow: var(--md-shadow-md);
      transform: translateY(-1px);
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
      color: #60a5fa;
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
      padding: 6px 7px;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.14s ease;
    }
    .chip-btn:hover {
      border-color: var(--md-border-strong);
      color: var(--md-fg);
      background: var(--md-surface-hover);
      transform: translateY(-1px);
    }
    .chip-btn.active {
      color: #60a5fa;
      border-color: var(--md-primary);
      background: var(--md-primary-bg);
    }

    /* Material Agent Launch Buttons */
    .launch-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr) 32px;
      gap: 5px;
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
      color: var(--md-fg);
      padding: 7px 5px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.14s ease;
    }
    .md-btn:hover {
      border-color: var(--md-primary);
      background: var(--md-surface-hover);
      box-shadow: var(--md-shadow-md);
      transform: translateY(-1px);
    }
    .agent-dot {
      width: 17px;
      height: 17px;
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
      gap: 5px;
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      border-radius: var(--md-radius);
      box-shadow: var(--md-shadow-sm);
      padding: 7px;
    }
    .custom-drawer.open { display: flex; }

    input[type="text"], textarea {
      width: 100%;
      background: var(--md-surface);
      color: var(--md-fg);
      border: 1px solid var(--md-border);
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 11.5px;
      font-family: inherit;
      transition: border-color 0.14s, box-shadow 0.14s;
    }
    input[type="text"]:focus, textarea:focus {
      outline: none;
      border-color: var(--md-primary);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.22);
    }

    /* Material Session Cards with Live Status & Shortcut Badges */
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
      gap: 7px;
      padding: 8px 9px;
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      border-radius: var(--md-radius);
      box-shadow: var(--md-shadow-sm);
      cursor: pointer;
      transition: all 0.14s ease;
    }
    .session-card:hover {
      border-color: var(--md-border-strong);
      background: var(--md-surface-hover);
      box-shadow: var(--md-shadow-md);
      transform: translateY(-1px);
    }
    .session-card.active {
      border-color: var(--md-primary);
      border-left: 4px solid var(--md-primary);
      background: var(--md-primary-bg);
    }

    /* Live Status Dot */
    .status-led {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .led-working {
      background: var(--st-working);
      box-shadow: 0 0 8px var(--st-working);
      animation: pulse 1.3s infinite ease-in-out;
    }
    .led-needs-input {
      background: var(--st-needs-input);
      box-shadow: 0 0 8px var(--st-needs-input);
      animation: pulse 1.1s infinite ease-in-out;
    }
    .led-idle {
      background: var(--st-idle);
      box-shadow: 0 0 5px rgba(56, 189, 248, 0.45);
    }
    .led-stopped {
      background: var(--st-stopped);
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.28); opacity: 0.65; }
    }

    .s-title {
      flex: 1;
      font-weight: 600;
      font-size: 11.8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .s-rename-input {
      flex: 1;
      padding: 2px 5px !important;
      font-size: 11.5px !important;
    }
    .shortcut-pill {
      font-family: monospace;
      font-size: 9.5px;
      font-weight: 600;
      color: var(--md-muted);
      background: rgba(148, 163, 184, 0.12);
      border: 1px solid rgba(148, 163, 184, 0.22);
      padding: 1px 4px;
      border-radius: 4px;
      white-space: nowrap;
    }
    .state-tag {
      font-size: 9.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      padding: 2px 5px;
      border-radius: 4px;
      white-space: nowrap;
    }
    .tag-working {
      color: #4ade80;
      background: rgba(34, 197, 94, 0.15);
    }
    .tag-needs-input {
      color: #fbbf24;
      background: rgba(245, 158, 11, 0.18);
    }
    .tag-idle {
      color: var(--md-muted);
      background: rgba(148, 163, 184, 0.12);
    }
    .tag-stopped {
      color: #60a5fa;
      background: var(--md-primary-bg);
      border: 1px solid rgba(59, 130, 246, 0.35);
    }

    .row-actions {
      display: none;
      align-items: center;
      gap: 3px;
    }
    .session-card:hover .row-actions {
      display: flex;
    }
    .session-card:hover .state-tag,
    .session-card:hover .shortcut-pill {
      display: none;
    }

    .icon-action {
      width: 21px;
      height: 21px;
      border-radius: 5px;
      border: 1px solid var(--md-border);
      background: var(--md-surface);
      color: var(--md-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10.5px;
      transition: all 0.12s;
    }
    .icon-action:hover {
      color: #60a5fa;
      border-color: var(--md-primary);
      background: var(--md-primary-bg);
    }
    .icon-action.danger:hover {
      color: #f87171;
      border-color: #ef4444;
      background: rgba(239, 68, 68, 0.15);
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
      gap: 7px;
      padding-top: 8px;
      border-top: 1px solid var(--md-border);
    }
    .prompt-box {
      display: flex;
      gap: 5px;
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
    }
    .send-btn:hover {
      background: #2563eb;
    }
    .footer-tabs {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 5px;
    }
    .footer-btn {
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      border-radius: var(--md-radius);
      box-shadow: var(--md-shadow-sm);
      color: var(--md-fg);
      padding: 6px 7px;
      font-size: 10.8px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      transition: all 0.14s ease;
    }
    .footer-btn:hover {
      border-color: var(--md-primary);
      background: var(--md-surface-hover);
      transform: translateY(-1px);
    }
    .footer-btn.active {
      color: #60a5fa;
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
      background: var(--md-surface-hover);
    }
    .git-st { color: #fbbf24; font-family: monospace; font-weight: 700; font-size: 10.5px; width: 14px; }
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
    <button id="zen-tabs-toggle" class="chip-btn" title="Hide/Show redundant top Editor Tab bar (+35px terminal height)">
      Zen
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
        placeholder="Kick off prompt (focuses terminal on Enter)…"
      />
      <button id="quick-prompt-btn" class="send-btn" title="Send prompt & focus terminal">↵</button>
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
      lightMode: false,
    };

    const cwdPill = document.getElementById("cwd-pill");
    const cwdName = document.getElementById("cwd-name");
    const branchTag = document.getElementById("branch-tag");
    const zenTabsToggle = document.getElementById("zen-tabs-toggle");
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

    zenTabsToggle.addEventListener("click", () => {
      vscode.postMessage({ type: "toggleTopTabs" });
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
        color: "#64748b",
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
      const val = quickPromptInput.value.trim();
      if (!val) return;
      quickPromptInput.value = "";
      // Blur immediately so follow-up keystrokes (y, Esc, Shift+Tab) go straight to the PTY terminal
      quickPromptInput.blur();
      vscode.postMessage({
        type: "sendQuickPrompt",
        prompt: val,
      });
    }

    quickPromptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitQuickPrompt();
      }
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

    function statusLabelFor(status, folderName) {
      if (status === "working") return { cls: "tag-working", text: "Streaming" };
      if (status === "needs-input") return { cls: "tag-needs-input", text: "Approval?" };
      if (status === "stopped") return { cls: "tag-stopped", text: "↻ Resume" };
      return { cls: "tag-idle", text: folderName };
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

      zenTabsToggle.classList.toggle("active", Boolean(msg.topTabsHidden));

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
          const isStopped = s.status === "stopped";
          const tagInfo = statusLabelFor(s.status, s.folderName);
          const shortcutBadge = s.index <= 5 ? '<span class="shortcut-pill">⌃' + s.index + '</span>' : '';
          const card = document.createElement("div");
          card.className =
            "session-card" +
            (s.id === msg.activeSessionId ? " active" : "") +
            (isStopped ? " stopped" : "");
          card.title = isStopped
            ? "Paused — Click to resume conversation (" + s.folderName + ")"
            : "Status: " + s.status + " · Folder: " + s.cwd + " · Double-click title to rename";
          card.innerHTML =
            '<span class="status-led led-' + s.status + '"></span>' +
            '<span class="agent-dot" style="background:' + (s.color || "#3b82f6") + ';">' + s.badge + '</span>' +
            '<span class="s-title">' + s.title + '</span>' +
            '<span class="state-tag ' + tagInfo.cls + '">' + tagInfo.text + '</span>' +
            shortcutBadge +
            '<div class="row-actions">' +
              '<button class="icon-action act-rename" title="Rename">✎</button>' +
              '<button class="icon-action act-send" title="Send @file:line">@</button>' +
              '<button class="icon-action danger act-delete" title="Remove session">✕</button>' +
            '</div>';

          card.addEventListener("click", () => {
            vscode.postMessage({
              type: isStopped ? "relaunchSession" : "focusSession",
              id: s.id,
            });
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
          card.querySelector(".act-delete").addEventListener("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "deleteSession", id: s.id });
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
          color: picked.preset.color,
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
          badge: ">_",
          color: "#64748b",
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
      void provider.sendActiveEditorSelectionToAgent();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentCockpit.openHandoff", () => {
      void provider.openHandoffInEditor();
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
