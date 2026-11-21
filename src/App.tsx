import React, { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CliPreset,
  DEFAULT_PRESETS,
  RuntimeStatus,
  TerminalSession,
} from "./types/session";
import { TerminalPane } from "./components/TerminalPane";
import { NewSessionModal } from "./components/NewSessionModal";
import "./App.css";

function createId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

export const App: React.FC = () => {
  const [defaultCwd, setDefaultCwd] = useState<string>("");
  const [recentCwds, setRecentCwds] = useState<string[]>([]);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [modalInitialPreset, setModalInitialPreset] =
    useState<CliPreset | null>(null);

  const registerCwd = useCallback((cwd: string) => {
    if (!cwd) return;
    setRecentCwds((prev) => {
      const filtered = prev.filter(
        (item) => item.toLowerCase() !== cwd.toLowerCase()
      );
      return [cwd, ...filtered].slice(0, 5);
    });
  }, []);

  const addSession = useCallback(
    (params: {
      title: string;
      command: string;
      args: string[];
      cwd: string;
    }) => {
      const id = createId();
      const newSession: TerminalSession = {
        id,
        title: params.title,
        command: params.command,
        args: params.args,
        cwd: params.cwd,
        status: "idle",
        createdAt: Date.now(),
      };
      setSessions((prev) => [...prev, newSession]);
      setActiveSessionId(id);
      registerCwd(params.cwd);
    },
    [registerCwd]
  );

  // Boot initial PowerShell session in default working directory on startup
  useEffect(() => {
    let mounted = true;
    invoke<string>("get_default_cwd")
      .then((cwd) => {
        if (!mounted) return;
        setDefaultCwd(cwd);
        registerCwd(cwd);
        const initialPreset = DEFAULT_PRESETS[0];
        const initialId = createId();
        setSessions([
          {
            id: initialId,
            title: initialPreset.label,
            command: initialPreset.command,
            args: initialPreset.args,
            cwd,
            status: "idle",
            createdAt: Date.now(),
          },
        ]);
        setActiveSessionId(initialId);
      })
      .catch(() => {
        if (!mounted) return;
        const fallbackCwd = "D:\\Thulir Inc";
        setDefaultCwd(fallbackCwd);
        const initialPreset = DEFAULT_PRESETS[0];
        const initialId = createId();
        setSessions([
          {
            id: initialId,
            title: initialPreset.label,
            command: initialPreset.command,
            args: initialPreset.args,
            cwd: fallbackCwd,
            status: "idle",
            createdAt: Date.now(),
          },
        ]);
        setActiveSessionId(initialId);
      });
    return () => {
      mounted = false;
    };
  }, [registerCwd]);

  const handleStatusChange = useCallback(
    (id: string, status: RuntimeStatus, exitCode?: number | null) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                status,
                exitCode: exitCode !== undefined ? exitCode : s.exitCode,
              }
            : s
        )
      );
    },
    []
  );

  const handleCloseSession = useCallback(
    (id: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== id);
        if (activeSessionId === id) {
          setActiveSessionId(
            remaining.length > 0 ? remaining[remaining.length - 1].id : null
          );
        }
        return remaining;
      });
    },
    [activeSessionId]
  );

  const openModalWithPreset = useCallback((preset?: CliPreset) => {
    setModalInitialPreset(preset ?? null);
    setIsModalOpen(true);
  }, []);

  // Keyboard shortcuts: Ctrl/Cmd + 1..9 to switch sessions, Ctrl/Cmd + N for new session modal
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;

      if (e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < sessions.length) {
          e.preventDefault();
          setActiveSessionId(sessions[idx].id);
        }
      } else if (e.key.toLowerCase() === "n" && e.shiftKey) {
        e.preventDefault();
        openModalWithPreset();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessions, openModalWithPreset]);

  const activeSession =
    sessions.find((s) => s.id === activeSessionId) ?? null;

  return (
    <div className="cockpit-shell">
      <aside className="left-rail">
        <div className="rail-brand">
          <div className="brand-title">
            <span className="brand-dot" />
            <span>Agent Cockpit</span>
          </div>
          <button
            type="button"
            className="btn-primary btn-new-session"
            onClick={() => openModalWithPreset()}
            title="Launch Session with Working Directory & Custom Command (Ctrl+Shift+N)"
          >
            + New Session…
          </button>
        </div>

        <div className="rail-section-label">Quick Spawn (Pick CWD)</div>
        <div className="quick-preset-row">
          {DEFAULT_PRESETS.slice(0, 4).map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="quick-preset-btn"
              onClick={() => openModalWithPreset(preset)}
              title={`Configure & launch ${preset.label}`}
            >
              <span className="quick-badge">{preset.badge}</span>
              <span className="quick-name">{preset.label.split(" ")[0]}</span>
            </button>
          ))}
        </div>

        <div className="rail-section-label">
          Active Sessions ({sessions.length})
        </div>
        <div className="session-list">
          {sessions.map((s, index) => {
            const isSelected = s.id === activeSessionId;
            const folderName =
              s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.cwd;
            return (
              <div
                key={s.id}
                className={`session-item ${isSelected ? "selected" : ""}`}
                onClick={() => setActiveSessionId(s.id)}
                role="button"
                tabIndex={0}
              >
                <div className="session-item-top">
                  <span
                    className={`status-indicator status-${s.status}`}
                    title={`Status: ${s.status}`}
                  />
                  <span className="session-title">{s.title}</span>
                  {index < 9 && (
                    <span className="shortcut-hint">^{index + 1}</span>
                  )}
                  <button
                    type="button"
                    className="session-close-btn"
                    onClick={(e) => handleCloseSession(s.id, e)}
                    title="Kill PTY & Close Session"
                  >
                    ✕
                  </button>
                </div>
                <div className="session-item-bottom">
                  <span className="session-folder" title={s.cwd}>
                    📁 {folderName}
                  </span>
                  <span className={`session-status-badge badge-${s.status}`}>
                    {s.status}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <main className="main-stage">
        {sessions.length === 0 ? (
          <div className="empty-stage">
            <h2>No Active Terminal Sessions</h2>
            <p>
              Launch a PowerShell, Claude Code, Codex, Gemini, or custom CLI
              session pointed at any project folder.
            </p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => openModalWithPreset()}
            >
              + Launch Session with Working Directory
            </button>
          </div>
        ) : (
          sessions.map((session) => (
            <TerminalPane
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onStatusChange={handleStatusChange}
            />
          ))
        )}
      </main>

      <NewSessionModal
        isOpen={isModalOpen}
        defaultCwd={activeSession?.cwd || defaultCwd}
        recentCwds={recentCwds}
        initialPreset={modalInitialPreset}
        onClose={() => setIsModalOpen(false)}
        onCreateSession={addSession}
      />
    </div>
  );
};

export default App;
