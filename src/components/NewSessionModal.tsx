import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { CliPreset, DEFAULT_PRESETS } from "../types/session";

interface NewSessionModalProps {
  isOpen: boolean;
  defaultCwd: string;
  recentCwds: string[];
  initialPreset?: CliPreset | null;
  onClose: () => void;
  onCreateSession: (params: {
    title: string;
    command: string;
    args: string[];
    cwd: string;
  }) => void;
}

function parseArgsString(raw: string): string[] {
  const matches = raw.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!matches) return [];
  return matches.map((token) => token.replace(/^"(.*)"$/, "$1"));
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  isOpen,
  defaultCwd,
  recentCwds,
  initialPreset,
  onClose,
  onCreateSession,
}) => {
  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    initialPreset?.id ?? DEFAULT_PRESETS[0].id
  );
  const [title, setTitle] = useState<string>(
    initialPreset?.label ?? DEFAULT_PRESETS[0].label
  );
  const [command, setCommand] = useState<string>(
    initialPreset?.command ?? DEFAULT_PRESETS[0].command
  );
  const [argsText, setArgsText] = useState<string>(
    (initialPreset?.args ?? DEFAULT_PRESETS[0].args).join(" ")
  );
  const [cwd, setCwd] = useState<string>(defaultCwd);
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen) return;
    const preset = initialPreset ?? DEFAULT_PRESETS[0];
    setSelectedPresetId(preset.id);
    setTitle(preset.label);
    setCommand(preset.command);
    setArgsText(preset.args.join(" "));
    setCwd(defaultCwd);
    setCwdError(null);
  }, [isOpen, initialPreset, defaultCwd]);

  if (!isOpen) return null;

  const handleSelectPreset = (preset: CliPreset) => {
    setSelectedPresetId(preset.id);
    setTitle(preset.label);
    setCommand(preset.command);
    setArgsText(preset.args.join(" "));
  };

  const handleSelectCustom = () => {
    setSelectedPresetId("custom");
    if (!title || DEFAULT_PRESETS.some((p) => p.label === title)) {
      setTitle("Custom Agent");
    }
  };

  const handleBrowseFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: cwd || defaultCwd || undefined,
        title: "Select Working Directory (cwd) for Session",
      });
      if (typeof selected === "string" && selected.trim().length > 0) {
        setCwd(selected);
        setCwdError(null);
      }
    } catch (err) {
      console.error("Folder picker error:", err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedCmd = command.trim();
    const trimmedCwd = cwd.trim();
    if (!trimmedCmd) return;

    setIsValidating(true);
    setCwdError(null);

    try {
      const normalizedCwd = await invoke<string>("validate_directory", {
        path: trimmedCwd,
      });
      onCreateSession({
        title: title.trim() || trimmedCmd,
        command: trimmedCmd,
        args: parseArgsString(argsText.trim()),
        cwd: normalizedCwd,
      });
      onClose();
    } catch (err) {
      setCwdError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-header">
          <h2 id="modal-title">Launch CLI Session</h2>
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-form">
          <div className="form-group">
            <label>Preset or Custom CLI</label>
            <div className="preset-grid">
              {DEFAULT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`preset-pill ${
                    selectedPresetId === preset.id ? "selected" : ""
                  }`}
                  onClick={() => handleSelectPreset(preset)}
                >
                  <span className="preset-badge">{preset.badge}</span>
                  <span>{preset.label}</span>
                </button>
              ))}
              <button
                type="button"
                className={`preset-pill ${
                  selectedPresetId === "custom" ? "selected" : ""
                }`}
                onClick={handleSelectCustom}
              >
                <span className="preset-badge">⌘</span>
                <span>Custom Command</span>
              </button>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="session-cwd">Working Directory (cwd)</label>
            <div className="cwd-input-row">
              <input
                id="session-cwd"
                type="text"
                value={cwd}
                onChange={(e) => {
                  setCwd(e.target.value);
                  setCwdError(null);
                }}
                placeholder="D:\Thulir Inc\App Development\my-project"
                required
              />
              <button
                type="button"
                className="btn-secondary"
                onClick={handleBrowseFolder}
              >
                Browse…
              </button>
            </div>
            {cwdError && <p className="field-error">{cwdError}</p>}
            {recentCwds.length > 0 && (
              <div className="recent-cwds">
                <span className="recent-label">Recent:</span>
                {recentCwds.map((path) => (
                  <button
                    key={path}
                    type="button"
                    className="recent-cwd-chip"
                    onClick={() => {
                      setCwd(path);
                      setCwdError(null);
                    }}
                    title={path}
                  >
                    {path.split(/[\\/]/).filter(Boolean).slice(-2).join("/")}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="form-row-two">
            <div className="form-group">
              <label htmlFor="session-title">Session Title</label>
              <input
                id="session-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Claude — Auth Refactor"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="session-command">Command / Binary</label>
              <input
                id="session-command"
                type="text"
                value={command}
                onChange={(e) => {
                  setCommand(e.target.value);
                  setSelectedPresetId("custom");
                }}
                placeholder="e.g. claude, codex, gemini, powershell.exe"
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="session-args">
              Arguments <span className="label-optional">(optional)</span>
            </label>
            <input
              id="session-args"
              type="text"
              value={argsText}
              onChange={(e) => {
                setArgsText(e.target.value);
                setSelectedPresetId("custom");
              }}
              placeholder='e.g. -NoLogo or --model claude-sonnet-4-20250514'
            />
          </div>

          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={isValidating || !command.trim()}
            >
              {isValidating ? "Validating…" : "Launch Session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
