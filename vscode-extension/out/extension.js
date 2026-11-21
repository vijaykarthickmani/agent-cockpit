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
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
const CANDIDATE_PRESETS = [
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
function isExecutableInstalled(command) {
    const lower = command.toLowerCase();
    if (lower === "powershell.exe" || lower === "powershell" || lower === "cmd.exe" || lower === "cmd") {
        return true;
    }
    const home = os.homedir();
    const searchDirs = (process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean);
    searchDirs.push(path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin"), path.join(home, ".gemini", "antigravity-cli", "bin"));
    if (process.env.APPDATA) {
        searchDirs.push(path.join(process.env.APPDATA, "npm"));
    }
    if (process.env.LOCALAPPDATA) {
        searchDirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "antigravity", "bin"), path.join(process.env.LOCALAPPDATA, "Programs", "antigravity"), path.join(process.env.LOCALAPPDATA, "Programs", "Antigravity IDE", "bin"));
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
            }
            catch {
                // ignore
            }
        }
    }
    return false;
}
function getInstalledPresets() {
    const installed = CANDIDATE_PRESETS.filter((p) => isExecutableInstalled(p.command));
    return installed.length > 0 ? installed : CANDIDATE_PRESETS.slice(0, 2);
}
const STORAGE_KEY = "agentCockpit.retainedSessions.v3";
const DISMISSED_KEY = "agentCockpit.dismissedCliIds.v1";
const SOUND_PREF_KEY = "agentCockpit.soundEnabled.v1";
const LAST_CLI_KEY = "agentCockpit.lastUsedCliId.v1";
const STORAGE_JOBS_KEY = "agentCockpit.scheduledJobs.v1";
function computeNextRunAt(job, fromMs = Date.now()) {
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
function formatScheduleLabel(job) {
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
function isTerminalAlive(term) {
    if (!term)
        return false;
    if (term.exitStatus !== undefined)
        return false;
    return vscode.window.terminals.includes(term);
}
function formatAtFileRef(relPath, lineRange) {
    const normalized = relPath.replace(/\\/g, "/");
    const suffix = lineRange ? `:${lineRange}` : "";
    if (/\s/.test(normalized)) {
        return `@"${normalized}${suffix}" `;
    }
    return `@${normalized}${suffix} `;
}
function claudeProjectSlug(cwd) {
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
function extractSnippetsFromMarkdown(markdownText, sessionTitle) {
    const results = [];
    if (!markdownText || !markdownText.trim())
        return results;
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
    let match;
    while ((match = fenceRegex.exec(markdownText)) !== null) {
        const lang = (match[1] || "").trim().toLowerCase();
        const code = (match[2] || "").trim();
        if (!code)
            continue;
        const lineCount = code.split(/\r?\n/).length;
        const looksLikeCommand = SHELL_LANGS.has(lang) ||
            (!lang &&
                lineCount <= 4 &&
                /^(npm|npx|pnpm|yarn|git|cargo|rustc|rustup|winget|python|pip|uv|pytest|code|agy|claude|codex|gemini|cd|dir|ls|mkdir|docker|kubectl|gcloud|bq)\b/m.test(code));
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
function discoverMcpServers(cwd) {
    const map = new Map();
    const home = os.homedir();
    // 1. Scan active Antigravity MCP schema directories (shows actually loaded tools!)
    const mcpCacheRoots = [
        path.join(home, ".gemini", "antigravity", "mcp"),
        path.join(home, ".gemini", "antigravity-cli", "mcp"),
    ];
    for (const root of mcpCacheRoots) {
        if (!fs.existsSync(root))
            continue;
        try {
            for (const dirName of fs.readdirSync(root)) {
                const fullDir = path.join(root, dirName);
                if (!fs.statSync(fullDir).isDirectory())
                    continue;
                const toolFiles = fs
                    .readdirSync(fullDir)
                    .filter((f) => f.endsWith(".json") && f !== "mcp_config.json");
                const tools = toolFiles.map((f) => path.basename(f, ".json"));
                const parts = dirName.split("_");
                const source = parts.length > 1 ? parts[0] : "antigravity";
                const shortName = parts.length > 1 ? parts.slice(1).join("_") : dirName;
                const existing = map.get(shortName);
                if (!existing || tools.length > existing.toolCount) {
                    map.set(shortName, {
                        id: dirName,
                        name: shortName,
                        source,
                        status: tools.length > 0 ? "connected" : "configured",
                        toolCount: tools.length,
                        tools,
                        detail: tools.length > 0
                            ? `${tools.length} tools active (${tools.slice(0, 4).join(", ")}${tools.length > 4 ? "…" : ""})`
                            : "Registered in Antigravity MCP cache",
                    });
                }
            }
        }
        catch {
            // ignore
        }
    }
    // 2. Scan workspace & global plugin mcp_config.json / mcp.json files
    const configCandidates = [];
    const scanPluginRoot = (pluginsDir, prefix) => {
        if (!fs.existsSync(pluginsDir))
            return;
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
        }
        catch {
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
                const def = srvDef;
                let status = "configured";
                let detail = def.command
                    ? `${def.command} ${(def.args || []).join(" ")}`
                    : def.url || "Configured";
                // Check for unreplaced placeholders or missing local script file
                if (/\$\{?GCP_REGION|\$\{?region/i.test(detail)) {
                    status = "error";
                    detail = "Unconfigured region placeholder (${REGION})";
                }
                else if (def.args &&
                    def.args.length > 0 &&
                    /\.(mjs|js|py)$/i.test(def.args[0])) {
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
                }
                else {
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
        }
        catch {
            // ignore
        }
    }
    return Array.from(map.values()).sort((a, b) => {
        const score = (s) => s.status === "connected" ? 0 : s.status === "configured" ? 1 : 2;
        return score(a) - score(b) || a.name.localeCompare(b.name);
    });
}
/**
 * Parse YAML frontmatter name & description from a SKILL.md file
 */
function parseSkillMarkdown(filePath, fallbackName) {
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
    }
    catch {
        // ignore
    }
    return { name: fallbackName, description: "Skill instructions" };
}
/**
 * Discover all available Skills and Subagents across Workspace, Plugins, and Built-ins
 */
function discoverSkillsAndAgents(cwd) {
    const seen = new Set();
    const items = [];
    const home = os.homedir();
    // Built-in Subagents
    const builtinAgents = [
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
    const scanSkillsDir = (skillsRoot, scope) => {
        if (!fs.existsSync(skillsRoot))
            return;
        try {
            for (const entry of fs.readdirSync(skillsRoot)) {
                const skillMd = path.join(skillsRoot, entry, "SKILL.md");
                if (!fs.existsSync(skillMd))
                    continue;
                const parsed = parseSkillMarkdown(skillMd, entry);
                const key = `skill:${parsed.name.toLowerCase()}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                items.push({
                    name: parsed.name,
                    kind: "skill",
                    scope,
                    description: parsed.description,
                    filePath: skillMd,
                });
            }
        }
        catch {
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
            }
            catch {
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
        }
        catch {
            // ignore
        }
    }
    // 3. Built-in skills (~/.gemini/antigravity/builtin/skills)
    scanSkillsDir(path.join(home, ".gemini", "antigravity", "builtin", "skills"), "Built-in");
    return items;
}
function discoverAgySessions(defaultCwd) {
    const results = [];
    const home = os.homedir();
    const agyRoot = path.join(home, ".gemini", "antigravity-cli");
    const annotationsDir = path.join(agyRoot, "annotations");
    const brainDir = path.join(agyRoot, "brain");
    const ids = new Set();
    if (fs.existsSync(annotationsDir)) {
        try {
            for (const f of fs.readdirSync(annotationsDir)) {
                if (f.endsWith(".pbtxt")) {
                    ids.add(path.basename(f, ".pbtxt"));
                }
            }
        }
        catch {
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
        }
        catch {
            // ignore
        }
    }
    const now = Date.now();
    for (const convId of ids) {
        let title = null;
        let mtimeMs = 0;
        let runtimeHint = "idle";
        let lastUserTurnId;
        let isTurnComplete = false;
        const recentAssistantTexts = [];
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
            }
            catch {
                // ignore
            }
        }
        const transcriptPath = path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
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
                            const reqMatch = obj.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
                            const candidate = (reqMatch ? reqMatch[1] : obj.content).trim();
                            if (candidate) {
                                title = candidate.replace(/\s+/g, " ").slice(0, 32);
                            }
                        }
                        if (obj.source === "USER_EXPLICIT" || obj.type === "USER_INPUT") {
                            lastUserTurnId = `${convId}:u:${obj.step_index ?? i}`;
                        }
                        else if (obj.source === "MODEL" &&
                            typeof obj.content === "string" &&
                            obj.content.trim()) {
                            recentAssistantTexts.push(obj.content.trim());
                        }
                    }
                    catch {
                        // ignore
                    }
                }
                if (lines.length > 0) {
                    const lastObj = JSON.parse(lines[lines.length - 1]);
                    const isFinalModelResponse = lastObj.source === "MODEL" &&
                        lastObj.type === "PLANNER_RESPONSE" &&
                        lastObj.status === "DONE" &&
                        !lastObj.tool_calls;
                    // Only mark complete after transcript has been quiet for >= 4.5s after a final response
                    if (isFinalModelResponse && quietMs >= 4500) {
                        isTurnComplete = true;
                        if (typeof lastObj.content === "string" &&
                            /\?\s*$|\[y\/n\]|approve|allow/i.test(lastObj.content.slice(-200))) {
                            runtimeHint = "needs-input";
                        }
                        else {
                            runtimeHint = "idle";
                        }
                    }
                    else if (quietMs < 8000) {
                        runtimeHint = "working";
                    }
                }
            }
            catch {
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
                lastAssistantText: recentAssistantTexts[recentAssistantTexts.length - 1],
                snippets: extractSnippetsFromMarkdown(combinedMd, title),
                agentType: "agy",
            });
        }
    }
    return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function parseClaudeJsonlMeta(filePath) {
    const sessionId = path.basename(filePath, ".jsonl");
    let customTitle = null;
    let firstUserPrompt = null;
    let detectedCwd = null;
    let lastUserTurnId;
    let isTurnComplete = false;
    let lastText = "";
    let hasPendingToolUse = false;
    const recentAssistantTexts = [];
    try {
        const stat = fs.statSync(filePath);
        const quietMs = Date.now() - stat.mtimeMs;
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
            if (!line.trim())
                continue;
            try {
                const obj = JSON.parse(line);
                if (!detectedCwd && typeof obj.cwd === "string") {
                    detectedCwd = obj.cwd;
                }
                if (obj.type === "custom-title" &&
                    typeof obj.customTitle === "string" &&
                    obj.customTitle.trim()) {
                    customTitle = obj.customTitle.trim();
                }
                else if (obj.type === "summary" &&
                    typeof obj.summary === "string" &&
                    obj.summary.trim()) {
                    customTitle = obj.summary.trim();
                }
                else if (typeof obj.sessionName === "string" &&
                    obj.sessionName.trim()) {
                    customTitle = obj.sessionName.trim();
                }
                else if (obj.type === "user" && obj.message?.role === "user") {
                    // Only count actual human typed prompts (not tool_result messages) as a new user turn
                    const rawContent = obj.message.content;
                    const isToolResult = Array.isArray(rawContent) &&
                        rawContent.some((p) => p && p.type === "tool_result");
                    if (!isToolResult) {
                        lastUserTurnId = `${sessionId}:u:${obj.uuid || obj.timestamp || ""}`;
                        isTurnComplete = false;
                        hasPendingToolUse = false;
                        if (!firstUserPrompt) {
                            if (typeof rawContent === "string" && rawContent.trim()) {
                                firstUserPrompt = rawContent.trim();
                            }
                            else if (Array.isArray(rawContent)) {
                                const textPart = rawContent.find((p) => p && p.type === "text" && typeof p.text === "string");
                                if (textPart && textPart.text.trim()) {
                                    firstUserPrompt = textPart.text.trim();
                                }
                            }
                        }
                    }
                }
                else if (obj.type === "assistant" &&
                    obj.message?.role === "assistant") {
                    const rawContent = obj.message.content;
                    if (Array.isArray(rawContent)) {
                        const toolUse = rawContent.find((p) => p && p.type === "tool_use");
                        const textPart = rawContent.find((p) => p && p.type === "text" && typeof p.text === "string");
                        hasPendingToolUse = Boolean(toolUse);
                        lastText = textPart?.text || "";
                        if (lastText.trim()) {
                            recentAssistantTexts.push(lastText.trim());
                        }
                        if (!toolUse && obj.message.stop_reason === "end_turn") {
                            isTurnComplete = true;
                        }
                    }
                }
                else if ((obj.type === "system" && obj.subtype === "turn_duration") ||
                    obj.type === "last-prompt") {
                    // Claude writes turn_duration and last-prompt only when the entire agentic loop finishes!
                    isTurnComplete = true;
                    hasPendingToolUse = false;
                }
            }
            catch {
                // skip
            }
        }
        let runtimeHint = "idle";
        if (!isTurnComplete && quietMs < 12000) {
            runtimeHint =
                hasPendingToolUse && quietMs >= 3500 ? "needs-input" : "working";
        }
        else if (/\?\s*$|\[y\/n\]|approve|allow/i.test(lastText.slice(-180))) {
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
            snippets: extractSnippetsFromMarkdown(combinedMd, cleaned || "Claude"),
        };
    }
    catch {
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
function discoverClaudeSessionsForCwd(cwd) {
    const results = [];
    const home = os.homedir();
    const projectsRoot = path.join(home, ".claude", "projects");
    if (!fs.existsSync(projectsRoot))
        return results;
    const targetSlug = claudeProjectSlug(cwd).toLowerCase();
    let dirs = [];
    try {
        dirs = fs.readdirSync(projectsRoot);
    }
    catch {
        return results;
    }
    for (const dirName of dirs) {
        if (dirName.toLowerCase() !== targetSlug)
            continue;
        const fullDir = path.join(projectsRoot, dirName);
        let files = [];
        try {
            files = fs.readdirSync(fullDir).filter((f) => f.endsWith(".jsonl"));
        }
        catch {
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
            }
            catch {
                // ignore
            }
        }
    }
    return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function extractTranscriptSummaryForHandoff(session) {
    const userPrompts = [];
    const assistantReplies = [];
    const cmd = (session.command || "").trim().toLowerCase();
    const home = os.homedir();
    // 1. Antigravity (agy) transcript
    if ((cmd === "agy" || cmd === "agy.cmd" || cmd === "agy.exe") &&
        session.cliSessionId) {
        const transcriptPath = path.join(home, ".gemini", "antigravity-cli", "brain", session.cliSessionId, ".system_generated", "logs", "transcript.jsonl");
        if (fs.existsSync(transcriptPath)) {
            try {
                const lines = fs
                    .readFileSync(transcriptPath, "utf8")
                    .split(/\r?\n/)
                    .filter((l) => l.trim());
                for (const line of lines) {
                    try {
                        const obj = JSON.parse(line);
                        if ((obj.source === "USER_EXPLICIT" || obj.type === "USER_INPUT") &&
                            typeof obj.content === "string") {
                            const m = obj.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
                            const text = (m ? m[1] : obj.content).replace(/\s+/g, " ").trim();
                            if (text)
                                userPrompts.push(text.slice(0, 320));
                        }
                        else if (obj.source === "MODEL" &&
                            typeof obj.content === "string" &&
                            obj.content.trim()) {
                            assistantReplies.push(obj.content.trim().slice(0, 900));
                        }
                    }
                    catch {
                        // ignore
                    }
                }
                return {
                    userPrompts: userPrompts.slice(-5),
                    assistantReplies: assistantReplies.slice(-3),
                    sourceFound: userPrompts.length > 0 || assistantReplies.length > 0,
                };
            }
            catch {
                // ignore
            }
        }
    }
    // 2. Claude Code transcript
    if ((cmd === "claude" || cmd === "claude.exe") &&
        session.cliSessionId) {
        const projectsRoot = path.join(home, ".claude", "projects");
        let jsonlPath = path.join(projectsRoot, claudeProjectSlug(session.cwd), `${session.cliSessionId}.jsonl`);
        if (!fs.existsSync(jsonlPath) && fs.existsSync(projectsRoot)) {
            try {
                for (const dir of fs.readdirSync(projectsRoot)) {
                    const candidate = path.join(projectsRoot, dir, `${session.cliSessionId}.jsonl`);
                    if (fs.existsSync(candidate)) {
                        jsonlPath = candidate;
                        break;
                    }
                }
            }
            catch {
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
                            const isToolResult = Array.isArray(rawContent) &&
                                rawContent.some((p) => p && p.type === "tool_result");
                            if (!isToolResult) {
                                let text = "";
                                if (typeof rawContent === "string") {
                                    text = rawContent;
                                }
                                else if (Array.isArray(rawContent)) {
                                    const textPart = rawContent.find((p) => p && p.type === "text" && typeof p.text === "string");
                                    if (textPart)
                                        text = textPart.text;
                                }
                                const cleaned = text.replace(/\s+/g, " ").trim();
                                if (cleaned)
                                    userPrompts.push(cleaned.slice(0, 320));
                            }
                        }
                        else if (obj.type === "assistant" &&
                            obj.message?.role === "assistant" &&
                            Array.isArray(obj.message.content)) {
                            const textParts = obj.message.content
                                .filter((p) => p && p.type === "text" && typeof p.text === "string")
                                .map((p) => p.text.trim())
                                .filter(Boolean);
                            if (textParts.length > 0) {
                                assistantReplies.push(textParts.join("\n").slice(0, 900));
                            }
                        }
                    }
                    catch {
                        // ignore
                    }
                }
                return {
                    userPrompts: userPrompts.slice(-5),
                    assistantReplies: assistantReplies.slice(-3),
                    sourceFound: userPrompts.length > 0 || assistantReplies.length > 0,
                };
            }
            catch {
                // ignore
            }
        }
    }
    return { userPrompts: [], assistantReplies: [], sourceFound: false };
}
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
        lower === "powershell.exe" ||
        lower.startsWith("claude ") ||
        lower.startsWith("agy ") ||
        lower.startsWith("gemini ") ||
        lower.startsWith("codex ")) {
        return null;
    }
    const cleaned = firstLine.replace(/\s+/g, " ").slice(0, 28);
    const baseLabel = label.split("·")[0].trim();
    return `${baseLabel} · ${cleaned}`;
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
function buildShellLaunch(session, isResume) {
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
        const nameArg = session.hasCustomTitle && safeName ? ` -n "${safeName}"` : "";
        if (isResume) {
            const targetKey = sessionId || session.cliSessionName;
            if (targetKey) {
                return {
                    shellPath: "powershell.exe",
                    shellArgs: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
                    initialCommand: `claude --resume "${targetKey}"${nameArg}${extraArgs}; if ($LASTEXITCODE -ne 0) { claude --continue${nameArg}${extraArgs} }; if ($LASTEXITCODE -ne 0) { claude${sessionId ? ` --session-id "${sessionId}"` : ""}${nameArg}${extraArgs} }`,
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
            initialCommand: `claude${sessionId ? ` --session-id "${sessionId}"` : ""}${nameArg}${extraArgs}`,
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
class AgentCockpitProvider {
    _context;
    static viewType = "agentCockpit.sidebarView";
    _view;
    _sessions = [];
    _snippetsBySessionId = new Map();
    _latestSnippets = [];
    _dismissedCliIds;
    _activeSessionId = null;
    _currentCwd;
    _defaultLocation = "editor";
    _soundEnabled;
    _lastUsedCliId;
    _jobs = [];
    _pollTimer;
    constructor(_context) {
        this._context = _context;
        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this._currentCwd = wsFolder || "D:\\Thulir Inc";
        this._soundEnabled = this._context.globalState.get(SOUND_PREF_KEY, true);
        const installed = getInstalledPresets();
        this._lastUsedCliId =
            this._context.globalState.get(LAST_CLI_KEY) ||
                installed[0]?.id ||
                "agy";
        const savedJobs = this._context.globalState.get(STORAGE_JOBS_KEY) || [];
        const bootNow = Date.now();
        this._jobs = savedJobs.map((j) => ({
            ...j,
            nextRunAt: j.nextRunAt && j.nextRunAt > bootNow
                ? j.nextRunAt
                : computeNextRunAt(j, bootNow),
        }));
        const savedDismissed = this._context.globalState.get(DISMISSED_KEY) || [];
        this._dismissedCliIds = new Set(savedDismissed);
        const saved = this._context.globalState.get(STORAGE_KEY) || [];
        this._sessions = saved
            .filter((meta) => !meta.id.startsWith("sess-agy-") &&
            !meta.id.startsWith("sess-cli-") &&
            (!meta.cliSessionId || !this._dismissedCliIds.has(meta.cliSessionId)))
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
            if (!activeTerm)
                return;
            const found = this._sessions.find((s) => s.terminal === activeTerm);
            if (found && found.id !== this._activeSessionId) {
                this._activeSessionId = found.id;
                this._currentCwd = found.cwd;
                void this.refreshWebviewState();
            }
        });
        const winAny = vscode.window;
        if (typeof winAny.onDidStartTerminalShellExecution === "function") {
            this._context.subscriptions.push(winAny.onDidStartTerminalShellExecution((e) => {
                const sess = this._sessions.find((s) => s.terminal === e.terminal);
                if (!sess)
                    return;
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
            }));
        }
        if (typeof winAny.onDidEndTerminalShellExecution === "function") {
            this._context.subscriptions.push(winAny.onDidEndTerminalShellExecution((e) => {
                const sess = this._sessions.find((s) => s.terminal === e.terminal);
                if (!sess)
                    return;
                if (isTerminalAlive(sess.terminal)) {
                    sess.status = "idle";
                    void this.refreshWebviewState();
                }
            }));
        }
    }
    /**
     * Plays an audio notification chime when an AI agent finishes a response or requests approval.
     */
    _triggerNotificationSound(kind, sessionTitle) {
        if (!this._soundEnabled)
            return;
        if (this._view) {
            void this._view.webview.postMessage({
                type: "playChime",
                kind,
                sessionTitle,
            });
        }
    }
    async _toggleTopEditorTabBar() {
        const wbConfig = vscode.workspace.getConfiguration("workbench.editor");
        const current = wbConfig.get("showTabs") || "multiple";
        const next = current === "none" ? "multiple" : "none";
        try {
            await wbConfig.update("showTabs", next, vscode.ConfigurationTarget.Global);
        }
        catch {
            await vscode.commands.executeCommand(next === "none"
                ? "workbench.action.hideEditorTabs"
                : "workbench.action.showMultipleEditorTabs");
        }
        await this.refreshWebviewState();
    }
    _syncCliStoredSessionNames() {
        let changed = false;
        const applyDiscovered = (match, disc) => {
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
                }
                else if (disc.lastUserTurnId &&
                    disc.lastUserTurnId !== match.lastUserTurnId) {
                    // A new human prompt was submitted!
                    match.lastUserTurnId = disc.lastUserTurnId;
                }
                // Chime AT MOST ONCE per user prompt, and ONLY when the entire agentic turn is complete!
                const now = Date.now();
                if (disc.isTurnComplete &&
                    disc.lastUserTurnId &&
                    match.lastNotifiedUserTurnId !== disc.lastUserTurnId &&
                    now - (match.lastChimeAt || 0) > 8000) {
                    match.lastNotifiedUserTurnId = disc.lastUserTurnId;
                    match.lastChimeAt = now;
                    this._triggerNotificationSound(disc.runtimeHint === "needs-input" ? "approval" : "complete", match.title);
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
                if (isTerminalAlive(match.terminal) &&
                    vscode.window.activeTerminal === match.terminal) {
                    void vscode.commands
                        .executeCommand("workbench.action.terminal.renameWithArg", {
                        name: disc.title,
                    })
                        .then(undefined, () => { });
                }
            }
        };
        const agyDiscovered = discoverAgySessions(this._currentCwd);
        for (const disc of agyDiscovered) {
            if (this._dismissedCliIds.has(disc.cliSessionId))
                continue;
            let match = this._sessions.find((s) => s.cliSessionId === disc.cliSessionId);
            if (!match) {
                match = this._sessions.find((s) => s.command.toLowerCase().startsWith("agy") &&
                    !s.cliSessionId &&
                    !this._sessions.some((other) => other.cliSessionId === disc.cliSessionId) &&
                    disc.mtimeMs >= s.createdAt - 15000);
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
        const cwdsToScan = new Set([this._currentCwd]);
        for (const s of this._sessions) {
            if (s.cwd)
                cwdsToScan.add(s.cwd);
        }
        for (const cwd of cwdsToScan) {
            const discovered = discoverClaudeSessionsForCwd(cwd);
            for (const disc of discovered) {
                if (this._dismissedCliIds.has(disc.cliSessionId))
                    continue;
                let match = this._sessions.find((s) => s.cliSessionId === disc.cliSessionId);
                if (!match) {
                    match = this._sessions.find((s) => s.command.toLowerCase().startsWith("claude") &&
                        s.cwd.toLowerCase() === cwd.toLowerCase() &&
                        !discovered.some((d) => d.cliSessionId === s.cliSessionId) &&
                        disc.mtimeMs >= s.createdAt - 15000);
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
        if (this._latestSnippets.length === 0) {
            const firstWithSnips = [...agyDiscovered, ...discoverClaudeSessionsForCwd(this._currentCwd)].find((d) => d.snippets && d.snippets.length > 0);
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
    _findOrphanTerminal(s) {
        const claimed = new Set(this._sessions
            .filter((o) => o !== s && o.terminal)
            .map((o) => o.terminal));
        const folder = path.basename(s.cwd) || s.cwd;
        const candidates = vscode.window.terminals.filter((t) => !claimed.has(t) && t.exitStatus === undefined);
        return (candidates.find((t) => t.name === `${s.title} · ${folder}`) ||
            candidates.find((t) => t.name === s.title) ||
            candidates.find((t) => s.title.length > 2 && t.name.startsWith(s.title)) ||
            (s.cliSessionName
                ? candidates.find((t) => t.name.startsWith(s.cliSessionName))
                : undefined));
    }
    _syncLiveness() {
        for (const s of this._sessions) {
            if (!isTerminalAlive(s.terminal)) {
                const orphan = this._findOrphanTerminal(s);
                s.terminal = orphan;
            }
            if (isTerminalAlive(s.terminal)) {
                if (s.status === "stopped") {
                    s.status = "idle";
                }
            }
            else {
                s.terminal = undefined;
                s.status = "stopped";
            }
        }
    }
    _persistJobs() {
        void this._context.globalState.update(STORAGE_JOBS_KEY, this._jobs);
    }
    _checkScheduledJobs() {
        const now = Date.now();
        let fired = false;
        for (const job of this._jobs) {
            if (!job.enabled)
                continue;
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
    async _executeScheduledJob(job) {
        const now = Date.now();
        job.lastRunAt = now;
        if (job.enabled) {
            job.nextRunAt = computeNextRunAt(job, now + 1000);
        }
        this._persistJobs();
        const lowerCmd = job.command.toLowerCase();
        const isShell = lowerCmd === "powershell.exe" ||
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
            vscode.window.setStatusBarMessage(`Agent Cockpit: Ran scheduled job "${job.name}"`, 4000);
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
        vscode.window.setStatusBarMessage(`Agent Cockpit: Started scheduled job "${job.name}"`, 4000);
        await this.refreshWebviewState();
    }
    async promptCreateScheduledJob() {
        const name = await vscode.window.showInputBox({
            title: "New Scheduled Job (1/4)",
            prompt: "Job Name",
            placeHolder: "e.g., Morning PR Summary, Run Unit Tests, Check Logs",
        });
        if (!name || !name.trim())
            return;
        const installed = getInstalledPresets();
        const cliPick = await vscode.window.showQuickPick(installed.map((p) => ({
            label: p.label,
            description: p.command,
            preset: p,
        })), {
            title: "New Scheduled Job (2/4)",
            placeHolder: "Select CLI to run this scheduled job",
        });
        if (!cliPick)
            return;
        const prompt = await vscode.window.showInputBox({
            title: "New Scheduled Job (3/4)",
            prompt: `Prompt or command to send to ${cliPick.preset.label}`,
            placeHolder: cliPick.preset.id === "powershell" || cliPick.preset.id === "cmd"
                ? "e.g., npm test"
                : "e.g., Review git status and summarize today's changes",
        });
        if (!prompt || !prompt.trim())
            return;
        const schedPick = await vscode.window.showQuickPick([
            { label: "Every 15 minutes", scheduleType: "interval", intervalMinutes: 15 },
            { label: "Every 30 minutes", scheduleType: "interval", intervalMinutes: 30 },
            { label: "Every 1 hour", scheduleType: "interval", intervalMinutes: 60 },
            { label: "Every 5 minutes (testing)", scheduleType: "interval", intervalMinutes: 5 },
            { label: "Daily at specific time (HH:MM)", scheduleType: "daily" },
            { label: "Weekdays (Mon–Fri) at specific time (HH:MM)", scheduleType: "weekdays" },
        ], {
            title: "New Scheduled Job (4/4)",
            placeHolder: "Choose schedule frequency",
        });
        if (!schedPick)
            return;
        let dailyTime;
        if (schedPick.scheduleType === "daily" || schedPick.scheduleType === "weekdays") {
            const timeInput = await vscode.window.showInputBox({
                title: "Scheduled Time (24-hour HH:MM)",
                prompt: "Enter time in 24-hour format (e.g. 09:00, 14:30, 18:00)",
                value: "09:00",
                validateInput: (v) => /^\d{1,2}:\d{2}$/.test(v.trim()) ? null : "Use HH:MM format (e.g. 09:00)",
            });
            if (!timeInput)
                return;
            dailyTime = timeInput.trim();
        }
        const p = cliPick.preset;
        const rawCmd = p.command.trim().toLowerCase();
        let cliName = path.basename(rawCmd, path.extname(rawCmd)) || "cli";
        if (cliName === "powershell")
            cliName = "ps1";
        const newJob = {
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
            nextRunAt: computeNextRunAt({
                scheduleType: schedPick.scheduleType,
                intervalMinutes: schedPick.intervalMinutes,
                dailyTime,
            }, Date.now()),
        };
        this._jobs.push(newJob);
        this._persistJobs();
        await this.refreshWebviewState();
        vscode.window.setStatusBarMessage(`Agent Cockpit: Scheduled "${newJob.name}" (${formatScheduleLabel(newJob)})`, 4000);
    }
    _persistSessions() {
        // Keep pinned sessions sorted at the top
        this._sessions.sort((a, b) => {
            const pinA = a.pinned ? 1 : 0;
            const pinB = b.pinned ? 1 : 0;
            if (pinA !== pinB)
                return pinB - pinA;
            return a.createdAt - b.createdAt;
        });
        const serializable = this._sessions.map((s) => ({
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
    resolveWebviewView(webviewView) {
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
                    await this._context.globalState.update(SOUND_PREF_KEY, this._soundEnabled);
                    if (this._soundEnabled) {
                        this._triggerNotificationSound("complete", "Sound Enabled");
                    }
                    await this.refreshWebviewState();
                    break;
                case "selectCliPreset":
                    if (typeof msg.presetId === "string" && msg.presetId) {
                        this._lastUsedCliId = msg.presetId;
                        await this._context.globalState.update(LAST_CLI_KEY, this._lastUsedCliId);
                        await this.refreshWebviewState();
                    }
                    break;
                case "spawnSession":
                    if (typeof msg.presetId === "string" && msg.presetId) {
                        this._lastUsedCliId = msg.presetId;
                        await this._context.globalState.update(LAST_CLI_KEY, this._lastUsedCliId);
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
                        vscode.window.setStatusBarMessage("Agent Cockpit: Copied to clipboard!", 2500);
                    }
                    break;
                case "runCommandInShell":
                    if (typeof msg.command === "string" && msg.command.trim()) {
                        await this._runCommandInShellSession(msg.command.trim());
                    }
                    break;
                case "sendCommandToTerminal":
                    if (typeof msg.command === "string" && msg.command.trim()) {
                        await this.sendTextToActiveAgent(msg.command.trim(), Boolean(msg.execute));
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
                        const promptPrefix = msg.kind === "agent"
                            ? `Use the ${msg.name} subagent to `
                            : `Use the ${msg.name} skill to `;
                        await this.sendTextToActiveAgent(promptPrefix, false);
                    }
                    break;
                case "openSkillFile":
                    if (typeof msg.filePath === "string" && fs.existsSync(msg.filePath)) {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.filePath));
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
                    const finalHandoff = await this._saveHandoffContent(msg.content || "", true);
                    await this.sendTextToActiveAgent(`Please read .agent/handoff.md and continue from there.`, true);
                    if (finalHandoff) {
                        await this.refreshWebviewState();
                    }
                    break;
                }
                case "handoffSession":
                    await this.handoffSessionToTarget(typeof msg.id === "string" ? msg.id : undefined);
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
                case "refreshGit":
                    this._syncCliStoredSessionNames();
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
            this._syncCliStoredSessionNames();
            await this.refreshWebviewState();
        }
    }
    _createVsTerminalForSession(session, isResume) {
        const folderShort = path.basename(session.cwd) || session.cwd;
        const termName = `${session.title} · ${folderShort}`;
        const resolved = buildShellLaunch(session, isResume);
        const terminalLocation = session.location === "editor"
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
        const id = `sess-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 6)}`;
        const isClaude = params.command.toLowerCase().startsWith("claude");
        const cliSessionId = isClaude ? crypto.randomUUID() : undefined;
        const session = {
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
    async renameSession(id, newTitleRaw, userInitiated = true) {
        const trimmed = newTitleRaw.trim();
        if (!trimmed)
            return;
        const found = this._sessions.find((s) => s.id === id);
        if (!found)
            return;
        found.title = trimmed;
        found.hasCustomTitle = true;
        if (userInitiated) {
            found.userRenamed = true;
            found.cliSessionName = trimmed;
            if (found.command.toLowerCase().startsWith("agy") &&
                found.cliSessionId) {
                try {
                    const pbtxtPath = path.join(os.homedir(), ".gemini", "antigravity-cli", "annotations", `${found.cliSessionId}.pbtxt`);
                    fs.mkdirSync(path.dirname(pbtxtPath), { recursive: true });
                    fs.writeFileSync(pbtxtPath, `title:"${trimmed.replace(/"/g, "")}"\n`, "utf8");
                }
                catch {
                    // ignore
                }
            }
        }
        this._persistSessions();
        if (isTerminalAlive(found.terminal)) {
            try {
                found.terminal.show(true);
                await vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name: trimmed });
            }
            catch {
                // ignore
            }
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
            await this.renameSession(found.id, input.trim(), true);
        }
    }
    async sendQuickPromptToActiveAgent(promptText) {
        const active = this._sessions.find((s) => s.id === this._activeSessionId) ??
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
        }
        catch {
            // ignore
        }
    }
    focusSessionByIndex(indexZeroBased) {
        if (indexZeroBased < 0 || indexZeroBased >= this._sessions.length)
            return;
        void this.focusOrRelaunchSessionById(this._sessions[indexZeroBased].id);
    }
    async focusOrRelaunchSessionById(id) {
        const found = this._sessions.find((s) => s.id === id);
        if (!found)
            return;
        this._activeSessionId = found.id;
        this._currentCwd = found.cwd;
        if (!isTerminalAlive(found.terminal)) {
            found.terminal = this._findOrphanTerminal(found);
        }
        if (isTerminalAlive(found.terminal)) {
            if (found.status === "stopped")
                found.status = "idle";
            found.terminal.show(false);
            try {
                await vscode.commands.executeCommand("workbench.action.terminal.focus");
            }
            catch {
                // ignore
            }
            await this.refreshWebviewState();
        }
        else {
            await this.relaunchSessionById(id, true);
        }
    }
    async relaunchSessionById(id, isResume = true) {
        const found = this._sessions.find((s) => s.id === id);
        if (!found)
            return;
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
            }
            catch {
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
        }
        catch {
            // ignore
        }
        await this.refreshWebviewState();
    }
    async deleteSessionById(id) {
        const idx = this._sessions.findIndex((s) => s.id === id);
        if (idx === -1)
            return;
        const target = this._sessions[idx];
        if (target.cliSessionId) {
            this._dismissedCliIds.add(target.cliSessionId);
            void this._context.globalState.update(DISMISSED_KEY, Array.from(this._dismissedCliIds));
        }
        if (isTerminalAlive(target.terminal)) {
            try {
                target.terminal.dispose();
            }
            catch {
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
    async sendTextToActiveAgent(text, addNewLine = false) {
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
        }
        catch {
            // ignore
        }
    }
    /**
     * Executes a shell command recommended by an AI inside a dedicated PowerShell terminal
     * in the current working directory (reusing an open Shell session or creating one).
     */
    async _runCommandInShellSession(commandText) {
        let shellSess = this._sessions.find((s) => s.command.toLowerCase().includes("powershell") &&
            s.cwd.toLowerCase() === this._currentCwd.toLowerCase());
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
        }
        else if (!isTerminalAlive(shellSess.terminal)) {
            await this.relaunchSessionById(shellSess.id, false);
        }
        if (shellSess && shellSess.terminal) {
            shellSess.terminal.show(false);
            shellSess.terminal.sendText(commandText, true);
            try {
                await vscode.commands.executeCommand("workbench.action.terminal.focus");
            }
            catch {
                // ignore
            }
        }
    }
    /**
     * Captures currently highlighted text from either the active Terminal or active Text Editor,
     * cleans common TUI border/prompt prefixes, and runs it in Shell or sends it to the active terminal.
     */
    async handleHighlightedTextAction(mode) {
        let selectedText = "";
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) {
            selectedText = editor.document.getText(editor.selection);
        }
        else {
            // Copy highlighted text from the focused terminal
            const prevClipboard = await vscode.env.clipboard.readText();
            try {
                await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
                await new Promise((resolve) => setTimeout(resolve, 80));
                selectedText = await vscode.env.clipboard.readText();
            }
            catch {
                selectedText = prevClipboard;
            }
        }
        const cleaned = selectedText
            .split(/\r?\n/)
            .map((line) => line
            .replace(/^[│┃|]\s?/, "")
            .replace(/\s?[│┃|]$/, "")
            .replace(/^\s*(?:PS [^>]+>|\$|❯|>)\s+/, "")
            .trim())
            .filter((line) => line.length > 0)
            .join("\n")
            .trim();
        if (!cleaned) {
            vscode.window.showWarningMessage("Highlight text or a command first, then press Ctrl+Alt+R (Run in Shell), Ctrl+Alt+T (Send to Terminal), or click the ▶ / >_ icons in the terminal tab bar.");
            return;
        }
        if (mode === "runInShell") {
            await this._runCommandInShellSession(cleaned);
        }
        else {
            await this.sendTextToActiveAgent(cleaned, false);
        }
    }
    async sendActiveEditorSelectionToAgent(targetSessionId) {
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
        const lineRange = !sel.isEmpty && startLine !== endLine
            ? `${startLine}-${endLine}`
            : `${startLine}`;
        await this.sendTextToActiveAgent(formatAtFileRef(relPath, lineRange), false);
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
    async _saveHandoffContent(content, autoGenerateIfEmpty = false) {
        const p = this._getHandoffPath();
        let textToWrite = content.trim();
        if (!textToWrite && autoGenerateIfEmpty) {
            const existing = this._readHandoffContent().trim();
            if (existing) {
                textToWrite = existing;
            }
            else {
                const gitInfo = await this._getGitChanges(this._currentCwd);
                const sessionLines = this._sessions
                    .map((s) => `- [${s.badge}] ${s.title} (${s.status}) — cwd: ${s.cwd}`)
                    .join("\n");
                const gitLines = gitInfo.changes.length > 0
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
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed saving handoff.md: ${msg}`);
        }
        return textToWrite;
    }
    /**
     * 1-Click Handoff: extracts real conversation context from a source chat session,
     * writes structured handoff notes to .agent/handoff.md, and sends them to a chosen target session.
     */
    async handoffSessionToTarget(sourceSessionId) {
        this._syncLiveness();
        this._syncCliStoredSessionNames();
        const source = (sourceSessionId
            ? this._sessions.find((s) => s.id === sourceSessionId)
            : undefined) ||
            this._sessions.find((s) => s.id === this._activeSessionId) ||
            this._sessions[0];
        if (!source) {
            vscode.window.showWarningMessage("No source session found to generate handoff notes from.");
            return;
        }
        const otherSessions = this._sessions.filter((s) => s.id !== source.id);
        const items = [];
        if (otherSessions.length > 0) {
            items.push({
                label: "Existing Chat Sessions",
                kind: vscode.QuickPickItemKind.Separator,
            });
            for (const s of otherSessions) {
                const cli = path
                    .basename((s.command || "cli").trim().toLowerCase(), path.extname(s.command || ""))
                    .replace(/^powershell$/, "ps1");
                items.push({
                    label: s.title,
                    description: `${cli} · ${path.basename(s.cwd)}`,
                    detail: s.status === "stopped"
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
        if (!picked)
            return;
        // 1. Extract real conversation transcript + git context from source session
        const transcript = extractTranscriptSummaryForHandoff(source);
        const gitInfo = await this._getGitChanges(source.cwd || this._currentCwd);
        const sourceCli = path
            .basename((source.command || "cli").trim().toLowerCase(), path.extname(source.command || ""))
            .replace(/^powershell$/, "ps1");
        const userLines = transcript.userPrompts.length > 0
            ? transcript.userPrompts.map((p, idx) => `${idx + 1}. ${p}`).join("\n")
            : "- (No transcript prompts captured — check recent workspace changes below)";
        const assistantLines = transcript.assistantReplies.length > 0
            ? transcript.assistantReplies
                .map((r, idx) => `### Turn ${idx + 1}\n${r}`)
                .join("\n\n")
            : "- (No assistant transcript found on disk for this CLI)";
        const gitLines = gitInfo.changes.length > 0
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
        const writeHandoffTo = (dir) => {
            const targetFile = path.join(dir, ".agent", "handoff.md");
            fs.mkdirSync(path.dirname(targetFile), { recursive: true });
            fs.writeFileSync(targetFile, handoffMarkdown + "\n", "utf8");
        };
        try {
            writeHandoffTo(this._currentCwd);
            if (source.cwd && source.cwd.toLowerCase() !== this._currentCwd.toLowerCase()) {
                writeHandoffTo(source.cwd);
            }
        }
        catch (err) {
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
        }
        else if (picked.sessionId) {
            const target = this._sessions.find((s) => s.id === picked.sessionId);
            if (!target)
                return;
            targetTitle = target.title;
            if (target.cwd && target.cwd.toLowerCase() !== this._currentCwd.toLowerCase()) {
                try {
                    writeHandoffTo(target.cwd);
                }
                catch {
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
            }
            else if (target.terminal) {
                target.terminal.show(false);
                target.terminal.sendText(promptToSend, true);
                try {
                    await vscode.commands.executeCommand("workbench.action.terminal.focus");
                }
                catch {
                    // ignore
                }
            }
        }
        await this.refreshWebviewState();
        vscode.window.setStatusBarMessage(`Agent Cockpit: Handed off "${source.title}" → "${targetTitle}" (.agent/handoff.md)`, 4500);
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
                file: line.slice(3).trim().replace(/^"(.*)"$/, "$1"),
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
        this._syncLiveness();
        const gitInfo = await this._getGitChanges(this._currentCwd);
        const handoffContent = this._readHandoffContent();
        const mcpServers = discoverMcpServers(this._currentCwd);
        const skillsAndAgents = discoverSkillsAndAgents(this._currentCwd);
        const wbConfig = vscode.workspace.getConfiguration("workbench.editor");
        const showTabs = wbConfig.get("showTabs") || "multiple";
        const installedPresets = getInstalledPresets();
        const validLastCliId = installedPresets.some((p) => p.id === this._lastUsedCliId)
            ? this._lastUsedCliId
            : installedPresets[0]?.id || "agy";
        const activeSnippets = (this._activeSessionId &&
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
                if (cliName === "powershell")
                    cliName = "ps1";
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
    _getHtmlForWebview() {
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
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.65px;
      text-transform: uppercase;
      color: var(--md-muted);
      padding: 4px 3px 2px 3px;
      user-select: none;
    }
    .section-divider {
      height: 1px;
      background: var(--md-border);
      margin: 4px 2px;
    }
    .pinned-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 6px;
      border-radius: 10px;
      background: rgba(245, 158, 11, 0.06);
      border: 1px solid rgba(245, 158, 11, 0.22);
    }
    .cli-tag {
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.2px;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid var(--md-border-strong);
      background: var(--bg-shell);
      color: var(--md-fg);
      flex-shrink: 0;
      cursor: pointer;
      line-height: 15px;
      transition: opacity 0.12s, transform 0.12s;
    }
    .cli-tag:hover {
      opacity: 0.85;
      transform: scale(1.03);
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
    .session-card:hover .cli-tag,
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
      grid-template-columns: repeat(3, 1fr);
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
      <span id="launch-last-label">+ Launch AGY</span>
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
    <div id="mcp-drawer" class="drawer-pane"></div>
    <div id="skills-drawer" class="drawer-pane"></div>
    <div id="jobs-drawer" class="drawer-pane"></div>

    <div class="footer-tabs">
      <button id="tab-mcp" class="footer-btn" title="View MCP servers & live status">MCP (<span id="mcp-count">0</span>)</button>
      <button id="tab-skills" class="footer-btn" title="View available Skills & Subagents">Skills (<span id="skills-count">0</span>)</button>
      <button id="tab-jobs" class="footer-btn" title="Manage automated scheduled CLI jobs">Jobs (<span id="jobs-count">0</span>)</button>
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
        launchLastLabel.textContent = "+ Launch " + selectedPreset.label.split(" ")[0];
        launchLastBtn.title =
          "1-Click Launch " + selectedPreset.label + " (" + selectedPreset.command + ")";
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
      customOpt.textContent = "+ Custom CLI…";
      cliDropdown.appendChild(customOpt);

      // Material Session Cards (Pinned Section Separated at Top + Clean CLI Monospace Tag)
      sessionList.innerHTML = "";
      if (!msg.sessions || msg.sessions.length === 0) {
        sessionList.innerHTML = '<div class="empty-card">Click Launch above to start an agent session</div>';
      } else {
        const renderSessionCard = (s) => {
          const isStopped = s.status === "stopped";
          const cardColor = s.color || "#3b82f6";
          const cliTagLabel = s.cliName || "cli";
          const tagInfo = statusLabelFor(s.status, s.folderName);
          const shortcutBadge = s.index <= 5 ? '<span class="shortcut-pill">⌃' + s.index + '</span>' : '';
          const card = document.createElement("div");
          card.className =
            "session-card" +
            (s.id === msg.activeSessionId ? " active" : "") +
            (isStopped ? " stopped" : "");
          card.style.borderLeft = "4px solid " + cardColor;
          card.title = isStopped
            ? "Paused (" + cliTagLabel + ") — Click to resume conversation (" + s.folderName + ")"
            : "CLI: " + cliTagLabel + " · Status: " + s.status + " · Folder: " + s.cwd + " · Double-click title to rename";

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
              '<span class="s-title">' + s.title + '</span>' +
              '<span class="cli-tag act-color" title="CLI: ' + cliTagLabel + ' (Click to change color)" style="border-color:' + cardColor + ';color:' + cardColor + ';">' + cliTagLabel + '</span>' +
              '<span class="state-tag ' + tagInfo.cls + '">' + tagInfo.text + '</span>' +
              shortcutBadge +
              '<div class="row-actions">' +
                '<button class="icon-action act-handoff" title="1-Click Handoff: Generate notes from this chat & send to another session">⇄</button>' +
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
          pinHeader.innerHTML = '<span>📌 Pinned</span><span>' + pinnedSessions.length + '</span>';
          sessionList.appendChild(pinHeader);

          const pinGroup = document.createElement("div");
          pinGroup.className = "pinned-group";
          pinnedSessions.forEach((s) => pinGroup.appendChild(renderSessionCard(s)));
          sessionList.appendChild(pinGroup);

          if (regularSessions.length > 0) {
            const divider = document.createElement("div");
            divider.className = "section-divider";
            sessionList.appendChild(divider);

            const regHeader = document.createElement("div");
            regHeader.className = "section-header";
            regHeader.innerHTML = '<span>Conversations</span><span>' + regularSessions.length + '</span>';
            sessionList.appendChild(regHeader);
          }
        }

        regularSessions.forEach((s) => sessionList.appendChild(renderSessionCard(s)));
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

      // Render Automated Scheduled Jobs
      const jobs = msg.scheduledJobs || [];
      jobsCount.textContent = String(jobs.length);
      jobsDrawer.innerHTML = "";

      const addJobBtn = document.createElement("button");
      addJobBtn.className = "send-btn";
      addJobBtn.style.padding = "5px 8px";
      addJobBtn.style.width = "100%";
      addJobBtn.textContent = "+ New Scheduled Job";
      addJobBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "createScheduledJob" });
      });
      jobsDrawer.appendChild(addJobBtn);

      if (jobs.length === 0) {
        const emptyEl = document.createElement("div");
        emptyEl.style.cssText = "color:var(--md-muted);text-align:center;padding:6px 0;font-size:10.5px;";
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
            "\nPrompt: " +
            j.prompt;
          r.innerHTML =
            '<span class="status-led ' + (j.enabled ? "led-working" : "led-stopped") + '"></span>' +
            '<span class="item-title">' + j.name + '</span>' +
            '<span class="scope-pill">' + j.cliName + ' · ' + j.scheduleLabel + '</span>' +
            '<button class="icon-action job-run" title="Run now">▶</button>' +
            '<button class="icon-action job-toggle" title="' + (j.enabled ? "Pause job" : "Resume job") + '">' + (j.enabled ? "⏸" : "↻") + '</button>' +
            '<button class="icon-action danger job-del" title="Delete job">✕</button>';
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
function activate(context) {
    const provider = new AgentCockpitProvider(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentCockpitProvider.viewType, provider, { webviewOptions: { retainContextWhenHidden: true } }));
    context.subscriptions.push(vscode.commands.registerCommand("agentCockpit.newSession", async () => {
        const installed = getInstalledPresets();
        const picked = await vscode.window.showQuickPick([
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
        ], { placeHolder: "Launch Installed CLI Agent" });
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
                color: "#64748b",
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
        void provider.sendActiveEditorSelectionToAgent();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("agentCockpit.runHighlightedCommand", () => {
        void provider.handleHighlightedTextAction("runInShell");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("agentCockpit.sendHighlightedToTerminal", () => {
        void provider.handleHighlightedTextAction("sendToTerminal");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("agentCockpit.openHandoff", () => {
        void provider.openHandoffInEditor();
    }));
    for (let i = 1; i <= 5; i++) {
        context.subscriptions.push(vscode.commands.registerCommand(`agentCockpit.switchSession${i}`, () => {
            provider.focusSessionByIndex(i - 1);
        }));
    }
}
function deactivate() { }
//# sourceMappingURL=extension.js.map