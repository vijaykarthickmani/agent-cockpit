import React, { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { spawn, IPty } from "tauri-pty";
import "@xterm/xterm/css/xterm.css";
import { RuntimeStatus, TerminalSession } from "../types/session";

interface TerminalPaneProps {
  session: TerminalSession;
  isActive: boolean;
  onStatusChange: (
    id: string,
    status: RuntimeStatus,
    exitCode?: number | null
  ) => void;
  onAutoTitle?: (id: string, firstLine: string) => void;
}

interface ResolvedCommand {
  program: string;
  args: string[];
  resolvedPath: string;
}

const NEEDS_INPUT_PATTERNS = [
  /\?\s*$/m,
  /\[y\/n\]/i,
  /\[Y\/n\]/i,
  /\(y\/n\)/i,
  /Press Enter/i,
  /Continue\?/i,
  /Allow\s+/i,
  /Approve/i,
];

export const TerminalPane: React.FC<TerminalPaneProps> = ({
  session,
  isActive,
  onStatusChange,
  onAutoTitle,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef<IPty | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const firstInputBufferRef = useRef<string>("");
  const hasAutoTitledRef = useRef<boolean>(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [restartCount, setRestartCount] = useState(0);

  const fitAndResizePty = useCallback(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    const container = containerRef.current;
    if (!term || !fitAddon || !container) return;
    if (container.clientWidth === 0 || container.clientHeight === 0) return;

    try {
      fitAddon.fit();
      if (ptyRef.current && term.cols > 0 && term.rows > 0) {
        ptyRef.current.resize(term.cols, term.rows);
      }
    } catch {
      // Ignore transient fit errors while hidden
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    setSpawnError(null);

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.22,
      scrollback: 10000,
      allowProposedApi: true,
      theme: {
        background: "#0b0e14",
        foreground: "#e6edf3",
        cursor: "#58a6ff",
        selectionBackground: "rgba(88, 166, 255, 0.28)",
        black: "#0b0e14",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    try {
      fitAddon.fit();
    } catch {
      // ignore if hidden at mount
    }

    const initialCols = Math.max(term.cols || 100, 40);
    const initialRows = Math.max(term.rows || 30, 12);

    let pty: IPty | null = null;
    let dataListener: { dispose: () => void } | null = null;
    let exitListener: { dispose: () => void } | null = null;
    let termInputDisposable: { dispose: () => void } | null = null;

    const handleLaunchFailure = (msg: string) => {
      if (cancelled) return;
      setSpawnError(msg);
      term.writeln(
        `\x1b[1;31m[Failed to launch "${session.command}"]\x1b[0m\r\n\x1b[33m${msg}\x1b[0m\r\n`
      );
      onStatusChange(session.id, "exited", -1);
    };

    invoke<ResolvedCommand>("resolve_cli_command", {
      command: session.command,
      args: session.args,
    })
      .then((resolved) => {
        if (cancelled) return;

        pty = spawn(resolved.program, resolved.args, {
          cols: initialCols,
          rows: initialRows,
          cwd: session.cwd || undefined,
        });
        ptyRef.current = pty;
        onStatusChange(session.id, "idle", null);

        // Catch asynchronous rejections from tauri-pty's internal _init promise
        const internalInit = (
          pty as unknown as { _init?: Promise<unknown> }
        )._init;
        if (internalInit && typeof internalInit.catch === "function") {
          internalInit.catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            handleLaunchFailure(msg);
          });
        }

        const decodeChunk = (raw: Uint8Array | number[] | string): string => {
          if (typeof raw === "string") return raw;
          const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
          return new TextDecoder().decode(bytes);
        };

        dataListener = pty.onData((data) => {
          const text = decodeChunk(data as Uint8Array | number[] | string);
          term.write(data);

          onStatusChange(session.id, "working");
          if (idleTimerRef.current) {
            window.clearTimeout(idleTimerRef.current);
          }

          const tail = text.slice(-300);
          const matchesPrompt = NEEDS_INPUT_PATTERNS.some((re) =>
            re.test(tail)
          );

          idleTimerRef.current = window.setTimeout(() => {
            onStatusChange(session.id, matchesPrompt ? "needs-input" : "idle");
          }, 900);
        });

        exitListener = pty.onExit(({ exitCode }) => {
          if (idleTimerRef.current) {
            window.clearTimeout(idleTimerRef.current);
          }
          term.writeln(
            `\r\n\x1b[33m[Process exited with code ${exitCode ?? 0}]\x1b[0m`
          );
          onStatusChange(session.id, "exited", exitCode ?? 0);
        });

        termInputDisposable = term.onData((input) => {
          try {
            pty?.write(input);
            if (!hasAutoTitledRef.current && onAutoTitle) {
              for (const ch of input) {
                if (ch === "\r" || ch === "\n") {
                  const candidate = firstInputBufferRef.current.trim();
                  if (candidate.length >= 2) {
                    hasAutoTitledRef.current = true;
                    onAutoTitle(session.id, candidate);
                  } else {
                    firstInputBufferRef.current = "";
                  }
                } else if (ch === "\x7f" || ch === "\b") {
                  firstInputBufferRef.current =
                    firstInputBufferRef.current.slice(0, -1);
                } else if (ch >= " " && ch <= "~") {
                  firstInputBufferRef.current += ch;
                }
              }
            }
          } catch (err) {
            console.error("Failed writing to PTY:", err);
          }
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        handleLaunchFailure(msg);
      });

    const resizeObserver = new ResizeObserver(() => {
      fitAndResizePty();
    });
    resizeObserver.observe(container);

    return () => {
      cancelled = true;
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
      }
      resizeObserver.disconnect();
      termInputDisposable?.dispose();
      dataListener?.dispose();
      exitListener?.dispose();
      try {
        pty?.kill();
      } catch {
        // Already exited
      }
      ptyRef.current = null;
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.command, session.cwd, restartCount]);

  useEffect(() => {
    if (isActive) {
      const raf = requestAnimationFrame(() => {
        fitAndResizePty();
        termRef.current?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [isActive, fitAndResizePty]);

  return (
    <div
      className={`terminal-pane-wrapper ${isActive ? "active" : "hidden"}`}
      aria-hidden={!isActive}
    >
      <div className="terminal-Subheader">
        <div className="terminal-meta">
          <span className={`status-dot status-${session.status}`} />
          <span className="terminal-cmd">
            {session.command}{" "}
            {session.args.length > 0 ? session.args.join(" ") : ""}
          </span>
          <span className="terminal-cwd" title={session.cwd}>
            cwd: {session.cwd}
          </span>
        </div>
        <div className="terminal-actions">
          {session.status === "exited" && (
            <button
              type="button"
              className="btn-secondary btn-xs"
              onClick={() => setRestartCount((n) => n + 1)}
            >
              Restart Process
            </button>
          )}
        </div>
      </div>

      {spawnError && (
        <div className="terminal-error-banner">
          <span>{spawnError}</span>
          <button
            type="button"
            className="btn-secondary btn-xs"
            onClick={() => setRestartCount((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      )}

      <div ref={containerRef} className="xterm-mount" />
    </div>
  );
};
