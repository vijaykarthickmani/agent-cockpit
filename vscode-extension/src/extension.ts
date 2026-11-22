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

const CANDIDATE_PRESETS: AgentPreset[] = [
  {
    id: "agy",
    label: "Antigravity (agy)",
    badge: "✦",
    color: "#3b82f6",
    command: "agy",
    args: [],
  },
  {
    id: "claude",
    label: "Claude Code",
    badge: "C",
    color: "#e07a5f",
    command: "claude",
    args: [],
  },
  {
    id: "codex",
    label: "Codex CLI",
    badge: "X",
    color: "#10b981",
    command: "codex",
    args: [],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    badge: "G",
    color: "#8b5cf6",
    command: "gemini",
    args: [],
  },
  {
    id: "aider",
    label: "Aider",
    badge: "A",
    color: "#14b8a6",
    command: "aider",
    args: [],
  },
  {
    id: "powershell",
    label: "PowerShell",
    badge: ">_",
    color: "#64748b",
    command: "powershell.exe",
    args: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
  },
  {
    id: "cmd",
    label: "Command Prompt",
    badge: "CMD",
    color: "#475569",
    command: "cmd.exe",
    args: [],
  },
];

function isExecutableInstalled(command: string): boolean {
  const lower = command.toLowerCase();
  if (lower === "powershell.exe" || lower === "powershell" || lower === "cmd.exe" || lower === "cmd") {
    return true;
  }

  const home = os.homedir();
  const searchDirs: string[] = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);

  searchDirs.push(
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".gemini", "antigravity-cli", "bin")
  );
  if (process.env.APPDATA) {
    searchDirs.push(path.join(process.env.APPDATA, "npm"));
  }
  if (process.env.LOCALAPPDATA) {
    searchDirs.push(
      path.join(process.env.LOCALAPPDATA, "Programs", "antigravity", "bin"),
      path.join(process.env.LOCALAPPDATA, "Programs", "antigravity"),
      path.join(process.env.LOCALAPPDATA, "Programs", "Antigravity IDE", "bin")
    );
  }

  const exts = path.extname(command)
    ? [""]
    : [".exe", ".cmd", ".bat", ".ps1", ""];

  for (const dir of searchDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext}`);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return true;
        }
      } catch {
        // ignore
      }
    }
  }
  return false;
}

function getInstalledPresets(): AgentPreset[] {
  const installed = CANDIDATE_PRESETS.filter((p) =>
    isExecutableInstalled(p.command)
  );
  return installed.length > 0 ? installed : CANDIDATE_PRESETS.slice(0, 2);
}

interface StoredSessionMeta {
  id: string;
  cliSessionId?: string;
  cliSessionName?: string;
  title: string;
  badge: string;
  color: string;
  pinned?: boolean;
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

interface ExtractedAiSnippet {
  id: string;
  sessionTitle: string;
  kind: "command" | "code" | "response";
  language: string;
  content: string;
}

interface CockpitSession extends StoredSessionMeta {
  status: RuntimeState;
  lastActivityAt: number;
  lastUserTurnId?: string;
  lastNotifiedUserTurnId?: string;
  lastChimeAt?: number;
  terminal?: vscode.Terminal;
}

interface GitFileChange {
  status: string;
  file: string;
}

interface McpServerInfo {
  id: string;
  name: string;
  source: string;
  status: "connected" | "configured" | "error";
  toolCount: number;
  tools: string[];
  detail: string;
}

interface SkillOrAgentInfo {
  name: string;
  kind: "skill" | "agent";
  scope: "Workspace" | "Plugin" | "Built-in";
  description: string;
  filePath?: string;
}

interface DiscoveredCliSession {
  cliSessionId: string;
  title: string;
  cwd: string;
  mtimeMs: number;
  runtimeHint: "working" | "needs-input" | "idle";
  lastUserTurnId?: string;
  isTurnComplete: boolean;
  lastAssistantText?: string;
  snippets: ExtractedAiSnippet[];
  agentType: "claude" | "agy";
}

interface ScheduledJob {
  id: string;
  name: string;
  cliId: string;
  cliName: string;
  command: string;
  args: string[];
  badge: string;
  color: string;
  cwd: string;
  prompt: string;
  scheduleType: "interval" | "daily" | "weekdays";
  intervalMinutes?: number;
  dailyTime?: string; // "HH:MM"
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt: number;
  lastSessionId?: string;
}

const STORAGE_KEY = "agentCockpit.retainedSessions.v3";
const DISMISSED_KEY = "agentCockpit.dismissedCliIds.v1";
const SOUND_PREF_KEY = "agentCockpit.soundEnabled.v1";
const LAST_CLI_KEY = "agentCockpit.lastUsedCliId.v1";
const STORAGE_JOBS_KEY = "agentCockpit.scheduledJobs.v1";

function computeNextRunAt(
  job: Pick<ScheduledJob, "scheduleType" | "intervalMinutes" | "dailyTime">,
  fromMs = Date.now()
): number {
  if (job.scheduleType === "interval") {
    const mins = Math.max(1, job.intervalMinutes || 30);
    return fromMs + mins * 60_000;
  }

  const [hStr, mStr] = (job.dailyTime || "09:00").split(":");
  const targetH = Math.min(23, Math.max(0, parseInt(hStr || "9", 10) || 0));
  const targetM = Math.min(59, Math.max(0, parseInt(mStr || "0", 10) || 0));

  const candidate = new Date(fromMs);
  candidate.setSeconds(0, 0);
  candidate.setHours(targetH, targetM, 0, 0);

  if (candidate.getTime() <= fromMs) {
    candidate.setDate(candidate.getDate() + 1);
  }

  if (job.scheduleType === "weekdays") {
    while (candidate.getDay() === 0 || candidate.getDay() === 6) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }

  return candidate.getTime();
}

function formatScheduleLabel(job: ScheduledJob): string {
  if (job.scheduleType === "interval") {
    const mins = job.intervalMinutes || 30;
    return mins >= 60 && mins % 60 === 0
      ? `Every ${mins / 60}h`
      : `Every ${mins}m`;
  }
  if (job.scheduleType === "weekdays") {
    return `Weekdays ${job.dailyTime || "09:00"}`;
  }
  return `Daily ${job.dailyTime || "09:00"}`;
}

function isTerminalAlive(term?: vscode.Terminal): term is vscode.Terminal {
  if (!term) return false;
  if (term.exitStatus !== undefined) return false;
  return vscode.window.terminals.includes(term);
}

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

const SHELL_LANGS = new Set([
  "sh",
  "bash",
  "zsh",
  "powershell",
  "ps1",
  "pwsh",
  "cmd",
  "bat",
  "shell",
  "console",
  "terminal",
]);

function extractSnippetsFromMarkdown(
  markdownText: string,
  sessionTitle: string
): ExtractedAiSnippet[] {
  const results: ExtractedAiSnippet[] = [];
  if (!markdownText || !markdownText.trim()) return results;

  // 1. Add the full response text item so user can 1-click copy the whole AI response
  results.push({
    id: `resp-${results.length}`,
    sessionTitle,
    kind: "response",
    language: "markdown",
    content: markdownText.trim(),
  });

  // 2. Extract fenced code blocks (```lang ... ```)
  const fenceRegex = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(markdownText)) !== null) {
    const lang = (match[1] || "").trim().toLowerCase();
    const code = (match[2] || "").trim();
    if (!code) continue;

    const lineCount = code.split(/\r?\n/).length;
    const looksLikeCommand =
      SHELL_LANGS.has(lang) ||
      (!lang &&
        lineCount <= 4 &&
        /^(npm|npx|pnpm|yarn|git|cargo|rustc|rustup|winget|python|pip|uv|pytest|code|agy|claude|codex|gemini|cd|dir|ls|mkdir|docker|kubectl|gcloud|bq)\b/m.test(
          code
        ));

    results.push({
      id: `snip-${results.length}`,
      sessionTitle,
      kind: looksLikeCommand ? "command" : "code",
      language: lang || (looksLikeCommand ? "shell" : "code"),
      content: code,
    });
  }

  return results.slice(0, 12);
}

/**
 * Discover all MCP servers & their live status across:
 * 1. ~/.gemini/antigravity/mcp/<serverName> & ~/.gemini/antigravity-cli/mcp/<serverName>
 * 2. <cwd>/.agents/plugins/<plugin>/mcp_config.json
 * 3. ~/.gemini/config/plugins/<plugin>/mcp_config.json
 * 4. <cwd>/.mcp.json & ~/.claude.json
 */
function discoverMcpServers(cwd: string): McpServerInfo[] {
  const map = new Map<string, McpServerInfo>();
  const home = os.homedir();

  // 1. Scan active Antigravity MCP schema directories (shows actually loaded tools!)
  const mcpCacheRoots = [
    path.join(home, ".gemini", "antigravity", "mcp"),
    path.join(home, ".gemini", "antigravity-cli", "mcp"),
  ];

  for (const root of mcpCacheRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const dirName of fs.readdirSync(root)) {
        const fullDir = path.join(root, dirName);
        if (!fs.statSync(fullDir).isDirectory()) continue;
        const toolFiles = fs
          .readdirSync(fullDir)
          .filter((f) => f.endsWith(".json") && f !== "mcp_config.json");
        const tools = toolFiles.map((f) => path.basename(f, ".json"));
        const parts = dirName.split("_");
        const source = parts.length > 1 ? parts[0] : "antigravity";
        const shortName =
          parts.length > 1 ? parts.slice(1).join("_") : dirName;

        const existing = map.get(shortName);
        if (!existing || tools.length > existing.toolCount) {
          map.set(shortName, {
            id: dirName,
            name: shortName,
            source,
            status: tools.length > 0 ? "connected" : "configured",
            toolCount: tools.length,
            tools,
            detail:
              tools.length > 0
                ? `${tools.length} tools active (${tools.slice(0, 4).join(", ")}${
                    tools.length > 4 ? "…" : ""
                  })`
                : "Registered in Antigravity MCP cache",
          });
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Scan workspace & global plugin mcp_config.json / mcp.json files
  const configCandidates: { file: string; source: string }[] = [];

  const scanPluginRoot = (pluginsDir: string, prefix: string) => {
    if (!fs.existsSync(pluginsDir)) return;
    try {
      for (const pName of fs.readdirSync(pluginsDir)) {
        const pDir = path.join(pluginsDir, pName);
        for (const cfgName of ["mcp_config.json", "mcp.json", ".mcp.json"]) {
          const cfgPath = path.join(pDir, cfgName);
          if (fs.existsSync(cfgPath)) {
            configCandidates.push({
              file: cfgPath,
              source: `${prefix}:${pName}`,
            });
          }
        }
      }
    } catch {
      // ignore
    }
  };

  scanPluginRoot(path.join(cwd, ".agents", "plugins"), "workspace");
  const parentCwd = path.dirname(cwd);
  if (parentCwd !== cwd) {
    scanPluginRoot(path.join(parentCwd, ".agents", "plugins"), "workspace");
  }
  scanPluginRoot(path.join(home, ".gemini", "config", "plugins"), "plugin");

  const wsMcp = path.join(cwd, ".mcp.json");
  if (fs.existsSync(wsMcp)) {
    configCandidates.push({ file: wsMcp, source: "workspace" });
  }

  for (const cand of configCandidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(cand.file, "utf8"));
      const servers = raw.mcpServers || raw.servers || {};
      for (const [srvName, srvDef] of Object.entries(servers)) {
        const def = srvDef as {
          command?: string;
          args?: string[];
          url?: string;
        };
        let status: "connected" | "configured" | "error" = "configured";
        let detail = def.command
          ? `${def.command} ${(def.args || []).join(" ")}`
          : def.url || "Configured";

        // Check for unreplaced placeholders or missing local script file
        if (/\$\{?GCP_REGION|\$\{?region/i.test(detail)) {
          status = "error";
          detail = "Unconfigured region placeholder (${REGION})";
        } else if (
          def.args &&
          def.args.length > 0 &&
          /\.(mjs|js|py)$/i.test(def.args[0])
        ) {
          const scriptPath = def.args[0];
          if (!fs.existsSync(scriptPath)) {
            status = "error";
            detail = `Missing script: ${scriptPath}`;
          }
        }

        const existing = map.get(srvName);
        if (existing) {
          if (status === "error") {
            existing.status = "error";
            existing.detail = detail;
          }
        } else {
          map.set(srvName, {
            id: srvName,
            name: srvName,
            source: cand.source,
            status,
            toolCount: 0,
            tools: [],
            detail,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const score = (s: McpServerInfo) =>
      s.status === "connected" ? 0 : s.status === "configured" ? 1 : 2;
    return score(a) - score(b) || a.name.localeCompare(b.name);
  });
}

/**
 * Parse YAML frontmatter name & description from a SKILL.md file
 */
function parseSkillMarkdown(
  filePath: string,
  fallbackName: string
): { name: string; description: string } {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      const name = nameMatch
        ? nameMatch[1].trim().replace(/^["']|["']$/g, "")
        : fallbackName;
      const description = descMatch
        ? descMatch[1].trim().replace(/^["']|["']$/g, "")
        : "Skill instructions";
      return { name, description };
    }
  } catch {
    // ignore
  }
  return { name: fallbackName, description: "Skill instructions" };
}

/**
 * Discover all available Skills and Subagents across Workspace, Plugins, and Built-ins
 */
function discoverSkillsAndAgents(cwd: string): SkillOrAgentInfo[] {
  const seen = new Set<string>();
  const items: SkillOrAgentInfo[] = [];
  const home = os.homedir();

  // Built-in Subagents
  const builtinAgents: { name: string; desc: string }[] = [
    {
      name: "browser",
      desc: "Chrome DevTools browser automation subagent",
    },
    {
      name: "research",
      desc: "Read-only codebase exploration & research subagent",
    },
    {
      name: "image-generator",
      desc: "Generates or edits images from a brief",
    },
    {
      name: "self",
      desc: "Parallel subagent with full parent capabilities",
    },
  ];
  for (const ag of builtinAgents) {
    items.push({
      name: ag.name,
      kind: "agent",
      scope: "Built-in",
      description: ag.desc,
    });
    seen.add(`agent:${ag.name}`);
  }

  const scanSkillsDir = (
    skillsRoot: string,
    scope: "Workspace" | "Plugin" | "Built-in"
  ) => {
    if (!fs.existsSync(skillsRoot)) return;
    try {
      for (const entry of fs.readdirSync(skillsRoot)) {
        const skillMd = path.join(skillsRoot, entry, "SKILL.md");
        if (!fs.existsSync(skillMd)) continue;
        const parsed = parseSkillMarkdown(skillMd, entry);
        const key = `skill:${parsed.name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          name: parsed.name,
          kind: "skill",
          scope,
          description: parsed.description,
          filePath: skillMd,
        });
      }
    } catch {
      // ignore
    }
  };

  // 1. Workspace skills (.agents/skills & .agents/plugins/*/skills)
  const rootsToCheck = [cwd, path.dirname(cwd)];
  for (const r of rootsToCheck) {
    scanSkillsDir(path.join(r, ".agents", "skills"), "Workspace");
    const wsPlugins = path.join(r, ".agents", "plugins");
    if (fs.existsSync(wsPlugins)) {
      try {
        for (const p of fs.readdirSync(wsPlugins)) {
          scanSkillsDir(path.join(wsPlugins, p, "skills"), "Workspace");
        }
      } catch {
        // ignore
      }
    }
  }

  // 2. Installed Plugin skills (~/.gemini/config/plugins/*/skills)
  const globalPlugins = path.join(home, ".gemini", "config", "plugins");
  if (fs.existsSync(globalPlugins)) {
    try {
      for (const p of fs.readdirSync(globalPlugins)) {
        scanSkillsDir(path.join(globalPlugins, p, "skills"), "Plugin");
      }
    } catch {
      // ignore
    }
  }

  // 3. Built-in skills (~/.gemini/antigravity/builtin/skills)
  scanSkillsDir(
    path.join(home, ".gemini", "antigravity", "builtin", "skills"),
    "Built-in"
  );

  return items;
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
    let lastUserTurnId: string | undefined;
    let isTurnComplete = false;
    const recentAssistantTexts: string[] = [];

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
        const quietMs = now - stat.mtimeMs;
        const content = fs.readFileSync(transcriptPath, "utf8");
        const lines = content.split(/\r?\n/).filter((l) => l.trim());
        for (let i = 0; i < lines.length; i++) {
          try {
            const obj = JSON.parse(lines[i]);
            if (i === 0 && !title && typeof obj.content === "string") {
              const reqMatch = obj.content.match(
                /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/
              );
              const candidate = (reqMatch ? reqMatch[1] : obj.content).trim();
              if (candidate) {
                title = candidate.replace(/\s+/g, " ").slice(0, 32);
              }
            }
            if (obj.source === "USER_EXPLICIT" || obj.type === "USER_INPUT") {
              lastUserTurnId = `${convId}:u:${obj.step_index ?? i}`;
            } else if (
              obj.source === "MODEL" &&
              typeof obj.content === "string" &&
              obj.content.trim()
            ) {
              recentAssistantTexts.push(obj.content.trim());
            }
          } catch {
            // ignore
          }
        }

        if (lines.length > 0) {
          const lastObj = JSON.parse(lines[lines.length - 1]);
          const isFinalModelResponse =
            lastObj.source === "MODEL" &&
            lastObj.type === "PLANNER_RESPONSE" &&
            lastObj.status === "DONE" &&
            !lastObj.tool_calls;

          // Only mark complete after transcript has been quiet for >= 4.5s after a final response
          if (isFinalModelResponse && quietMs >= 4500) {
            isTurnComplete = true;
            if (
              typeof lastObj.content === "string" &&
              /\?\s*$|\[y\/n\]|approve|allow/i.test(lastObj.content.slice(-200))
            ) {
              runtimeHint = "needs-input";
            } else {
              runtimeHint = "idle";
            }
          } else if (quietMs < 8000) {
            runtimeHint = "working";
          }
        }
      } catch {
        // ignore
      }
    }

    if (title) {
      const combinedMd = recentAssistantTexts.slice(-2).join("\n\n");
      results.push({
        cliSessionId: convId,
        title,
        cwd: defaultCwd,
        mtimeMs: mtimeMs || now,
        runtimeHint,
        lastUserTurnId,
        isTurnComplete,
        lastAssistantText:
          recentAssistantTexts[recentAssistantTexts.length - 1],
        snippets: extractSnippetsFromMarkdown(combinedMd, title),
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
  lastUserTurnId?: string;
  isTurnComplete: boolean;
  snippets: ExtractedAiSnippet[];
} {
  const sessionId = path.basename(filePath, ".jsonl");
  let customTitle: string | null = null;
  let firstUserPrompt: string | null = null;
  let detectedCwd: string | null = null;
  let lastUserTurnId: string | undefined;
  let isTurnComplete = false;
  let lastText = "";
  let hasPendingToolUse = false;
  const recentAssistantTexts: string[] = [];

  try {
    const stat = fs.statSync(filePath);
    const quietMs = Date.now() - stat.mtimeMs;
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
          // Only count actual human typed prompts (not tool_result messages) as a new user turn
          const rawContent = obj.message.content;
          const isToolResult =
            Array.isArray(rawContent) &&
            rawContent.some(
              (p: { type?: string }) => p && p.type === "tool_result"
            );
          if (!isToolResult) {
            lastUserTurnId = `${sessionId}:u:${obj.uuid || obj.timestamp || ""}`;
            isTurnComplete = false;
            hasPendingToolUse = false;
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
          }
        } else if (
          obj.type === "assistant" &&
          obj.message?.role === "assistant"
        ) {
          const rawContent = obj.message.content;
          if (Array.isArray(rawContent)) {
            const toolUse = rawContent.find(
              (p: { type?: string }) => p && p.type === "tool_use"
            );
            const textPart = rawContent.find(
              (p: { type?: string; text?: string }) =>
                p && p.type === "text" && typeof p.text === "string"
            );
            hasPendingToolUse = Boolean(toolUse);
            lastText = textPart?.text || "";
            if (lastText.trim()) {
              recentAssistantTexts.push(lastText.trim());
            }
            if (!toolUse && obj.message.stop_reason === "end_turn") {
              isTurnComplete = true;
            }
          }
        } else if (
          (obj.type === "system" && obj.subtype === "turn_duration") ||
          obj.type === "last-prompt"
        ) {
          // Claude writes turn_duration and last-prompt only when the entire agentic loop finishes!
          isTurnComplete = true;
          hasPendingToolUse = false;
        }
      } catch {
        // skip
      }
    }

    let runtimeHint: "working" | "needs-input" | "idle" = "idle";
    if (!isTurnComplete && quietMs < 12000) {
      runtimeHint =
        hasPendingToolUse && quietMs >= 3500 ? "needs-input" : "working";
    } else if (
      /\?\s*$|\[y\/n\]|approve|allow/i.test(lastText.slice(-180))
    ) {
      runtimeHint = "needs-input";
    }

    const chosen = customTitle || firstUserPrompt;
    const cleaned = chosen
      ? chosen.replace(/\s+/g, " ").trim().slice(0, 32)
      : null;
    const combinedMd = recentAssistantTexts.slice(-2).join("\n\n");

    return {
      sessionId,
      title: cleaned,
      cwd: detectedCwd,
      runtimeHint,
      lastUserTurnId,
      isTurnComplete: isTurnComplete && quietMs >= 2500,
      snippets: extractSnippetsFromMarkdown(
        combinedMd,
        cleaned || "Claude"
      ),
    };
  } catch {
    return {
      sessionId,
      title: null,
      cwd: null,
      runtimeHint: "idle",
      isTurnComplete: false,
      snippets: [],
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
            lastUserTurnId: meta.lastUserTurnId,
            isTurnComplete: meta.isTurnComplete,
            snippets: meta.snippets,
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

function extractTranscriptSummaryForHandoff(session: CockpitSession): {
  userPrompts: string[];
  assistantReplies: string[];
  sourceFound: boolean;
} {
  const userPrompts: string[] = [];
  const assistantReplies: string[] = [];
  const cmd = (session.command || "").trim().toLowerCase();
  const home = os.homedir();

  // 1. Antigravity (agy) transcript
  if (
    (cmd === "agy" || cmd === "agy.cmd" || cmd === "agy.exe") &&
    session.cliSessionId
  ) {
    const transcriptPath = path.join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      session.cliSessionId,
      ".system_generated",
      "logs",
      "transcript.jsonl"
    );
    if (fs.existsSync(transcriptPath)) {
      try {
        const lines = fs
          .readFileSync(transcriptPath, "utf8")
          .split(/\r?\n/)
          .filter((l) => l.trim());
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (
              (obj.source === "USER_EXPLICIT" || obj.type === "USER_INPUT") &&
              typeof obj.content === "string"
            ) {
              const m = obj.content.match(
                /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/
              );
              const text = (m ? m[1] : obj.content).replace(/\s+/g, " ").trim();
              if (text) userPrompts.push(text.slice(0, 320));
            } else if (
              obj.source === "MODEL" &&
              typeof obj.content === "string" &&
              obj.content.trim()
            ) {
              assistantReplies.push(obj.content.trim().slice(0, 900));
            }
          } catch {
            // ignore
          }
        }
        return {
          userPrompts: userPrompts.slice(-5),
          assistantReplies: assistantReplies.slice(-3),
          sourceFound: userPrompts.length > 0 || assistantReplies.length > 0,
        };
      } catch {
        // ignore
      }
    }
  }

  // 2. Claude Code transcript
  if (
    (cmd === "claude" || cmd === "claude.exe") &&
    session.cliSessionId
  ) {
    const projectsRoot = path.join(home, ".claude", "projects");
    let jsonlPath = path.join(
      projectsRoot,
      claudeProjectSlug(session.cwd),
      `${session.cliSessionId}.jsonl`
    );
    if (!fs.existsSync(jsonlPath) && fs.existsSync(projectsRoot)) {
      try {
        for (const dir of fs.readdirSync(projectsRoot)) {
          const candidate = path.join(
            projectsRoot,
            dir,
            `${session.cliSessionId}.jsonl`
          );
          if (fs.existsSync(candidate)) {
            jsonlPath = candidate;
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    if (fs.existsSync(jsonlPath)) {
      try {
        const lines = fs
          .readFileSync(jsonlPath, "utf8")
          .split(/\r?\n/)
          .filter((l) => l.trim());
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === "user" && obj.message?.role === "user") {
              const rawContent = obj.message.content;
              const isToolResult =
                Array.isArray(rawContent) &&
                rawContent.some(
                  (p: { type?: string }) => p && p.type === "tool_result"
                );
              if (!isToolResult) {
                let text = "";
                if (typeof rawContent === "string") {
                  text = rawContent;
                } else if (Array.isArray(rawContent)) {
                  const textPart = rawContent.find(
                    (p: { type?: string; text?: string }) =>
                      p && p.type === "text" && typeof p.text === "string"
                  );
                  if (textPart) text = textPart.text;
                }
                const cleaned = text.replace(/\s+/g, " ").trim();
                if (cleaned) userPrompts.push(cleaned.slice(0, 320));
              }
            } else if (
              obj.type === "assistant" &&
              obj.message?.role === "assistant" &&
              Array.isArray(obj.message.content)
            ) {
              const textParts = obj.message.content
                .filter(
                  (p: { type?: string; text?: string }) =>
                    p && p.type === "text" && typeof p.text === "string"
                )
                .map((p: { text: string }) => p.text.trim())
                .filter(Boolean);
              if (textParts.length > 0) {
                assistantReplies.push(textParts.join("\n").slice(0, 900));
              }
            }
          } catch {
            // ignore
          }
        }
        return {
          userPrompts: userPrompts.slice(-5),
          assistantReplies: assistantReplies.slice(-3),
          sourceFound: userPrompts.length > 0 || assistantReplies.length > 0,
        };
      } catch {
        // ignore
      }
    }
  }

  return { userPrompts: [], assistantReplies: [], sourceFound: false };
}

interface ChatTimelineEntry {
  turn: number;
  question: string;
  fullQuestion: string;
  replyPreview?: string;
  timeLabel?: string;
}

function formatIsoTimeShort(raw?: string): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return undefined;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function extractSessionTimeline(
  session?: CockpitSession
): ChatTimelineEntry[] {
  if (!session || !session.cliSessionId) return [];
  const entries: ChatTimelineEntry[] = [];
  const cmd = (session.command || "").trim().toLowerCase();
  const home = os.homedir();

  // 1. Antigravity (agy) transcript
  if (cmd === "agy" || cmd === "agy.cmd" || cmd === "agy.exe") {
    const transcriptPath = path.join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      session.cliSessionId,
      ".system_generated",
      "logs",
      "transcript.jsonl"
    );
    if (!fs.existsSync(transcriptPath)) return [];
    try {
      const lines = fs
        .readFileSync(transcriptPath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (
            (obj.source === "USER_EXPLICIT" || obj.type === "USER_INPUT") &&
            typeof obj.content === "string"
          ) {
            const m = obj.content.match(
              /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/
            );
            const full = (m ? m[1] : obj.content).trim();
            const single = full.replace(/\s+/g, " ").trim();
            if (single) {
              entries.push({
                turn: entries.length + 1,
                question: single.slice(0, 140),
                fullQuestion: full,
                timeLabel: formatIsoTimeShort(obj.timestamp || obj.created_at),
              });
            }
          } else if (
            obj.source === "MODEL" &&
            typeof obj.content === "string" &&
            obj.content.trim() &&
            entries.length > 0
          ) {
            const last = entries[entries.length - 1];
            last.replyPreview = obj.content
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 160);
          }
        } catch {
          // ignore
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  // 2. Claude Code transcript
  if (cmd === "claude" || cmd === "claude.exe") {
    const projectsRoot = path.join(home, ".claude", "projects");
    let jsonlPath = path.join(
      projectsRoot,
      claudeProjectSlug(session.cwd),
      `${session.cliSessionId}.jsonl`
    );
    if (!fs.existsSync(jsonlPath) && fs.existsSync(projectsRoot)) {
      try {
        for (const dir of fs.readdirSync(projectsRoot)) {
          const candidate = path.join(
            projectsRoot,
            dir,
            `${session.cliSessionId}.jsonl`
          );
          if (fs.existsSync(candidate)) {
            jsonlPath = candidate;
            break;
          }
        }
      } catch {
        // ignore
      }
    }
    if (!fs.existsSync(jsonlPath)) return [];
    try {
      const lines = fs
        .readFileSync(jsonlPath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "user" && obj.message?.role === "user") {
            const rawContent = obj.message.content;
            const isToolResult =
              Array.isArray(rawContent) &&
              rawContent.some(
                (p: { type?: string }) => p && p.type === "tool_result"
              );
            if (!isToolResult) {
              let full = "";
              if (typeof rawContent === "string") {
                full = rawContent;
              } else if (Array.isArray(rawContent)) {
                const textPart = rawContent.find(
                  (p: { type?: string; text?: string }) =>
                    p && p.type === "text" && typeof p.text === "string"
                );
                if (textPart) full = textPart.text;
              }
              const single = full.replace(/\s+/g, " ").trim();
              if (single) {
                entries.push({
                  turn: entries.length + 1,
                  question: single.slice(0, 140),
                  fullQuestion: full.trim(),
                  timeLabel: formatIsoTimeShort(obj.timestamp),
                });
              }
            }
          } else if (
            obj.type === "assistant" &&
            obj.message?.role === "assistant" &&
            Array.isArray(obj.message.content) &&
            entries.length > 0
          ) {
            const textPart = obj.message.content.find(
              (p: { type?: string; text?: string }) =>
                p && p.type === "text" && typeof p.text === "string"
            );
            if (textPart && textPart.text.trim()) {
              const last = entries[entries.length - 1];
              last.replyPreview = textPart.text
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 160);
            }
          }
        } catch {
          // ignore
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  return [];
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
  private _snippetsBySessionId: Map<string, ExtractedAiSnippet[]> = new Map();
  private _latestSnippets: ExtractedAiSnippet[] = [];
  private _dismissedCliIds: Set<string>;
  private _activeSessionId: string | null = null;
  private _currentCwd: string;
  private _defaultLocation: "editor" | "panel" = "editor";
  private _soundEnabled: boolean;
  private _lastUsedCliId: string;
  private _jobs: ScheduledJob[] = [];
  private _pollTimer: NodeJS.Timeout;
  private _onStateChanged?: () => void;

  public setOnStateChanged(cb: () => void) {
    this._onStateChanged = cb;
  }

  public getActiveSessionTimelineInfo(): {
    sessionTitle: string;
    entries: ChatTimelineEntry[];
  } {
    const activeSessionObj =
      this._sessions.find((s) => s.id === this._activeSessionId) ||
      this._sessions[this._sessions.length - 1];
    return {
      sessionTitle: activeSessionObj?.title || "",
      entries: extractSessionTimeline(activeSessionObj),
    };
  }

  constructor(private readonly _context: vscode.ExtensionContext) {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this._currentCwd = wsFolder || "D:\\Thulir Inc";

    this._soundEnabled = this._context.globalState.get<boolean>(
      SOUND_PREF_KEY,
      true
    );
    const installed = getInstalledPresets();
    this._lastUsedCliId =
      this._context.globalState.get<string>(LAST_CLI_KEY) ||
      installed[0]?.id ||
      "agy";

    const savedJobs =
      this._context.globalState.get<ScheduledJob[]>(STORAGE_JOBS_KEY) || [];
    const bootNow = Date.now();
    this._jobs = savedJobs.map((j) => ({
      ...j,
      nextRunAt:
        j.nextRunAt && j.nextRunAt > bootNow
          ? j.nextRunAt
          : computeNextRunAt(j, bootNow),
    }));

    const savedDismissed =
      this._context.globalState.get<string[]>(DISMISSED_KEY) || [];
    this._dismissedCliIds = new Set<string>(savedDismissed);

    const saved =
      this._context.globalState.get<StoredSessionMeta[]>(STORAGE_KEY) || [];
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
      const cliChanged = this._syncCliStoredSessionNames();
      const jobsFired = this._checkScheduledJobs();
      if (cliChanged || jobsFired) {
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
   * Plays an audio notification chime when an AI agent finishes a response or requests approval.
   */
  private _triggerNotificationSound(
    kind: "complete" | "approval",
    sessionTitle?: string
  ) {
    if (!this._soundEnabled) return;

    if (this._view) {
      void this._view.webview.postMessage({
        type: "playChime",
        kind,
        sessionTitle,
      });
    }
  }

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
    } catch {
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

    const applyDiscovered = (
      match: CockpitSession,
      disc: DiscoveredCliSession
    ) => {
      match.cliSessionName = disc.title;
      if (disc.snippets && disc.snippets.length > 0) {
        const prevCount = (this._snippetsBySessionId.get(match.id) || []).length;
        this._snippetsBySessionId.set(match.id, disc.snippets);
        this._latestSnippets = disc.snippets;
        if (disc.snippets.length !== prevCount) {
          changed = true;
        }
      }
      if (isTerminalAlive(match.terminal)) {
        // Initialize turn tracking without chiming on existing historical turns
        if (!match.lastUserTurnId && disc.lastUserTurnId) {
          match.lastUserTurnId = disc.lastUserTurnId;
          if (disc.isTurnComplete) {
            match.lastNotifiedUserTurnId = disc.lastUserTurnId;
          }
        } else if (
          disc.lastUserTurnId &&
          disc.lastUserTurnId !== match.lastUserTurnId
        ) {
          // A new human prompt was submitted!
          match.lastUserTurnId = disc.lastUserTurnId;
        }

        // Chime AT MOST ONCE per user prompt, and ONLY when the entire agentic turn is complete!
        const now = Date.now();
        if (
          disc.isTurnComplete &&
          disc.lastUserTurnId &&
          match.lastNotifiedUserTurnId !== disc.lastUserTurnId &&
          now - (match.lastChimeAt || 0) > 8000
        ) {
          match.lastNotifiedUserTurnId = disc.lastUserTurnId;
          match.lastChimeAt = now;
          this._triggerNotificationSound(
            disc.runtimeHint === "needs-input" ? "approval" : "complete",
            match.title
          );
          changed = true;
        }

        if (match.status !== disc.runtimeHint) {
          match.status = disc.runtimeHint;
          changed = true;
        }
      }
      if (!match.userRenamed && match.title !== disc.title) {
        match.title = disc.title;
        match.hasCustomTitle = true;
        changed = true;
        // Only rename the VS Code tab when this session's terminal is the active one,
        // otherwise renameWithArg would rename the wrong (currently focused) terminal.
        if (
          isTerminalAlive(match.terminal) &&
          vscode.window.activeTerminal === match.terminal
        ) {
          void vscode.commands
            .executeCommand("workbench.action.terminal.renameWithArg", {
              name: disc.title,
            })
            .then(undefined, () => {});
        }
      }
    };

    const agyDiscovered = discoverAgySessions(this._currentCwd);
    for (const disc of agyDiscovered) {
      if (this._dismissedCliIds.has(disc.cliSessionId)) continue;

      let match = this._sessions.find(
        (s) => s.cliSessionId === disc.cliSessionId
      );

      if (!match) {
        match = this._sessions.find(
          (s) =>
            s.command.toLowerCase().startsWith("agy") &&
            !s.cliSessionId &&
            !this._sessions.some(
              (other) => other.cliSessionId === disc.cliSessionId
            ) &&
            disc.mtimeMs >= s.createdAt - 15000
        );
        if (match) {
          match.cliSessionId = disc.cliSessionId;
          match.lastUserTurnId = disc.lastUserTurnId;
          if (disc.isTurnComplete) {
            match.lastNotifiedUserTurnId = disc.lastUserTurnId;
          }
          changed = true;
        }
      }

      if (match) {
        applyDiscovered(match, disc);
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
            match.lastUserTurnId = disc.lastUserTurnId;
            if (disc.isTurnComplete) {
              match.lastNotifiedUserTurnId = disc.lastUserTurnId;
            }
            changed = true;
          }
        }

        if (match) {
          applyDiscovered(match, disc);
        }
      }
    }

    if ( this._latestSnippets.length === 0 ) {
      const firstWithSnips = [...agyDiscovered, ...discoverClaudeSessionsForCwd(this._currentCwd)].find(
        (d) => d.snippets && d.snippets.length > 0
      );
      if (firstWithSnips) {
        this._latestSnippets = firstWithSnips.snippets;
        changed = true;
      }
    }

    if (changed) {
      this._persistSessions();
    }
    return changed;
  }

  /**
   * Finds an already-open VS Code terminal belonging to this session (e.g. restored after
   * a window reload, or whose reference was lost) so we re-attach instead of opening a duplicate.
   */
  private _findOrphanTerminal(s: CockpitSession): vscode.Terminal | undefined {
    const claimed = new Set(
      this._sessions
        .filter((o) => o !== s && o.terminal)
        .map((o) => o.terminal as vscode.Terminal)
    );
    const folder = path.basename(s.cwd) || s.cwd;
    const candidates = vscode.window.terminals.filter(
      (t) => !claimed.has(t) && t.exitStatus === undefined
    );
    return (
      candidates.find((t) => t.name === `${s.title} · ${folder}`) ||
      candidates.find((t) => t.name === s.title) ||
      candidates.find(
        (t) => s.title.length > 2 && t.name.startsWith(s.title)
      ) ||
      (s.cliSessionName
        ? candidates.find((t) => t.name.startsWith(s.cliSessionName as string))
        : undefined)
    );
  }

  private _syncLiveness() {
    for (const s of this._sessions) {
      if (!isTerminalAlive(s.terminal)) {
        const orphan = this._findOrphanTerminal(s);
        s.terminal = orphan;
      }
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

  private _persistJobs() {
    void this._context.globalState.update(STORAGE_JOBS_KEY, this._jobs);
  }

  private _checkScheduledJobs(): boolean {
    const now = Date.now();
    let fired = false;
    for (const job of this._jobs) {
      if (!job.enabled) continue;
      if (now >= job.nextRunAt) {
        job.lastRunAt = now;
        job.nextRunAt = computeNextRunAt(job, now + 1000);
        fired = true;
        void this._executeScheduledJob(job);
      }
    }
    if (fired) {
      this._persistJobs();
    }
    return fired;
  }

  private async _executeScheduledJob(job: ScheduledJob) {
    const now = Date.now();
    job.lastRunAt = now;
    if (job.enabled) {
      job.nextRunAt = computeNextRunAt(job, now + 1000);
    }
    this._persistJobs();

    const lowerCmd = job.command.toLowerCase();
    const isShell =
      lowerCmd === "powershell.exe" ||
      lowerCmd === "powershell" ||
      lowerCmd === "cmd.exe" ||
      lowerCmd === "cmd";

    // Reuse existing live terminal for this job if open
    let session = job.lastSessionId
      ? this._sessions.find((s) => s.id === job.lastSessionId)
      : undefined;

    if (session && isTerminalAlive(session.terminal)) {
      session.terminal.show(false);
      if (job.prompt.trim()) {
        session.terminal.sendText(job.prompt.trim(), true);
      }
      vscode.window.setStatusBarMessage(
        `Agent Cockpit: Ran scheduled job "${job.name}"`,
        4000
      );
      await this.refreshWebviewState();
      return;
    }

    await this.spawnSession({
      title: `⏰ ${job.name}`,
      badge: job.badge,
      color: job.color,
      command: job.command,
      args: job.args,
      cwd: job.cwd || this._currentCwd,
      location: this._defaultLocation,
    });

    const spawned = this._sessions[this._sessions.length - 1];
    if (spawned) {
      job.lastSessionId = spawned.id;
      this._persistJobs();
      const delayMs = isShell ? 700 : 2800;
      if (job.prompt.trim()) {
        setTimeout(() => {
          if (spawned.terminal && isTerminalAlive(spawned.terminal)) {
            spawned.terminal.show(false);
            spawned.terminal.sendText(job.prompt.trim(), true);
          }
        }, delayMs);
      }
    }

    vscode.window.setStatusBarMessage(
      `Agent Cockpit: Started scheduled job "${job.name}"`,
      4000
    );
    await this.refreshWebviewState();
  }

  public async promptCreateScheduledJob() {
    const name = await vscode.window.showInputBox({
      title: "New Scheduled Job (1/4)",
      prompt: "Job Name",
      placeHolder: "e.g., Morning PR Summary, Run Unit Tests, Check Logs",
    });
    if (!name || !name.trim()) return;

    const installed = getInstalledPresets();
    const cliPick = await vscode.window.showQuickPick(
      installed.map((p) => ({
        label: p.label,
        description: p.command,
        preset: p,
      })),
      {
        title: "New Scheduled Job (2/4)",
        placeHolder: "Select CLI to run this scheduled job",
      }
    );
    if (!cliPick) return;

    const prompt = await vscode.window.showInputBox({
      title: "New Scheduled Job (3/4)",
      prompt: `Prompt or command to send to ${cliPick.preset.label}`,
      placeHolder:
        cliPick.preset.id === "powershell" || cliPick.preset.id === "cmd"
          ? "e.g., npm test"
          : "e.g., Review git status and summarize today's changes",
    });
    if (!prompt || !prompt.trim()) return;

    const schedPick = await vscode.window.showQuickPick(
      [
        { label: "Every 15 minutes", scheduleType: "interval" as const, intervalMinutes: 15 },
        { label: "Every 30 minutes", scheduleType: "interval" as const, intervalMinutes: 30 },
        { label: "Every 1 hour", scheduleType: "interval" as const, intervalMinutes: 60 },
        { label: "Every 5 minutes (testing)", scheduleType: "interval" as const, intervalMinutes: 5 },
        { label: "Daily at specific time (HH:MM)", scheduleType: "daily" as const },
        { label: "Weekdays (Mon–Fri) at specific time (HH:MM)", scheduleType: "weekdays" as const },
      ],
      {
        title: "New Scheduled Job (4/4)",
        placeHolder: "Choose schedule frequency",
      }
    );
    if (!schedPick) return;

    let dailyTime: string | undefined;
    if (schedPick.scheduleType === "daily" || schedPick.scheduleType === "weekdays") {
      const timeInput = await vscode.window.showInputBox({
        title: "Scheduled Time (24-hour HH:MM)",
        prompt: "Enter time in 24-hour format (e.g. 09:00, 14:30, 18:00)",
        value: "09:00",
        validateInput: (v) =>
          /^\d{1,2}:\d{2}$/.test(v.trim()) ? null : "Use HH:MM format (e.g. 09:00)",
      });
      if (!timeInput) return;
      dailyTime = timeInput.trim();
    }

    const p = cliPick.preset;
    const rawCmd = p.command.trim().toLowerCase();
    let cliName = path.basename(rawCmd, path.extname(rawCmd)) || "cli";
    if (cliName === "powershell") cliName = "ps1";

    const newJob: ScheduledJob = {
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      cliId: p.id,
      cliName,
      command: p.command,
      args: p.args,
      badge: p.badge,
      color: p.color,
      cwd: this._currentCwd,
      prompt: prompt.trim(),
      scheduleType: schedPick.scheduleType,
      intervalMinutes: schedPick.intervalMinutes,
      dailyTime,
      enabled: true,
      nextRunAt: computeNextRunAt(
        {
          scheduleType: schedPick.scheduleType,
          intervalMinutes: schedPick.intervalMinutes,
          dailyTime,
        },
        Date.now()
      ),
    };

    this._jobs.push(newJob);
    this._persistJobs();
    await this.refreshWebviewState();
    vscode.window.setStatusBarMessage(
      `Agent Cockpit: Scheduled "${newJob.name}" (${formatScheduleLabel(newJob)})`,
      4000
    );
  }

  private _persistSessions() {
    // Keep pinned sessions sorted at the top
    this._sessions.sort((a, b) => {
      const pinA = a.pinned ? 1 : 0;
      const pinB = b.pinned ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;
      return a.createdAt - b.createdAt;
    });
    const serializable: StoredSessionMeta[] = this._sessions.map((s) => ({
      id: s.id,
      cliSessionId: s.cliSessionId,
      cliSessionName: s.cliSessionName,
      title: s.title,
      badge: s.badge,
      color: s.color,
      pinned: Boolean(s.pinned),
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
        case "toggleSound":
          this._soundEnabled = !this._soundEnabled;
          await this._context.globalState.update(
            SOUND_PREF_KEY,
            this._soundEnabled
          );
          if (this._soundEnabled) {
            this._triggerNotificationSound("complete", "Sound Enabled");
          }
          await this.refreshWebviewState();
          break;
        case "selectCliPreset":
          if (typeof msg.presetId === "string" && msg.presetId) {
            this._lastUsedCliId = msg.presetId;
            await this._context.globalState.update(
              LAST_CLI_KEY,
              this._lastUsedCliId
            );
            await this.refreshWebviewState();
          }
          break;
        case "spawnSession":
          if (typeof msg.presetId === "string" && msg.presetId) {
            this._lastUsedCliId = msg.presetId;
            await this._context.globalState.update(
              LAST_CLI_KEY,
              this._lastUsedCliId
            );
          }
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
        case "togglePinSession":
          if (typeof msg.id === "string") {
            const target = this._sessions.find((s) => s.id === msg.id);
            if (target) {
              target.pinned = !target.pinned;
              this._persistSessions();
              await this.refreshWebviewState();
            }
          }
          break;
        case "setSessionColor":
          if (typeof msg.id === "string" && typeof msg.color === "string") {
            const target = this._sessions.find((s) => s.id === msg.id);
            if (target) {
              target.color = msg.color;
              this._persistSessions();
              await this.refreshWebviewState();
            }
          }
          break;
        case "copyToClipboard":
          if (typeof msg.text === "string") {
            await vscode.env.clipboard.writeText(msg.text);
            vscode.window.setStatusBarMessage(
              "Agent Cockpit: Copied to clipboard!",
              2500
            );
          }
          break;
        case "runCommandInShell":
          if (typeof msg.command === "string" && msg.command.trim()) {
            await this._runCommandInShellSession(msg.command.trim());
          }
          break;
        case "sendCommandToTerminal":
          if (typeof msg.command === "string" && msg.command.trim()) {
            await this.sendTextToActiveAgent(
              msg.command.trim(),
              Boolean(msg.execute)
            );
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
        case "useSkillOrAgent":
          if (typeof msg.name === "string") {
            const promptPrefix =
              msg.kind === "agent"
                ? `Use the ${msg.name} subagent to `
                : `Use the ${msg.name} skill to `;
            await this.sendTextToActiveAgent(promptPrefix, false);
          }
          break;
        case "openSkillFile":
          if (typeof msg.filePath === "string" && fs.existsSync(msg.filePath)) {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.file(msg.filePath)
            );
            await vscode.window.showTextDocument(doc);
          }
          break;
        case "openFileDiff":
          await this._openGitDiffForFile(msg.file);
          break;
        case "saveHandoff":
          await this._saveHandoffContent(msg.content || "");
          break;
        case "sendHandoff": {
          const finalHandoff = await this._saveHandoffContent(
            msg.content || "",
            true
          );
          await this.sendTextToActiveAgent(
            `Please read .agent/handoff.md and continue from there.`,
            true
          );
          if (finalHandoff) {
            await this.refreshWebviewState();
          }
          break;
        }
        case "handoffSession":
          await this.handoffSessionToTarget(
            typeof msg.id === "string" ? msg.id : undefined
          );
          break;
        case "createScheduledJob":
          await this.promptCreateScheduledJob();
          break;
        case "toggleScheduledJob":
          if (typeof msg.id === "string") {
            const job = this._jobs.find((j) => j.id === msg.id);
            if (job) {
              job.enabled = !job.enabled;
              if (job.enabled) {
                job.nextRunAt = computeNextRunAt(job, Date.now());
              }
              this._persistJobs();
              await this.refreshWebviewState();
            }
          }
          break;
        case "runScheduledJobNow":
          if (typeof msg.id === "string") {
            const job = this._jobs.find((j) => j.id === msg.id);
            if (job) {
              void this._executeScheduledJob(job);
            }
          }
          break;
        case "deleteScheduledJob":
          if (typeof msg.id === "string") {
            this._jobs = this._jobs.filter((j) => j.id !== msg.id);
            this._persistJobs();
            await this.refreshWebviewState();
          }
          break;
        case "jumpToTimelineEntry":
          if (typeof msg.question === "string" && msg.question.trim()) {
            const snippet = msg.question.trim().slice(0, 40);
            await vscode.env.clipboard.writeText(snippet);
            if (this._activeSessionId) {
              await this.focusOrRelaunchSessionById(this._activeSessionId);
            }
            try {
              await vscode.commands.executeCommand(
                "workbench.action.terminal.focusFind"
              );
            } catch {
              // ignore
            }
            vscode.window.setStatusBarMessage(
              `Timeline: Copied "${snippet}" — press Ctrl+V + Enter in Terminal Find to jump`,
              4500
            );
          }
          break;
        case "reaskTimelineEntry":
          if (typeof msg.question === "string" && msg.question.trim()) {
            await this.sendTextToActiveAgent(msg.question.trim(), false);
          }
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

    if (!isTerminalAlive(found.terminal)) {
      found.terminal = this._findOrphanTerminal(found);
    }
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

    // Never open a duplicate: if the terminal is still open (or an orphaned matching one exists), just focus it
    if (!isTerminalAlive(found.terminal)) {
      found.terminal = this._findOrphanTerminal(found);
    }
    if (isTerminalAlive(found.terminal)) {
      found.status = found.status === "stopped" ? "idle" : found.status;
      this._activeSessionId = found.id;
      this._currentCwd = found.cwd;
      found.terminal.show(false);
      try {
        await vscode.commands.executeCommand("workbench.action.terminal.focus");
      } catch {
        // ignore
      }
      await this.refreshWebviewState();
      return;
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

  /**
   * Executes a shell command recommended by an AI inside a dedicated PowerShell terminal
   * in the current working directory (reusing an open Shell session or creating one).
   */
  private async _runCommandInShellSession(commandText: string) {
    let shellSess = this._sessions.find(
      (s) =>
        s.command.toLowerCase().includes("powershell") &&
        s.cwd.toLowerCase() === this._currentCwd.toLowerCase()
    );

    if (!shellSess) {
      await this.spawnSession({
        title: "Shell",
        badge: ">_",
        color: "#64748b",
        command: "powershell.exe",
        args: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
        cwd: this._currentCwd,
        location: this._defaultLocation,
      });
      shellSess = this._sessions[this._sessions.length - 1];
    } else if (!isTerminalAlive(shellSess.terminal)) {
      await this.relaunchSessionById(shellSess.id, false);
    }

    if (shellSess && shellSess.terminal) {
      shellSess.terminal.show(false);
      shellSess.terminal.sendText(commandText, true);
      try {
        await vscode.commands.executeCommand("workbench.action.terminal.focus");
      } catch {
        // ignore
      }
    }
  }

  /**
   * Captures currently highlighted text from either the active Terminal or active Text Editor,
   * cleans common TUI border/prompt prefixes, and runs it in Shell or sends it to the active terminal.
   */
  public async handleHighlightedTextAction(mode: "runInShell" | "sendToTerminal") {
    let selectedText = "";
    const editor = vscode.window.activeTextEditor;

    if (editor && !editor.selection.isEmpty) {
      selectedText = editor.document.getText(editor.selection);
    } else {
      // Copy highlighted text from the focused terminal
      const prevClipboard = await vscode.env.clipboard.readText();
      try {
        await vscode.commands.executeCommand(
          "workbench.action.terminal.copySelection"
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        selectedText = await vscode.env.clipboard.readText();
      } catch {
        selectedText = prevClipboard;
      }
    }

    const cleaned = selectedText
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^[│┃|]\s?/, "")
          .replace(/\s?[│┃|]$/, "")
          .replace(/^\s*(?:PS [^>]+>|\$|❯|>)\s+/, "")
          .trim()
      )
      .filter((line) => line.length > 0)
      .join("\n")
      .trim();

    if (!cleaned) {
      vscode.window.showWarningMessage(
        "Highlight text or a command first, then press Ctrl+Alt+R (Run in Shell), Ctrl+Alt+T (Send to Terminal), or click the ▶ / >_ icons in the terminal tab bar."
      );
      return;
    }

    if (mode === "runInShell") {
      await this._runCommandInShellSession(cleaned);
    } else {
      await this.sendTextToActiveAgent(cleaned, false);
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

  private async _saveHandoffContent(
    content: string,
    autoGenerateIfEmpty = false
  ): Promise<string> {
    const p = this._getHandoffPath();
    let textToWrite = content.trim();

    if (!textToWrite && autoGenerateIfEmpty) {
      const existing = this._readHandoffContent().trim();
      if (existing) {
        textToWrite = existing;
      } else {
        const gitInfo = await this._getGitChanges(this._currentCwd);
        const sessionLines = this._sessions
          .map(
            (s) =>
              `- [${s.badge}] ${s.title} (${s.status}) — cwd: ${s.cwd}`
          )
          .join("\n");
        const gitLines =
          gitInfo.changes.length > 0
            ? gitInfo.changes.map((c) => `- ${c.status} ${c.file}`).join("\n")
            : "- Clean working tree";
        textToWrite = [
          `# Agent Cockpit Handoff Context`,
          `Updated: ${new Date().toISOString()}`,
          `Workspace: ${this._currentCwd}`,
          gitInfo.branch ? `Branch: ${gitInfo.branch}` : "",
          ``,
          `## Active Agent Sessions`,
          sessionLines || "- None",
          ``,
          `## Modified / Untracked Files`,
          gitLines,
          ``,
          `## Next Task / Notes`,
          `- Review current changes and continue implementation.`,
        ]
          .filter((l) => l !== undefined)
          .join("\n");
      }
    }

    if (!textToWrite) {
      return "";
    }

    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, textToWrite + "\n", "utf8");
      vscode.window.setStatusBarMessage("Saved .agent/handoff.md", 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed saving handoff.md: ${msg}`);
    }
    return textToWrite;
  }

  /**
   * 1-Click Handoff: extracts real conversation context from a source chat session,
   * writes structured handoff notes to .agent/handoff.md, and sends them to a chosen target session.
   */
  public async handoffSessionToTarget(sourceSessionId?: string) {
    this._syncLiveness();
    this._syncCliStoredSessionNames();

    const source =
      (sourceSessionId
        ? this._sessions.find((s) => s.id === sourceSessionId)
        : undefined) ||
      this._sessions.find((s) => s.id === this._activeSessionId) ||
      this._sessions[0];

    if (!source) {
      vscode.window.showWarningMessage(
        "No source session found to generate handoff notes from."
      );
      return;
    }

    const otherSessions = this._sessions.filter((s) => s.id !== source.id);
    type TargetPick = vscode.QuickPickItem & {
      sessionId?: string;
      launchNew?: boolean;
      preset?: ReturnType<typeof getInstalledPresets>[number];
    };

    const items: TargetPick[] = [];

    if (otherSessions.length > 0) {
      items.push({
        label: "Existing Chat Sessions",
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const s of otherSessions) {
        const cli = path
          .basename(
            (s.command || "cli").trim().toLowerCase(),
            path.extname(s.command || "")
          )
          .replace(/^powershell$/, "ps1");
        items.push({
          label: s.title,
          description: `${cli} · ${path.basename(s.cwd)}`,
          detail:
            s.status === "stopped"
              ? "Paused — will auto-resume and receive handoff"
              : `Live (${s.status})`,
          sessionId: s.id,
        });
      }
    }

    const installed = getInstalledPresets();
    if (installed.length > 0) {
      items.push({
        label: "Create New Chat with CLI",
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const p of installed) {
        items.push({
          label: `$(add) New ${p.label} Session`,
          description: p.command,
          detail: `Create a new ${p.label} chat and send handoff notes`,
          launchNew: true,
          preset: p,
        });
      }
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: `Handoff from "${source.title}"`,
      placeHolder: "Choose the target chat session to receive handoff notes…",
    });
    if (!picked) return;

    // 1. Extract real conversation transcript + git context from source session
    const transcript = extractTranscriptSummaryForHandoff(source);
    const gitInfo = await this._getGitChanges(source.cwd || this._currentCwd);
    const sourceCli = path
      .basename(
        (source.command || "cli").trim().toLowerCase(),
        path.extname(source.command || "")
      )
      .replace(/^powershell$/, "ps1");

    const userLines =
      transcript.userPrompts.length > 0
        ? transcript.userPrompts.map((p, idx) => `${idx + 1}. ${p}`).join("\n")
        : "- (No transcript prompts captured — check recent workspace changes below)";

    const assistantLines =
      transcript.assistantReplies.length > 0
        ? transcript.assistantReplies
            .map((r, idx) => `### Turn ${idx + 1}\n${r}`)
            .join("\n\n")
        : "- (No assistant transcript found on disk for this CLI)";

    const gitLines =
      gitInfo.changes.length > 0
        ? gitInfo.changes.map((c) => `- \`${c.status}\` ${c.file}`).join("\n")
        : "- Clean working tree";

    const handoffMarkdown = [
      `# Handoff from "${source.title}" (${sourceCli})`,
      `- **Generated**: ${new Date().toISOString()}`,
      `- **Workspace**: \`${source.cwd}\``,
      gitInfo.branch ? `- **Git Branch**: \`${gitInfo.branch}\`` : "",
      source.cliSessionId ? `- **Source Session ID**: \`${source.cliSessionId}\`` : "",
      ``,
      `## Recent User Requests`,
      userLines,
      ``,
      `## Latest Progress & Assistant Context`,
      assistantLines,
      ``,
      `## Modified / Untracked Files`,
      gitLines,
      ``,
      `## Next Action`,
      `Continue seamlessly from the context above. Confirm you have read this handoff and proceed.`,
    ]
      .filter((line) => line !== undefined)
      .join("\n");

    // 2. Write .agent/handoff.md into workspace (and target cwd if different)
    const writeHandoffTo = (dir: string) => {
      const targetFile = path.join(dir, ".agent", "handoff.md");
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.writeFileSync(targetFile, handoffMarkdown + "\n", "utf8");
    };

    try {
      writeHandoffTo(this._currentCwd);
      if (source.cwd && source.cwd.toLowerCase() !== this._currentCwd.toLowerCase()) {
        writeHandoffTo(source.cwd);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed writing .agent/handoff.md: ${errMsg}`);
      return;
    }

    // 3. Focus/resume or launch target session and send the handoff prompt
    const promptToSend = `Read .agent/handoff.md (handoff generated from "${source.title}") and continue from there.`;
    let targetTitle = picked.label;

    if (picked.launchNew && picked.preset) {
      const p = picked.preset;
      targetTitle = p.label;
      await this.spawnSession({
        title: `${p.label.split(" ")[0]} · Handoff`,
        badge: p.badge,
        color: p.color,
        command: p.command,
        args: p.args,
        cwd: source.cwd || this._currentCwd,
        location: this._defaultLocation,
      });
      // Give the newly launched CLI a moment to initialize before sending the handoff prompt
      const newSession = this._sessions[this._sessions.length - 1];
      setTimeout(() => {
        if (newSession && newSession.terminal && isTerminalAlive(newSession.terminal)) {
          newSession.terminal.show(false);
          newSession.terminal.sendText(promptToSend, true);
        }
      }, 2800);
    } else if (picked.sessionId) {
      const target = this._sessions.find((s) => s.id === picked.sessionId);
      if (!target) return;
      targetTitle = target.title;
      if (target.cwd && target.cwd.toLowerCase() !== this._currentCwd.toLowerCase()) {
        try {
          writeHandoffTo(target.cwd);
        } catch {
          // ignore
        }
      }
      const wasStopped = !isTerminalAlive(target.terminal) && !this._findOrphanTerminal(target);
      await this.focusOrRelaunchSessionById(target.id);
      if (wasStopped) {
        setTimeout(() => {
          if (target.terminal && isTerminalAlive(target.terminal)) {
            target.terminal.show(false);
            target.terminal.sendText(promptToSend, true);
          }
        }, 2800);
      } else if (target.terminal) {
        target.terminal.show(false);
        target.terminal.sendText(promptToSend, true);
        try {
          await vscode.commands.executeCommand("workbench.action.terminal.focus");
        } catch {
          // ignore
        }
      }
    }

    await this.refreshWebviewState();
    vscode.window.setStatusBarMessage(
      `Agent Cockpit: Handed off "${source.title}" → "${targetTitle}" (.agent/handoff.md)`,
      4500
    );
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
    this._syncLiveness();
    this._onStateChanged?.();
    if (!this._view) return;
    const gitInfo = await this._getGitChanges(this._currentCwd);
    const handoffContent = this._readHandoffContent();
    const mcpServers = discoverMcpServers(this._currentCwd);
    const skillsAndAgents = discoverSkillsAndAgents(this._currentCwd);
    const wbConfig = vscode.workspace.getConfiguration("workbench.editor");
    const showTabs = wbConfig.get<string>("showTabs") || "multiple";
    const installedPresets = getInstalledPresets();
    const validLastCliId = installedPresets.some(
      (p) => p.id === this._lastUsedCliId
    )
      ? this._lastUsedCliId
      : installedPresets[0]?.id || "agy";

    const activeSnippets =
      (this._activeSessionId &&
        this._snippetsBySessionId.get(this._activeSessionId)) ||
      this._latestSnippets ||
      [];

    const activeSessionObj =
      this._sessions.find((s) => s.id === this._activeSessionId) ||
      this._sessions[this._sessions.length - 1];
    const activeTimeline = extractSessionTimeline(activeSessionObj);

    this._view.webview.postMessage({
      type: "state",
      currentCwd: this._currentCwd,
      folderName: path.basename(this._currentCwd) || this._currentCwd,
      defaultLocation: this._defaultLocation,
      topTabsHidden: showTabs === "none",
      soundEnabled: this._soundEnabled,
      lastUsedCliId: validLastCliId,
      activeSessionId: this._activeSessionId,
      activeSessionTitle: activeSessionObj?.title || "",
      activeTimeline,
      presets: installedPresets,
      gitBranch: gitInfo.branch,
      gitChanges: gitInfo.changes,
      mcpServers,
      skillsAndAgents,
      scheduledJobs: this._jobs.map((j) => ({
        id: j.id,
        name: j.name,
        cliName: j.cliName,
        color: j.color,
        prompt: j.prompt,
        scheduleLabel: formatScheduleLabel(j),
        enabled: j.enabled,
        nextRunText: j.enabled
          ? new Date(j.nextRunAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "Paused",
        lastRunText: j.lastRunAt
          ? new Date(j.lastRunAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "Never",
      })),
      aiSnippets: activeSnippets,
      handoffContent,
      sessions: this._sessions.map((s, idx) => {
        const rawCmd = (s.command || "").trim().toLowerCase();
        let cliName = path.basename(rawCmd, path.extname(rawCmd)) || "cli";
        if (cliName === "powershell") cliName = "ps1";
        return {
          id: s.id,
          cliSessionId: s.cliSessionId,
          index: idx + 1,
          title: s.title,
          badge: s.badge,
          cliName,
          color: s.color,
          pinned: Boolean(s.pinned),
          cwd: s.cwd,
          folderName: path.basename(s.cwd) || s.cwd,
          branch: s.branch,
          isWorktree: s.isWorktree,
          status: s.status,
        };
      }),
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
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
      --hover: var(--vscode-list-hoverBackground);
      --active-bg: var(--vscode-list-inactiveSelectionBackground, rgba(128, 128, 128, 0.16));
      --accent: var(--vscode-focusBorder, var(--vscode-button-background, #007acc));
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn-sec-bg: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.16));
      --btn-sec-fg: var(--vscode-button-secondaryForeground, var(--fg));
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground, var(--fg));
      --input-border: var(--vscode-input-border, var(--border));
      --dropdown-bg: var(--vscode-dropdown-background, var(--input-bg));
      --dropdown-fg: var(--vscode-dropdown-foreground, var(--fg));
      --dropdown-border: var(--vscode-dropdown-border, var(--border));
      --st-working: #22c55e;
      --st-needs-input: #f59e0b;
      --st-idle: #38bdf8;
      --st-stopped: var(--muted);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, "Segoe UI", -apple-system, sans-serif);
      font-size: 12px;
      color: var(--fg);
      background: var(--bg);
      padding: 8px 8px 6px 8px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 6px;
      user-select: none;
    }

    svg.ic {
      width: 13px;
      height: 13px;
      flex-shrink: 0;
      display: inline-block;
      vertical-align: middle;
    }
    svg.ic-sm {
      width: 11px;
      height: 11px;
      flex-shrink: 0;
    }

    /* Compact Native Top Bar */
    .top-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 24px;
    }
    .cwd-btn {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 3px 6px;
      cursor: pointer;
      color: var(--fg);
      font-size: 11.5px;
      transition: background 0.1s;
    }
    .cwd-btn:hover {
      background: var(--hover);
    }
    .cwd-btn svg {
      color: var(--muted);
    }
    .cwd-name {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .branch-chip {
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 10px;
      color: var(--muted);
      background: rgba(128, 128, 128, 0.14);
      padding: 1px 5px;
      border-radius: 3px;
      margin-left: auto;
      white-space: nowrap;
    }

    .tool-btn {
      height: 22px;
      min-width: 24px;
      padding: 0 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--muted);
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.2px;
      cursor: pointer;
      transition: background 0.1s, color 0.1s, border-color 0.1s;
    }
    .tool-btn:hover {
      background: var(--hover);
      color: var(--fg);
    }
    .tool-btn.active {
      background: var(--active-bg);
      color: var(--fg);
      border-color: var(--border);
    }

    /* Unified Compact Split Launch Bar */
    .launch-bar {
      display: flex;
      align-items: stretch;
      gap: 4px;
    }
    .launch-primary-btn {
      flex: 1;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 0 10px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.1s;
    }
    .launch-primary-btn:hover {
      background: var(--btn-hover);
    }
    .cli-select {
      width: 118px;
      height: 26px;
      background: var(--dropdown-bg);
      color: var(--dropdown-fg);
      border: 1px solid var(--dropdown-border);
      border-radius: 4px;
      padding: 0 6px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      outline: none;
    }
    .cli-select:focus {
      border-color: var(--accent);
    }

    /* Custom Command Inline Input */
    .custom-drawer {
      display: none;
      gap: 4px;
      padding: 4px 0;
    }
    .custom-drawer.open { display: flex; }

    input[type="text"] {
      width: 100%;
      height: 24px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 0 7px;
      font-size: 11.5px;
      font-family: inherit;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: var(--accent);
    }

    .send-btn {
      height: 24px;
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 4px;
      padding: 0 10px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    }
    .send-btn:hover {
      background: var(--btn-hover);
    }

    /* Flat Linear / VS Code Native Session List */
    .sessions-container {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding-right: 2px;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.55px;
      text-transform: uppercase;
      color: var(--muted);
      padding: 8px 6px 3px 6px;
      user-select: none;
    }
    .section-header:first-child {
      padding-top: 2px;
    }
    .section-header-left {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      overflow: hidden;
    }
    .section-header-left span {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .section-count {
      font-size: 10px;
      font-weight: 500;
      color: var(--muted);
      opacity: 0.8;
    }
    .section-divider {
      height: 1px;
      background: var(--border);
      margin: 5px 4px 2px 4px;
      opacity: 0.7;
    }

    .session-card {
      position: relative;
      display: flex;
      flex-direction: column;
      border-radius: 4px;
      border-left: 2px solid transparent;
      cursor: pointer;
      transition: background 0.08s;
    }
    .session-card-main {
      display: flex;
      align-items: center;
      gap: 7px;
      height: 28px;
      padding: 0 6px;
      width: 100%;
    }
    .session-card:hover {
      background: var(--hover);
    }
    .session-card.active {
      background: var(--active-bg);
      border-left-color: var(--accent);
    }
    .session-card.stopped .s-title {
      opacity: 0.72;
    }

    .status-led {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .led-working {
      background: var(--st-working);
      box-shadow: 0 0 6px var(--st-working);
      animation: pulse 1.3s infinite ease-in-out;
    }
    .led-needs-input {
      background: var(--st-needs-input);
      box-shadow: 0 0 6px var(--st-needs-input);
      animation: pulse 1.1s infinite ease-in-out;
    }
    .led-idle {
      background: var(--st-idle);
      opacity: 0.85;
    }
    .led-stopped {
      background: var(--st-stopped);
      opacity: 0.45;
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.3); opacity: 0.6; }
    }

    .s-title {
      flex: 1;
      min-width: 0;
      font-weight: 400;
      font-size: 12px;
      color: var(--fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .session-card.active .s-title {
      font-weight: 500;
    }
    .s-rename-input {
      flex: 1;
      height: 20px !important;
      padding: 0 4px !important;
      font-size: 11.5px !important;
    }

    .cli-meta {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 10px;
      color: var(--muted);
      padding: 1px 4px;
      border-radius: 3px;
      flex-shrink: 0;
      cursor: pointer;
    }
    .cli-meta:hover {
      background: rgba(128, 128, 128, 0.16);
      color: var(--fg);
    }
    .color-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .state-badge {
      font-size: 9.5px;
      font-weight: 600;
      padding: 1px 4px;
      border-radius: 3px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .st-working { color: var(--st-working); background: rgba(34, 197, 94, 0.14); }
    .st-needs-input { color: var(--st-needs-input); background: rgba(245, 158, 11, 0.16); }
    .st-stopped { color: var(--muted); background: rgba(128, 128, 128, 0.14); }

    .shortcut-hint {
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 9.5px;
      color: var(--muted);
      opacity: 0.65;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .row-actions {
      display: none;
      align-items: center;
      gap: 1px;
      flex-shrink: 0;
    }
    .session-card:hover .row-actions {
      display: flex;
    }
    .session-card:hover .cli-meta,
    .session-card:hover .state-badge,
    .session-card:hover .shortcut-hint {
      display: none;
    }

    .icon-action {
      width: 20px;
      height: 20px;
      border-radius: 3px;
      border: none;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.1s, color 0.1s;
    }
    .icon-action:hover {
      color: var(--fg);
      background: rgba(128, 128, 128, 0.2);
    }
    .icon-action.danger:hover {
      color: #f87171;
      background: rgba(239, 68, 68, 0.14);
    }

    .color-palette-row {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 4px 8px 6px 20px;
    }
    .color-palette-row.open {
      display: flex;
    }
    .color-swatch {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.35);
      cursor: pointer;
      transition: transform 0.1s;
    }
    .color-swatch:hover {
      transform: scale(1.25);
    }

    .empty-card {
      margin: auto;
      padding: 16px 12px;
      color: var(--muted);
      font-size: 11.5px;
      text-align: center;
    }

    /* Clean Native Segmented Footer */
    .footer-bar {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
    }
    .footer-tabs {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 2px;
    }
    .footer-btn {
      height: 24px;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      border-radius: 3px 3px 0 0;
      color: var(--muted);
      padding: 0 4px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      text-align: center;
      white-space: nowrap;
      transition: color 0.1s, background 0.1s, border-color 0.1s;
    }
    .footer-btn:hover {
      color: var(--fg);
      background: var(--hover);
    }
    .footer-btn.active {
      color: var(--fg);
      font-weight: 600;
      border-bottom-color: var(--accent);
    }

    .drawer-pane {
      display: none;
      flex-direction: column;
      gap: 2px;
      max-height: 185px;
      overflow-y: auto;
      padding: 4px 0;
    }
    .drawer-pane.open { display: flex; }

    .item-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      padding: 4px 6px;
      border-radius: 4px;
      transition: background 0.08s;
    }
    .item-row:hover {
      background: var(--hover);
    }
    .item-title {
      font-weight: 400;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }
    .scope-pill {
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 9.5px;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(128, 128, 128, 0.14);
      color: var(--muted);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .mcp-connected { color: var(--st-working); background: rgba(34, 197, 94, 0.14); }
    .mcp-configured { color: var(--st-idle); background: rgba(56, 189, 248, 0.14); }
    .mcp-error { color: #f87171; background: rgba(239, 68, 68, 0.14); }

    .drawer-action-btn {
      height: 24px;
      width: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      background: var(--btn-sec-bg);
      color: var(--btn-sec-fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      margin-bottom: 4px;
    }
    .drawer-action-btn:hover {
      background: var(--hover);
      color: var(--fg);
    }
  </style>
</head>
<body>
  <!-- Compact Workspace & Mode Strip -->
  <div class="top-bar">
    <button id="cwd-pill" class="cwd-btn" title="Change working directory">
      <svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7z"/></svg>
      <span id="cwd-name" class="cwd-name">workspace</span>
      <span id="branch-tag" class="branch-chip" style="display:none;"></span>
    </button>
    <button id="sound-toggle" class="tool-btn active" title="Toggle completion notification sound"></button>
    <button id="zen-tabs-toggle" class="tool-btn" title="Hide/Show top Editor Tab bar">Zen</button>
    <button id="wt-toggle" class="tool-btn" title="Isolate next session in a Git Worktree">WT</button>
  </div>

  <!-- Compact Split Launch Control -->
  <div class="launch-bar">
    <button id="launch-last-btn" class="launch-primary-btn" title="Launch last used CLI agent">
      <svg class="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
      <span id="launch-last-label">New Session</span>
    </button>
    <select id="cli-dropdown" class="cli-select" title="Select installed CLI"></select>
  </div>

  <div id="custom-drawer" class="custom-drawer">
    <input id="custom-cmd" type="text" placeholder="Command (e.g. agy, claude, aider)" />
    <button id="custom-go" class="send-btn">Run</button>
  </div>

  <!-- Flat Grouped Conversations List (Pinned -> Grouped by Project) -->
  <div id="session-list" class="sessions-container"></div>

  <!-- Segmented Footer -->
  <div class="footer-bar">
    <div id="mcp-drawer" class="drawer-pane"></div>
    <div id="skills-drawer" class="drawer-pane"></div>
    <div id="jobs-drawer" class="drawer-pane"></div>

    <div class="footer-tabs">
      <button id="tab-mcp" class="footer-btn" title="MCP servers & status">MCP (<span id="mcp-count">0</span>)</button>
      <button id="tab-skills" class="footer-btn" title="Available Skills & Subagents">Skills (<span id="skills-count">0</span>)</button>
      <button id="tab-jobs" class="footer-btn" title="Automated scheduled jobs">Jobs (<span id="jobs-count">0</span>)</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const ICONS = {
      bell: '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2a4 4 0 0 0-4 4v2.5L2.7 11h10.6L12 8.5V6a4 4 0 0 0-4-4z"/><path d="M6.5 13a1.5 1.5 0 0 0 3 0"/></svg>',
      bellOff: '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5A4 4 0 0 1 12 6v2.5l1.3 2.5H9.5"/><path d="M4 6v2.5L2.7 11h4"/><path d="M2 2l12 12"/></svg>',
      pin: '<svg class="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5l4 4-2.5 2.5-.5 2.5-3.5-3.5-3.5 3.5"/><path d="M4.5 9.5L7 7l2.5-4.5"/></svg>',
      folder: '<svg class="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7z"/></svg>',
      handoff: '<svg class="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3l2.5 2.5L11 8"/><path d="M2.5 5.5h11"/><path d="M5 13l-2.5-2.5L5 8"/><path d="M13.5 10.5h-11"/></svg>',
      color: '<svg class="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5"/></svg>',
      edit: '<svg class="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.2 2.5l2.3 2.3-7.7 7.7H3.5v-2.3l7.7-7.7z"/></svg>',
      at: '<svg class="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="2.6"/><path d="M10.6 8v.8a1.7 1.7 0 0 0 3.4 0V8a6 6 0 1 0-2.4 4.8"/></svg>',
      close: '<svg class="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
      play: '<svg class="ic-sm" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 3l8.5 5-8.5 5V3z"/></svg>',
      pause: '<svg class="ic-sm" viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="3" width="3" height="10" rx="0.5"/><rect x="9" y="3" width="3" height="10" rx="0.5"/></svg>',
      plus: '<svg class="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
      ext: '<svg class="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h7v7"/><path d="M13 3L6 10"/></svg>',
      enter: '<svg class="ic-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4v4a2 2 0 0 1-2 2H3.5"/><path d="M6 7.5L3.5 10 6 12.5"/></svg>'
    };

    let state = {
      currentCwd: "",
      defaultLocation: "editor",
      useWorktree: false,
      activeFooter: null,
    };

    let audioCtx = null;
    function playWebAudioChime(kind) {
      try {
        if (!audioCtx) {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          audioCtx = new AudioContextClass();
        }
        if (audioCtx.state === "suspended") {
          audioCtx.resume();
        }
        const now = audioCtx.currentTime;
        const notes = kind === "approval" ? [659.25, 880.0] : [523.25, 783.99];
        notes.forEach((freq, idx) => {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(freq, now + idx * 0.11);
          gain.gain.setValueAtTime(0.001, now + idx * 0.11);
          gain.gain.exponentialRampToValueAtTime(0.18, now + idx * 0.11 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.11 + 0.35);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(now + idx * 0.11);
          osc.stop(now + idx * 0.11 + 0.36);
        });
      } catch {
        // ignore
      }
    }

    const cwdPill = document.getElementById("cwd-pill");
    const cwdName = document.getElementById("cwd-name");
    const branchTag = document.getElementById("branch-tag");
    const soundToggle = document.getElementById("sound-toggle");
    const zenTabsToggle = document.getElementById("zen-tabs-toggle");
    const wtToggle = document.getElementById("wt-toggle");
    const launchLastBtn = document.getElementById("launch-last-btn");
    const launchLastLabel = document.getElementById("launch-last-label");
    const cliDropdown = document.getElementById("cli-dropdown");
    const customDrawer = document.getElementById("custom-drawer");
    const customCmd = document.getElementById("custom-cmd");
    const customGo = document.getElementById("custom-go");
    const sessionList = document.getElementById("session-list");

    const mcpDrawer = document.getElementById("mcp-drawer");
    const skillsDrawer = document.getElementById("skills-drawer");
    const jobsDrawer = document.getElementById("jobs-drawer");

    const mcpCount = document.getElementById("mcp-count");
    const skillsCount = document.getElementById("skills-count");
    const jobsCount = document.getElementById("jobs-count");

    const tabMcp = document.getElementById("tab-mcp");
    const tabSkills = document.getElementById("tab-skills");
    const tabJobs = document.getElementById("tab-jobs");

    soundToggle.innerHTML = ICONS.bell;

    const COLOR_PALETTE = [
      "#3b82f6",
      "#e07a5f",
      "#10b981",
      "#8b5cf6",
      "#f59e0b",
      "#ec4899",
    ];

    function setFooterDrawer(which) {
      state.activeFooter = state.activeFooter === which ? null : which;
      mcpDrawer.classList.toggle("open", state.activeFooter === "mcp");
      skillsDrawer.classList.toggle("open", state.activeFooter === "skills");
      jobsDrawer.classList.toggle("open", state.activeFooter === "jobs");

      tabMcp.classList.toggle("active", state.activeFooter === "mcp");
      tabSkills.classList.toggle("active", state.activeFooter === "skills");
      tabJobs.classList.toggle("active", state.activeFooter === "jobs");

      if (state.activeFooter === "mcp") {
        vscode.postMessage({ type: "refreshGit" });
      }
    }

    tabMcp.addEventListener("click", () => setFooterDrawer("mcp"));
    tabSkills.addEventListener("click", () => setFooterDrawer("skills"));
    tabJobs.addEventListener("click", () => setFooterDrawer("jobs"));

    cwdPill.addEventListener("click", () => {
      vscode.postMessage({ type: "browseCwd" });
    });
    soundToggle.addEventListener("click", () => {
      vscode.postMessage({ type: "toggleSound" });
    });
    zenTabsToggle.addEventListener("click", () => {
      vscode.postMessage({ type: "toggleTopTabs" });
    });
    wtToggle.addEventListener("click", () => {
      state.useWorktree = !state.useWorktree;
      wtToggle.classList.toggle("active", state.useWorktree);
    });

    function spawnPreset(p) {
      if (!p) return;
      vscode.postMessage({
        type: "spawnSession",
        presetId: p.id,
        title: p.label.split(" ")[0],
        badge: p.badge,
        color: p.color,
        command: p.command,
        args: p.args,
        cwd: state.currentCwd,
        location: state.defaultLocation,
        useWorktree: state.useWorktree,
      });
    }

    launchLastBtn.addEventListener("click", () => {
      const presets = state.presets || [];
      const activePreset =
        presets.find((p) => p.id === state.lastUsedCliId) || presets[0];
      if (activePreset) {
        spawnPreset(activePreset);
      }
    });

    cliDropdown.addEventListener("change", () => {
      const val = cliDropdown.value;
      if (val === "__custom__") {
        customDrawer.classList.add("open");
        customCmd.focus();
        cliDropdown.value = state.lastUsedCliId;
        return;
      }
      customDrawer.classList.remove("open");
      state.lastUsedCliId = val;
      vscode.postMessage({ type: "selectCliPreset", presetId: val });
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

    function stateBadgeHtml(status) {
      if (status === "working") return '<span class="state-badge st-working">Live</span>';
      if (status === "needs-input") return '<span class="state-badge st-needs-input">Input</span>';
      if (status === "stopped") return '<span class="state-badge st-stopped">Resume</span>';
      return "";
    }

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "playChime") {
        playWebAudioChime(msg.kind);
        return;
      }
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

      soundToggle.innerHTML = msg.soundEnabled ? ICONS.bell : ICONS.bellOff;
      soundToggle.classList.toggle("active", Boolean(msg.soundEnabled));
      zenTabsToggle.classList.toggle("active", Boolean(msg.topTabsHidden));

      state.presets = msg.presets || [];
      state.lastUsedCliId = msg.lastUsedCliId || (state.presets[0] && state.presets[0].id);

      const selectedPreset =
        state.presets.find((p) => p.id === state.lastUsedCliId) ||
        state.presets[0];

      if (selectedPreset) {
        launchLastLabel.textContent = "New " + selectedPreset.label.split(" ")[0];
        launchLastBtn.title =
          "Launch " + selectedPreset.label + " (" + selectedPreset.command + ")";
      }

      cliDropdown.innerHTML = "";
      state.presets.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.label;
        if (p.id === state.lastUsedCliId) opt.selected = true;
        cliDropdown.appendChild(opt);
      });
      const customOpt = document.createElement("option");
      customOpt.value = "__custom__";
      customOpt.textContent = "Custom CLI…";
      cliDropdown.appendChild(customOpt);

      // Flat Native Rows: Pinned at top, then Conversations grouped & sorted by Project/Folder
      sessionList.innerHTML = "";
      if (!msg.sessions || msg.sessions.length === 0) {
        sessionList.innerHTML = '<div class="empty-card">Launch a CLI agent above to start a session</div>';
      } else {
        const renderSessionRow = (s) => {
          const isStopped = s.status === "stopped";
          const cardColor = s.color || "#3b82f6";
          const cliTagLabel = s.cliName || "cli";
          const shortcutHtml = s.index <= 5 ? '<span class="shortcut-hint">⌃' + s.index + '</span>' : "";
          const card = document.createElement("div");
          card.className =
            "session-card" +
            (s.id === msg.activeSessionId ? " active" : "") +
            (isStopped ? " stopped" : "");
          card.title =
            s.title +
            " (" +
            cliTagLabel +
            ") · " +
            s.cwd +
            (isStopped ? " · Click to resume" : " · Double-click title to rename");

          const swatchesHtml = COLOR_PALETTE.map(
            (c) =>
              '<span class="color-swatch" data-color="' +
              c +
              '" style="background:' +
              c +
              ';"></span>'
          ).join("");

          card.innerHTML =
            '<div class="session-card-main">' +
              '<span class="status-led led-' + s.status + '"></span>' +
              '<span class="s-title"></span>' +
              '<span class="cli-meta act-color" title="CLI: ' + cliTagLabel + ' (Click to change color)">' +
                '<span class="color-dot" style="background:' + cardColor + ';"></span>' +
                '<span>' + cliTagLabel + '</span>' +
              '</span>' +
              stateBadgeHtml(s.status) +
              shortcutHtml +
              '<div class="row-actions">' +
                '<button class="icon-action act-handoff" title="1-Click Handoff to another chat">' + ICONS.handoff + '</button>' +
                '<button class="icon-action act-pin" title="' + (s.pinned ? "Unpin" : "Pin") + '">' + ICONS.pin + '</button>' +
                '<button class="icon-action act-palette" title="Color">' + ICONS.color + '</button>' +
                '<button class="icon-action act-rename" title="Rename">' + ICONS.edit + '</button>' +
                '<button class="icon-action act-send" title="Send @file:line">' + ICONS.at + '</button>' +
                '<button class="icon-action danger act-delete" title="Close & remove">' + ICONS.close + '</button>' +
              '</div>' +
            '</div>' +
            '<div class="color-palette-row">' +
              '<span style="font-size:10px;color:var(--muted);">Color:</span>' +
              swatchesHtml +
            '</div>';

          card.querySelector(".s-title").textContent = s.title;

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

          const paletteRow = card.querySelector(".color-palette-row");
          const togglePalette = (e) => {
            e.stopPropagation();
            paletteRow.classList.toggle("open");
          };
          card.querySelector(".act-color").addEventListener("click", togglePalette);
          card.querySelector(".act-palette").addEventListener("click", togglePalette);

          card.querySelectorAll(".color-swatch").forEach((sw) => {
            sw.addEventListener("click", (e) => {
              e.stopPropagation();
              const chosen = sw.getAttribute("data-color");
              vscode.postMessage({
                type: "setSessionColor",
                id: s.id,
                color: chosen,
              });
            });
          });

          card.querySelector(".act-handoff").addEventListener("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "handoffSession", id: s.id });
          });
          card.querySelector(".act-pin").addEventListener("click", (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "togglePinSession", id: s.id });
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
          return card;
        };

        const pinnedSessions = msg.sessions.filter((s) => s.pinned);
        const regularSessions = msg.sessions.filter((s) => !s.pinned);

        if (pinnedSessions.length > 0) {
          const pinHeader = document.createElement("div");
          pinHeader.className = "section-header";
          pinHeader.innerHTML =
            '<span class="section-header-left">' + ICONS.pin + '<span>Pinned</span></span>' +
            '<span class="section-count">' + pinnedSessions.length + '</span>';
          sessionList.appendChild(pinHeader);

          pinnedSessions.forEach((s) => sessionList.appendChild(renderSessionRow(s)));

          if (regularSessions.length > 0) {
            const divider = document.createElement("div");
            divider.className = "section-divider";
            sessionList.appendChild(divider);
          }
        }

        // Group & sort unpinned conversations by Project / Folder Name (current workspace first, then A-Z)
        if (regularSessions.length > 0) {
          const currentFolderLower = (msg.folderName || "").toLowerCase();
          const byProject = new Map();
          regularSessions.forEach((s) => {
            const proj = s.folderName || "Workspace";
            if (!byProject.has(proj)) byProject.set(proj, []);
            byProject.get(proj).push(s);
          });

          const sortedProjects = Array.from(byProject.keys()).sort((a, b) => {
            const aCur = a.toLowerCase() === currentFolderLower;
            const bCur = b.toLowerCase() === currentFolderLower;
            if (aCur && !bCur) return -1;
            if (!aCur && bCur) return 1;
            return a.localeCompare(b);
          });

          sortedProjects.forEach((projName) => {
            const groupItems = byProject.get(projName);
            const hdr = document.createElement("div");
            hdr.className = "section-header";
            hdr.innerHTML =
              '<span class="section-header-left">' + ICONS.folder + '<span></span></span>' +
              '<span class="section-count">' + groupItems.length + '</span>';
            hdr.querySelector(".section-header-left span").textContent = projName;
            sessionList.appendChild(hdr);

            groupItems.forEach((s) => sessionList.appendChild(renderSessionRow(s)));
          });
        }
      }

      // Render MCP Servers
      const mcps = msg.mcpServers || [];
      mcpCount.textContent = String(mcps.length);
      mcpDrawer.innerHTML = "";
      if (mcps.length === 0) {
        mcpDrawer.innerHTML = '<div style="color:var(--muted);text-align:center;padding:8px 0;font-size:11px;">No MCP servers detected</div>';
      } else {
        mcps.forEach((m) => {
          const r = document.createElement("div");
          r.className = "item-row";
          r.title = m.source + " · " + m.detail;
          const ledCls = m.status === "connected" ? "led-working" : m.status === "configured" ? "led-idle" : "led-needs-input";
          const pillCls = m.status === "connected" ? "mcp-connected" : m.status === "configured" ? "mcp-configured" : "mcp-error";
          const pillText = m.status === "connected" ? (m.toolCount + " tools") : m.status;
          r.innerHTML =
            '<span class="status-led ' + ledCls + '"></span>' +
            '<span class="item-title"></span>' +
            '<span class="scope-pill ' + pillCls + '">' + pillText + '</span>';
          r.querySelector(".item-title").textContent = m.name;
          mcpDrawer.appendChild(r);
        });
      }

      // Render Skills & Subagents
      const skills = msg.skillsAndAgents || [];
      skillsCount.textContent = String(skills.length);
      skillsDrawer.innerHTML = "";
      if (skills.length === 0) {
        skillsDrawer.innerHTML = '<div style="color:var(--muted);text-align:center;padding:8px 0;font-size:11px;">No skills detected</div>';
      } else {
        skills.forEach((sk) => {
          const r = document.createElement("div");
          r.className = "item-row";
          r.title = sk.description;
          r.innerHTML =
            '<span class="scope-pill">' + (sk.kind === "agent" ? "agent" : sk.scope.toLowerCase()) + '</span>' +
            '<span class="item-title"></span>' +
            (sk.filePath ? '<button class="icon-action sk-open" title="Open SKILL.md">' + ICONS.ext + '</button>' : '') +
            '<button class="icon-action sk-use" title="Insert into active agent">' + ICONS.enter + '</button>';
          r.querySelector(".item-title").textContent = sk.name;
          const openBtn = r.querySelector(".sk-open");
          if (openBtn) {
            openBtn.addEventListener("click", () => {
              vscode.postMessage({ type: "openSkillFile", filePath: sk.filePath });
            });
          }
          r.querySelector(".sk-use").addEventListener("click", () => {
            vscode.postMessage({ type: "useSkillOrAgent", name: sk.name, kind: sk.kind });
          });
          skillsDrawer.appendChild(r);
        });
      }

      // Render Automated Scheduled Jobs
      const jobs = msg.scheduledJobs || [];
      jobsCount.textContent = String(jobs.length);
      jobsDrawer.innerHTML = "";

      const addJobBtn = document.createElement("button");
      addJobBtn.className = "drawer-action-btn";
      addJobBtn.innerHTML = ICONS.plus + '<span>New Scheduled Job</span>';
      addJobBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "createScheduledJob" });
      });
      jobsDrawer.appendChild(addJobBtn);

      if (jobs.length === 0) {
        const emptyEl = document.createElement("div");
        emptyEl.style.cssText = "color:var(--muted);text-align:center;padding:6px 0;font-size:10.5px;";
        emptyEl.textContent = "No scheduled jobs yet — runs while IDE is open";
        jobsDrawer.appendChild(emptyEl);
      } else {
        jobs.forEach((j) => {
          const r = document.createElement("div");
          r.className = "item-row";
          r.title =
            "CLI: " +
            j.cliName +
            " · Schedule: " +
            j.scheduleLabel +
            " · Next: " +
            j.nextRunText +
            " · Last: " +
            j.lastRunText +
            "\\nPrompt: " +
            j.prompt;
          r.innerHTML =
            '<span class="status-led ' + (j.enabled ? "led-working" : "led-stopped") + '"></span>' +
            '<span class="item-title"></span>' +
            '<span class="scope-pill">' + j.cliName + ' · ' + j.scheduleLabel + '</span>' +
            '<button class="icon-action job-run" title="Run now">' + ICONS.play + '</button>' +
            '<button class="icon-action job-toggle" title="' + (j.enabled ? "Pause" : "Resume") + '">' + (j.enabled ? ICONS.pause : ICONS.play) + '</button>' +
            '<button class="icon-action danger job-del" title="Delete">' + ICONS.close + '</button>';
          r.querySelector(".item-title").textContent = j.name;
          r.querySelector(".job-run").addEventListener("click", () => {
            vscode.postMessage({ type: "runScheduledJobNow", id: j.id });
          });
          r.querySelector(".job-toggle").addEventListener("click", () => {
            vscode.postMessage({ type: "toggleScheduledJob", id: j.id });
          });
          r.querySelector(".job-del").addEventListener("click", () => {
            vscode.postMessage({ type: "deleteScheduledJob", id: j.id });
          });
          jobsDrawer.appendChild(r);
        });
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

type TimelineTreeNode =
  | { kind: "question"; entry: ChatTimelineEntry }
  | { kind: "reply"; text: string }
  | { kind: "empty"; message: string };

class ChatTimelineTreeProvider
  implements vscode.TreeDataProvider<TimelineTreeNode>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<TimelineTreeNode | undefined | void>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _treeView?: vscode.TreeView<TimelineTreeNode>;

  constructor(private readonly _cockpit: AgentCockpitProvider) {}

  public bindTreeView(tv: vscode.TreeView<TimelineTreeNode>) {
    this._treeView = tv;
    this._updateHeader();
  }

  public refresh() {
    this._updateHeader();
    this._onDidChangeTreeData.fire();
  }

  private _updateHeader() {
    if (!this._treeView) return;
    const info = this._cockpit.getActiveSessionTimelineInfo();
    this._treeView.description = info.sessionTitle
      ? `${info.sessionTitle} (${info.entries.length})`
      : undefined;
  }

  public getTreeItem(element: TimelineTreeNode): vscode.TreeItem {
    if (element.kind === "empty") {
      const item = new vscode.TreeItem(
        element.message,
        vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }

    if (element.kind === "reply") {
      const item = new vscode.TreeItem(
        element.text,
        vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon("sparkle");
      item.tooltip = element.text;
      return item;
    }

    const { entry } = element;
    const hasReply = Boolean(entry.replyPreview);
    const item = new vscode.TreeItem(
      `#${entry.turn}  ${entry.question}`,
      hasReply
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.description = entry.timeLabel || "";
    item.tooltip = new vscode.MarkdownString(
      `**#${entry.turn}**${entry.timeLabel ? ` · ${entry.timeLabel}` : ""}\n\n${entry.fullQuestion}` +
        (entry.replyPreview ? `\n\n---\n*AI:* ${entry.replyPreview}` : "")
    );
    item.iconPath = new vscode.ThemeIcon("comment-discussion");
    item.contextValue = "timelineQuestion";
    return item;
  }

  public getChildren(element?: TimelineTreeNode): TimelineTreeNode[] {
    if (!element) {
      const info = this._cockpit.getActiveSessionTimelineInfo();
      if (info.entries.length === 0) {
        return [
          {
            kind: "empty",
            message: info.sessionTitle
              ? "No user questions recorded yet"
              : "Select a chat session to view timeline",
          },
        ];
      }
      return info.entries.map((entry) => ({ kind: "question", entry }));
    }

    if (element.kind === "question" && element.entry.replyPreview) {
      return [{ kind: "reply", text: element.entry.replyPreview }];
    }

    return [];
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

  const timelineProvider = new ChatTimelineTreeProvider(provider);
  const timelineTreeView = vscode.window.createTreeView(
    "agentCockpit.chatTimeline",
    {
      treeDataProvider: timelineProvider,
      showCollapseAll: true,
    }
  );
  timelineProvider.bindTreeView(timelineTreeView);
  provider.setOnStateChanged(() => timelineProvider.refresh());
  context.subscriptions.push(timelineTreeView);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentCockpit.copyTimelineQuestion",
      async (node?: TimelineTreeNode) => {
        if (node && node.kind === "question") {
          await vscode.env.clipboard.writeText(node.entry.fullQuestion);
          vscode.window.setStatusBarMessage(
            `Copied question #${node.entry.turn} to clipboard`,
            2500
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentCockpit.reaskTimelineQuestion",
      async (node?: TimelineTreeNode) => {
        if (node && node.kind === "question") {
          await provider.sendTextToActiveAgent(node.entry.fullQuestion, false);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentCockpit.newSession", async () => {
      const installed = getInstalledPresets();
      const picked = await vscode.window.showQuickPick(
        [
          ...installed.map((p) => ({
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
        { placeHolder: "Launch Installed CLI Agent" }
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
    vscode.commands.registerCommand(
      "agentCockpit.runHighlightedCommand",
      () => {
        void provider.handleHighlightedTextAction("runInShell");
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "agentCockpit.sendHighlightedToTerminal",
      () => {
        void provider.handleHighlightedTextAction("sendToTerminal");
      }
    )
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
