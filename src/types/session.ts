export type RuntimeStatus = "working" | "idle" | "needs-input" | "exited";

export interface TerminalSession {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  worktreePath?: string;
  status: RuntimeStatus;
  exitCode?: number | null;
  createdAt: number;
}

export interface CliPreset {
  id: string;
  label: string;
  badge: string;
  command: string;
  args: string[];
  description: string;
}

export const DEFAULT_PRESETS: CliPreset[] = [
  {
    id: "powershell",
    label: "PowerShell",
    badge: "PS",
    command: "powershell.exe",
    args: ["-NoLogo"],
    description: "Interactive Windows PowerShell session",
  },
  {
    id: "claude",
    label: "Claude Code",
    badge: "CC",
    command: "claude",
    args: [],
    description: "Anthropic Claude Code interactive TUI agent",
  },
  {
    id: "codex",
    label: "Codex CLI",
    badge: "CX",
    command: "codex",
    args: [],
    description: "OpenAI Codex interactive CLI coding agent",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    badge: "GM",
    command: "gemini",
    args: [],
    description: "Google Gemini interactive CLI coding agent",
  },
  {
    id: "cmd",
    label: "Command Prompt",
    badge: "CMD",
    command: "cmd.exe",
    args: [],
    description: "Standard Windows cmd.exe shell",
  },
];
