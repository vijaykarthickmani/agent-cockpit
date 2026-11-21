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
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");

  const handleRenameSession = useCallback((id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title: trimmed } : s))
    );
  }, []);

  const handleAutoTitle = useCallback((id: string, firstLine: string) => {
    const cleaned = firstLine.replace(/\s+/g, " ").trim().slice(0, 26);
    if (!cleaned) return;
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        const isDefaultPresetName = DEFAULT_PRESETS.some(
          (p) => p.label === s.title
        );
        if (!isDefaultPresetName) return s;
        return { ...s, title: cleaned };
      })
    );
  }, []);

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

  useEffect(() => {
    let mounted = true;
    invoke<string>("get_default_cwd")
      .then((cwd) => {
        if (!mounted) return;
        setDefaultCwd(cwd);
        registerCwd(cwd);
        const shellPreset =
          DEFAULT_PRESETS.find((p) => p.id === "powershell") ??
          DEFAULT_PRESETS[0];
        const initialId = createId();
        setSessions([
          {
            id: initialId,
            title: shellPreset.label,
            command: shellPreset.command,
            args: shellPreset.args,
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
        const shellPreset =
          DEFAULT_PRESETS.find((p) => p.id === "powershell") ??
          DEFAULT_PRESETS[0];
        const initialId = createId();
        setSessions([
          {
            id: initialId,
            title: shellPreset.label,
            command: shellPreset.command,
            args: shellPreset.args,
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
        <div className="rail-header">
          <span className="brand-label">Cockpit</span>
          <button
            type="button"
            className="btn-plus"
            onClick={() => openModalWithPreset()}
            title="New Session (Ctrl+Shift+N)"
          >
            +
          </button>
        </div>

        <div className="quick-bar">
          {DEFAULT_PRESETS.slice(0, 4).map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="quick-chip"
              onClick={() => openModalWithPreset(preset)}
              title={preset.label}
            >
              {preset.badge}
            </button>
          ))}
        </div>

        <div className="session-list">
          {sessions.map((s) => {
            const isSelected = s.id === activeSessionId;
            const folderName =
              s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.cwd;
            return (
              <div
                key={s.id}
                className={`session-row ${isSelected ? "selected" : ""}`}
                onClick={() => setActiveSessionId(s.id)}
                role="button"
                tabIndex={0}
                title={`${s.title} — ${s.cwd}`}
              >
                <span className={`status-indicator status-${s.status}`} />
                {editingSessionId === s.id ? (
                  <input
                    type="text"
                    className="session-rename-input"
                    value={editingTitle}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={() => {
                      handleRenameSession(s.id, editingTitle);
                      setEditingSessionId(null);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        handleRenameSession(s.id, editingTitle);
                        setEditingSessionId(null);
                      } else if (e.key === "Escape") {
                        setEditingSessionId(null);
                      }
                    }}
                  />
                ) : (
                  <span
                    className="session-title"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditingSessionId(s.id);
                      setEditingTitle(s.title);
                    }}
                    title="Double-click to rename"
                  >
                    {s.title}
                  </span>
                )}
                <span className="session-folder">{folderName}</span>
                <button
                  type="button"
                  className="session-close-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingSessionId(s.id);
                    setEditingTitle(s.title);
                  }}
                  title="Rename"
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="session-close-btn"
                  onClick={(e) => handleCloseSession(s.id, e)}
                  title="Close"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      <main className="main-stage">
        {sessions.length === 0 ? (
          <div className="empty-stage">
            <button
              type="button"
              className="btn-primary"
              onClick={() => openModalWithPreset()}
            >
              + New Session
            </button>
          </div>
        ) : (
          sessions.map((session) => (
            <TerminalPane
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onStatusChange={handleStatusChange}
              onAutoTitle={handleAutoTitle}
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
