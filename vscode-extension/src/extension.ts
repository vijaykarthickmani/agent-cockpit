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

const STORAGE_KEY = "agentCockpit.retainedSessions.v3";
const DISMISSED_KEY = "agentCockpit.dismissedCliIds.v1";
const SOUND_PREF_KEY = "agentCockpit.soundEnabled.v1";
const LAST_CLI_KEY = "agentCockpit.lastUsedCliId.v1";

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
  private _pollTimer: NodeJS.Timeout;

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
        if (isTerminalAlive(match.terminal)) {
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

    this._view.webview.postMessage({
      type: "state",
      currentCwd: this._currentCwd,
      folderName: path.basename(this._currentCwd) || this._currentCwd,
      defaultLocation: this._defaultLocation,
      topTabsHidden: showTabs === "none",
      soundEnabled: this._soundEnabled,
      lastUsedCliId: validLastCliId,
      activeSessionId: this._activeSessionId,
      presets: installedPresets,
      gitBranch: gitInfo.branch,
      gitChanges: gitInfo.changes,
      mcpServers,
      skillsAndAgents,
      aiSnippets: activeSnippets,
      handoffContent,
      sessions: this._sessions.map((s, idx) => ({
        id: s.id,
        cliSessionId: s.cliSessionId,
        index: idx + 1,
        title: s.title,
        badge: s.badge,
        color: s.color,
        pinned: Boolean(s.pinned),
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
      color: var(--md-primary);
      border-color: var(--md-primary);
      background: var(--md-primary-bg);
    }

    /* Material Split Launch Bar: 1-Click Last Used CLI + Installed CLI Dropdown */
    .launch-bar {
      display: flex;
      align-items: stretch;
      gap: 6px;
    }
    .launch-primary-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      background: var(--md-primary);
      color: #ffffff;
      border: 1px solid var(--md-primary);
      border-radius: var(--md-radius);
      box-shadow: var(--md-shadow-sm);
      padding: 8px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.14s ease;
    }
    .launch-primary-btn:hover {
      background: #2563eb;
      box-shadow: var(--md-shadow-md);
      transform: translateY(-1px);
    }
    .launch-primary-btn:active {
      transform: translateY(0);
    }
    .cli-select {
      width: 128px;
      background: var(--md-surface);
      color: var(--md-fg);
      border: 1px solid var(--md-border);
      border-radius: var(--md-radius);
      box-shadow: var(--md-shadow-sm);
      padding: 6px 8px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      outline: none;
      transition: border-color 0.14s, box-shadow 0.14s;
    }
    .cli-select:hover, .cli-select:focus {
      border-color: var(--md-primary);
      box-shadow: var(--md-shadow-md);
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
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 9px;
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      border-radius: var(--md-radius);
      box-shadow: var(--md-shadow-sm);
      cursor: pointer;
      transition: all 0.14s ease;
    }
    .session-card-main {
      display: flex;
      align-items: center;
      gap: 7px;
      width: 100%;
    }
    .session-card:hover {
      border-color: var(--md-border-strong);
      background: var(--md-surface-hover);
      box-shadow: var(--md-shadow-md);
      transform: translateY(-1px);
    }
    .session-card.active {
      border-color: var(--md-primary);
      background: var(--md-primary-bg);
    }
    .pin-marker {
      font-size: 10px;
      color: #f59e0b;
      flex-shrink: 0;
    }
    .color-palette-row {
      display: none;
      align-items: center;
      gap: 6px;
      padding-top: 4px;
      border-top: 1px dashed var(--md-border);
    }
    .color-palette-row.open {
      display: flex;
    }
    .color-swatch {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.7);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
      cursor: pointer;
      transition: transform 0.12s;
    }
    .color-swatch:hover {
      transform: scale(1.22);
    }
    .snippet-card {
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 6px 7px;
      border-radius: 6px;
      border: 1px solid var(--md-border);
      background: var(--bg-shell);
    }
    .snippet-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
    }
    .snippet-code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10.5px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 64px;
      overflow-y: auto;
      padding: 4px 6px;
      border-radius: 4px;
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      color: var(--md-fg);
    }
    .snippet-actions {
      display: flex;
      gap: 4px;
    }
    .snip-btn {
      flex: 1;
      padding: 3px 5px;
      font-size: 10px;
      font-weight: 600;
      border-radius: 4px;
      border: 1px solid var(--md-border);
      background: var(--md-surface);
      color: var(--md-fg);
      cursor: pointer;
      text-align: center;
    }
    .snip-btn:hover {
      border-color: var(--md-primary);
      color: var(--md-primary);
    }
    .snip-btn.run {
      background: var(--md-primary);
      border-color: var(--md-primary);
      color: #ffffff;
    }

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
      background: rgba(148, 163, 184, 0.14);
      border: 1px solid var(--md-border);
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
      color: var(--st-working);
      background: rgba(34, 197, 94, 0.15);
    }
    .tag-needs-input {
      color: var(--st-needs-input);
      background: rgba(245, 158, 11, 0.18);
    }
    .tag-idle {
      color: var(--md-muted);
      background: rgba(148, 163, 184, 0.14);
    }
    .tag-stopped {
      color: var(--md-primary);
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
      color: var(--md-primary);
      border-color: var(--md-primary);
      background: var(--md-primary-bg);
    }
    .icon-action.danger:hover {
      color: #ef4444;
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

    /* Footer Prompt & 5-Tab Material Action Bar */
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
      grid-template-columns: repeat(5, 1fr);
      gap: 4px;
    }
    .footer-btn {
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      border-radius: 6px;
      box-shadow: var(--md-shadow-sm);
      color: var(--md-fg);
      padding: 5px 3px;
      font-size: 10.2px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      white-space: nowrap;
      transition: all 0.14s ease;
    }
    .footer-btn:hover {
      border-color: var(--md-primary);
      background: var(--md-surface-hover);
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
      max-height: 175px;
      overflow-y: auto;
      background: var(--md-surface);
      border: 1px solid var(--md-border);
      border-radius: var(--md-radius);
      padding: 7px;
      box-shadow: var(--md-shadow-sm);
    }
    .drawer-pane.open { display: flex; }

    /* MCP & Skills Drawer Rows */
    .item-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      padding: 5px 6px;
      border-radius: 6px;
      border: 1px solid var(--md-border);
      background: var(--bg-shell);
    }
    .item-title {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }
    .scope-pill {
      font-size: 9.5px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(148, 163, 184, 0.15);
      color: var(--md-muted);
      white-space: nowrap;
    }
    .mcp-connected { color: var(--st-working); background: rgba(34, 197, 94, 0.14); }
    .mcp-configured { color: var(--st-idle); background: rgba(56, 189, 248, 0.14); }
    .mcp-error { color: #ef4444; background: rgba(239, 68, 68, 0.15); }
    .git-st { color: var(--st-needs-input); font-family: monospace; font-weight: 700; font-size: 10.5px; width: 14px; }
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
    <button id="sound-toggle" class="chip-btn active" title="Toggle AI response completion notification sound">
      🔔
    </button>
    <button id="zen-tabs-toggle" class="chip-btn" title="Hide/Show redundant top Editor Tab bar (+35px terminal height)">
      Zen
    </button>
    <button id="wt-toggle" class="chip-btn" title="Isolate next session in a new Git Worktree">
      WT
    </button>
  </div>

  <!-- Material 1-Click Launch Last Used CLI + Installed CLI Dropdown -->
  <div class="launch-bar">
    <button id="launch-last-btn" class="launch-primary-btn" title="1-click launch your last used CLI agent">
      <span id="launch-last-dot" class="agent-dot" style="background:rgba(255,255,255,0.22);">✦</span>
      <span id="launch-last-label">Launch AGY</span>
    </button>
    <select id="cli-dropdown" class="cli-select" title="Select from installed CLIs on this PC"></select>
  </div>

  <div id="custom-drawer" class="custom-drawer">
    <input id="custom-cmd" type="text" placeholder="Command (e.g. agy, claude, aider)" />
    <button id="custom-go" class="send-btn">Run</button>
  </div>

  <!-- Material Session Cards -->
  <div id="session-list" class="sessions-container"></div>

  <!-- Material Footer -->
  <div class="footer-bar">
    <div id="cmds-drawer" class="drawer-pane"></div>
    <div id="git-drawer" class="drawer-pane"></div>
    <div id="mcp-drawer" class="drawer-pane"></div>
    <div id="skills-drawer" class="drawer-pane"></div>
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
      <button id="tab-cmds" class="footer-btn" title="Copy AI responses, code blocks, or run AI terminal commands">Cmds (<span id="cmds-count">0</span>)</button>
      <button id="tab-mcp" class="footer-btn" title="View MCP servers & live status">MCP (<span id="mcp-count">0</span>)</button>
      <button id="tab-skills" class="footer-btn" title="View available Skills & Subagents">Skills (<span id="skills-count">0</span>)</button>
      <button id="tab-git" class="footer-btn" title="View uncommitted Git changes">Git (<span id="git-count">0</span>)</button>
      <button id="tab-notes" class="footer-btn" title="Shared handoff notes & @file:line">Notes</button>
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

    // Web Audio API harmonic chime synthesizer
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
        // Fallback handled by host OS sound
      }
    }

    const cwdPill = document.getElementById("cwd-pill");
    const cwdName = document.getElementById("cwd-name");
    const branchTag = document.getElementById("branch-tag");
    const soundToggle = document.getElementById("sound-toggle");
    const zenTabsToggle = document.getElementById("zen-tabs-toggle");
    const wtToggle = document.getElementById("wt-toggle");
    const launchLastBtn = document.getElementById("launch-last-btn");
    const launchLastDot = document.getElementById("launch-last-dot");
    const launchLastLabel = document.getElementById("launch-last-label");
    const cliDropdown = document.getElementById("cli-dropdown");
    const customDrawer = document.getElementById("custom-drawer");
    const customCmd = document.getElementById("custom-cmd");
    const customGo = document.getElementById("custom-go");
    const sessionList = document.getElementById("session-list");
    const quickPromptInput = document.getElementById("quick-prompt-input");
    const quickPromptBtn = document.getElementById("quick-prompt-btn");

    const cmdsDrawer = document.getElementById("cmds-drawer");
    const gitDrawer = document.getElementById("git-drawer");
    const mcpDrawer = document.getElementById("mcp-drawer");
    const skillsDrawer = document.getElementById("skills-drawer");
    const notesDrawer = document.getElementById("notes-drawer");

    const cmdsCount = document.getElementById("cmds-count");
    const gitCount = document.getElementById("git-count");
    const mcpCount = document.getElementById("mcp-count");
    const skillsCount = document.getElementById("skills-count");
    const handoffText = document.getElementById("handoff-text");

    const tabCmds = document.getElementById("tab-cmds");
    const tabMcp = document.getElementById("tab-mcp");
    const tabSkills = document.getElementById("tab-skills");
    const tabGit = document.getElementById("tab-git");
    const tabNotes = document.getElementById("tab-notes");

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
      cmdsDrawer.classList.toggle("open", state.activeFooter === "cmds");
      mcpDrawer.classList.toggle("open", state.activeFooter === "mcp");
      skillsDrawer.classList.toggle("open", state.activeFooter === "skills");
      gitDrawer.classList.toggle("open", state.activeFooter === "git");
      notesDrawer.classList.toggle("open", state.activeFooter === "notes");

      tabCmds.classList.toggle("active", state.activeFooter === "cmds");
      tabMcp.classList.toggle("active", state.activeFooter === "mcp");
      tabSkills.classList.toggle("active", state.activeFooter === "skills");
      tabGit.classList.toggle("active", state.activeFooter === "git");
      tabNotes.classList.toggle("active", state.activeFooter === "notes");

      if (
        state.activeFooter === "git" ||
        state.activeFooter === "mcp" ||
        state.activeFooter === "cmds"
      ) {
        vscode.postMessage({ type: "refreshGit" });
      }
    }

    tabCmds.addEventListener("click", () => setFooterDrawer("cmds"));
    tabMcp.addEventListener("click", () => setFooterDrawer("mcp"));
    tabSkills.addEventListener("click", () => setFooterDrawer("skills"));
    tabGit.addEventListener("click", () => setFooterDrawer("git"));
    tabNotes.addEventListener("click", () => setFooterDrawer("notes"));

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

    function submitQuickPrompt() {
      const val = quickPromptInput.value.trim();
      if (!val) return;
      quickPromptInput.value = "";
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

      soundToggle.textContent = msg.soundEnabled ? "🔔" : "🔕";
      soundToggle.classList.toggle("active", Boolean(msg.soundEnabled));
      zenTabsToggle.classList.toggle("active", Boolean(msg.topTabsHidden));

      state.presets = msg.presets || [];
      state.lastUsedCliId = msg.lastUsedCliId || (state.presets[0] && state.presets[0].id);

      const selectedPreset =
        state.presets.find((p) => p.id === state.lastUsedCliId) ||
        state.presets[0];

      if (selectedPreset) {
        launchLastDot.textContent = selectedPreset.badge;
        launchLastLabel.textContent = "Launch " + selectedPreset.label.split(" ")[0];
        launchLastBtn.title =
          "1-Click Launch " + selectedPreset.label + " (" + selectedPreset.command + ")";
      }

      cliDropdown.innerHTML = "";
      state.presets.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.badge + " " + p.label;
        if (p.id === state.lastUsedCliId) opt.selected = true;
        cliDropdown.appendChild(opt);
      });
      const customOpt = document.createElement("option");
      customOpt.value = "__custom__";
      customOpt.textContent = "+ Custom CLI…";
      cliDropdown.appendChild(customOpt);

      // Material Session Cards (with Pinning & Color Coding)
      sessionList.innerHTML = "";
      if (!msg.sessions || msg.sessions.length === 0) {
        sessionList.innerHTML = '<div class="empty-card">Click Launch above to start an agent session</div>';
      } else {
        msg.sessions.forEach((s) => {
          const isStopped = s.status === "stopped";
          const cardColor = s.color || "#3b82f6";
          const tagInfo = statusLabelFor(s.status, s.folderName);
          const shortcutBadge = s.index <= 5 ? '<span class="shortcut-pill">⌃' + s.index + '</span>' : '';
          const card = document.createElement("div");
          card.className =
            "session-card" +
            (s.id === msg.activeSessionId ? " active" : "") +
            (isStopped ? " stopped" : "");
          card.style.borderLeft = "4px solid " + cardColor;
          card.title = isStopped
            ? "Paused — Click to resume conversation (" + s.folderName + ")"
            : "Status: " + s.status + " · Folder: " + s.cwd + " · Double-click title to rename";

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
              '<span class="agent-dot act-color" title="Click to change color" style="background:' + cardColor + ';">' + s.badge + '</span>' +
              (s.pinned ? '<span class="pin-marker" title="Pinned">📌</span>' : '') +
              '<span class="s-title">' + s.title + '</span>' +
              '<span class="state-tag ' + tagInfo.cls + '">' + tagInfo.text + '</span>' +
              shortcutBadge +
              '<div class="row-actions">' +
                '<button class="icon-action act-pin" title="' + (s.pinned ? "Unpin session" : "Pin/Bookmark session") + '">📌</button>' +
                '<button class="icon-action act-palette" title="Color code session">🎨</button>' +
                '<button class="icon-action act-rename" title="Rename">✎</button>' +
                '<button class="icon-action act-send" title="Send @file:line">@</button>' +
                '<button class="icon-action danger act-delete" title="Remove session">✕</button>' +
              '</div>' +
            '</div>' +
            '<div class="color-palette-row">' +
              '<span style="font-size:10px;color:var(--md-muted);">Color:</span>' +
              swatchesHtml +
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
          sessionList.appendChild(card);
        });
      }

      // Render AI Generated Output, Code Blocks & Terminal Commands
      const snips = msg.aiSnippets || [];
      cmdsCount.textContent = String(snips.length);
      cmdsDrawer.innerHTML = "";
      if (snips.length === 0) {
        cmdsDrawer.innerHTML = '<div style="color:var(--md-muted);text-align:center;padding:6px 0;">AI responses & terminal commands will appear here for 1-click Copy or Run</div>';
      } else {
        snips.forEach((sn) => {
          const box = document.createElement("div");
          box.className = "snippet-card";
          const badgeText =
            sn.kind === "command"
              ? "⚡ Terminal Command"
              : sn.kind === "response"
              ? "💬 Latest AI Response"
              : "📄 Code (" + sn.language + ")";
          const preview = document.createElement("pre");
          preview.className = "snippet-code";
          preview.textContent = sn.content;

          const header = document.createElement("div");
          header.className = "snippet-header";
          header.innerHTML =
            '<span class="scope-pill">' + badgeText + '</span>' +
            '<span style="font-size:10px;color:var(--md-muted);">' + sn.sessionTitle + '</span>';

          const actions = document.createElement("div");
          actions.className = "snippet-actions";

          const copyBtn = document.createElement("button");
          copyBtn.className = "snip-btn";
          copyBtn.textContent = "📋 Copy";
          copyBtn.addEventListener("click", () => {
            vscode.postMessage({ type: "copyToClipboard", text: sn.content });
            copyBtn.textContent = "✓ Copied";
            setTimeout(() => { copyBtn.textContent = "📋 Copy"; }, 1400);
          });
          actions.appendChild(copyBtn);

          if (sn.kind === "command" || sn.kind === "code") {
            const sendTermBtn = document.createElement("button");
            sendTermBtn.className = "snip-btn";
            sendTermBtn.textContent = "⇥ To Terminal";
            sendTermBtn.title = "Insert into active terminal prompt without running yet";
            sendTermBtn.addEventListener("click", () => {
              vscode.postMessage({
                type: "sendCommandToTerminal",
                command: sn.content,
                execute: false,
              });
            });
            actions.appendChild(sendTermBtn);

            const runShellBtn = document.createElement("button");
            runShellBtn.className = "snip-btn run";
            runShellBtn.textContent = "▶ Run in Shell";
            runShellBtn.title = "Execute immediately in a PowerShell terminal tab";
            runShellBtn.addEventListener("click", () => {
              vscode.postMessage({
                type: "runCommandInShell",
                command: sn.content,
              });
            });
            actions.appendChild(runShellBtn);
          }

          box.appendChild(header);
          box.appendChild(preview);
          box.appendChild(actions);
          cmdsDrawer.appendChild(box);
        });
      }

      // Render MCP Servers & Status
      const mcps = msg.mcpServers || [];
      mcpCount.textContent = String(mcps.length);
      mcpDrawer.innerHTML = "";
      if (mcps.length === 0) {
        mcpDrawer.innerHTML = '<div style="color:var(--md-muted);text-align:center;padding:6px 0;">No MCP servers detected</div>';
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
            '<span class="item-title">' + m.name + '</span>' +
            '<span class="scope-pill ' + pillCls + '">' + pillText + '</span>';
          mcpDrawer.appendChild(r);
        });
      }

      // Render Skills & Subagents
      const skills = msg.skillsAndAgents || [];
      skillsCount.textContent = String(skills.length);
      skillsDrawer.innerHTML = "";
      if (skills.length === 0) {
        skillsDrawer.innerHTML = '<div style="color:var(--md-muted);text-align:center;padding:6px 0;">No skills detected</div>';
      } else {
        skills.forEach((sk) => {
          const r = document.createElement("div");
          r.className = "item-row";
          r.title = sk.description;
          r.innerHTML =
            '<span class="scope-pill">' + (sk.kind === "agent" ? "🤖 Agent" : "⚡ " + sk.scope) + '</span>' +
            '<span class="item-title">' + sk.name + '</span>' +
            (sk.filePath ? '<button class="icon-action sk-open" title="Open SKILL.md">↗</button>' : '') +
            '<button class="icon-action sk-use" title="Insert into active agent">↵</button>';
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

      // Render Git Changes
      const changes = msg.gitChanges || [];
      gitCount.textContent = String(changes.length);
      gitDrawer.innerHTML = "";
      if (changes.length === 0) {
        gitDrawer.innerHTML = '<div style="color:var(--md-muted);text-align:center;padding:6px 0;">Clean working tree</div>';
      } else {
        changes.forEach((c) => {
          const r = document.createElement("div");
          r.className = "item-row";
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
