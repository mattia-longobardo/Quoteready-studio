"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { ArrowIcon, TrashIcon } from "@/components/icons";
import { responseMessage } from "@/lib/client-http";
import { formatDate } from "@/lib/format";
import { drawingLabel } from "@/lib/item-naming";
import {
  compareBySort,
  DEFAULT_SORT,
  matchesQuery,
  matchesSelection,
  MultiSelectFilter,
  sortIndicator,
  toggleSort,
  type SortField,
  type SortState,
} from "@/components/workspace-controls";
import { visibleParts } from "@quoteredy/core/parts";
import type {
  AuthState,
  DrawingTable,
  PlatformView,
  StoredPart,
  WorkspaceState,
} from "@quoteredy/core/types";

const STATUS_LABELS: Record<DrawingTable["status"], string> = {
  generating: "Generating",
  ready: "Ready",
  failed: "Failed",
};

/** Searchable part selector: an input that filters the uploaded parts. */
function PartPicker({
  parts,
  value,
  onChange,
}: {
  parts: StoredPart[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = parts.find((part) => part.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const filtered = parts.filter((part) =>
    matchesQuery(query, `${part.name} ${part.fileName} ${part.format}`, []),
  );

  return (
    <div className="part-picker" ref={rootRef}>
      <input
        aria-controls="part-picker-options"
        aria-expanded={open}
        aria-label="Search an uploaded part"
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        placeholder="Search an uploaded part…"
        role="combobox"
        value={
          open
            ? query
            : selected
              ? `${selected.name} (${selected.fileName})`
              : ""
        }
      />
      {open && (
        <div
          className="part-picker-menu"
          id="part-picker-options"
          role="listbox"
        >
          {filtered.length === 0 ? (
            <p>No part matches the search.</p>
          ) : (
            filtered.map((part) => (
              <button
                aria-selected={part.id === value}
                className={part.id === value ? "selected" : ""}
                key={part.id}
                onClick={() => {
                  onChange(part.id);
                  setOpen(false);
                }}
                role="option"
                type="button"
              >
                <strong>{part.name}</strong>
                <small>
                  {part.fileName} · {part.format.toUpperCase()}
                </small>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Read-only rendering of a generated datum + tolerance table. */
function DrawingTableContent({ drawing }: { drawing: DrawingTable }) {
  return (
    <>
      <div className="drawing-meta">
        <span>
          GENERAL TOLERANCE ·{" "}
          {drawing.generalTolerance || "ISO 2768-m (assumed)"}
        </span>
        <span>SOURCE · {drawing.fileName}</span>
      </div>
      <h3>Datum reference frame</h3>
      {drawing.datums.length === 0 ? (
        <p className="drawing-empty">No datums were proposed.</p>
      ) : (
        <table className="drawing-table">
          <thead>
            <tr>
              <th>Datum</th>
              <th>Feature</th>
              <th>Why the agent chose it</th>
            </tr>
          </thead>
          <tbody>
            {drawing.datums.map((datum) => (
              <tr key={datum.label}>
                <td className="drawing-datum">{datum.label}</td>
                <td>{datum.feature}</td>
                <td>{datum.reason || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Dimensions + geometric controls</h3>
      <table className="drawing-table">
        <thead>
          <tr>
            <th>Feature</th>
            <th>Nominal / characteristic</th>
            <th>Tolerance</th>
            <th>Datums</th>
            <th>Type</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {drawing.rows.map((row) => (
            <tr key={row.id}>
              <td>{row.feature}</td>
              <td>{row.nominal || "—"}</td>
              <td>{row.tolerance || "—"}</td>
              <td>{row.datums || "—"}</td>
              <td>{row.kind === "gdt" ? "GD&T" : "Dimension"}</td>
              <td>{row.note || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {drawing.notes.length > 0 && (
        <>
          <h3>Notes</h3>
          <ul className="drawing-notes">
            {drawing.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </>
      )}
      <p className="drawing-disclaimer">
        Datums and tolerances were proposed automatically by the Zoo agent from
        the CAD geometry. Review them before releasing a controlled drawing.
      </p>
    </>
  );
}

/** Interactive 3D pane of the drawing workbench (stored glTF conversion). */
function DrawingModelPane({ part }: { part: StoredPart }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    import("@google/model-viewer")
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError("The 3D viewer could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="workbench-model-missing">{error}</p>;
  if (!ready) return <p className="workbench-model-missing">Loading 3D…</p>;
  return (
    <model-viewer
      alt={`3D model of ${part.name}`}
      auto-rotate
      camera-controls
      shadow-intensity="1"
      src={`/api/parts/model?id=${encodeURIComponent(part.id)}`}
    />
  );
}

interface ChatMessage {
  role: "user" | "agent";
  text: string;
  failed?: boolean;
}

/**
 * Full drawing workbench: 3D part + drawing table side by side with a Zoo
 * agent chat that edits the table live, plus the PDF export.
 */
function DrawingWorkbench({
  drawing,
  part,
  onClose,
  refresh,
}: {
  drawing: DrawingTable;
  part: StoredPart | null;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, chatBusy]);

  async function send() {
    const message = chatInput.trim();
    if (!message || chatBusy) return;
    setMessages((current) => [...current, { role: "user", text: message }]);
    setChatInput("");
    setChatBusy(true);
    try {
      const response = await fetch("/api/drawings/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: drawing.id, message }),
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(
            response,
            "The Zoo agent could not update the drawing.",
          ),
        );
      const payload = (await response.json()) as { reply: string };
      setMessages((current) => [
        ...current,
        { role: "agent", text: payload.reply },
      ]);
      await refresh();
    } catch (cause) {
      setMessages((current) => [
        ...current,
        {
          role: "agent",
          failed: true,
          text:
            cause instanceof Error
              ? cause.message
              : "The Zoo agent could not update the drawing.",
        },
      ]);
    } finally {
      setChatBusy(false);
    }
  }

  return (
    <div
      className="document-viewer-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-label={`Drawing workbench for ${drawingLabel(drawing)}`}
        className="document-viewer drawing-workbench"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <strong>
            {drawingLabel(drawing)} · datums + tolerances ·{" "}
            {drawing.units || "mm"}
          </strong>
          <div className="workbench-header-actions">
            <a
              className="row-link"
              href={`/api/drawings/pdf?id=${encodeURIComponent(drawing.id)}`}
            >
              Download PDF
            </a>
            <button aria-label="Close drawing" onClick={onClose} type="button">
              ×
            </button>
          </div>
        </header>
        <div className="workbench-body">
          <div className="workbench-main">
            <div className="workbench-model">
              {part?.modelBlobKey ? (
                <DrawingModelPane part={part} />
              ) : (
                <p className="workbench-model-missing">
                  No 3D preview is stored for this part.
                </p>
              )}
            </div>
            <div className="workbench-table">
              <DrawingTableContent drawing={drawing} />
            </div>
          </div>
          <aside className="workbench-chat">
            <div className="chat-head">
              <strong>Zoo agent</strong>
              <small>Ask for changes — the table updates live</small>
            </div>
            <div aria-live="polite" className="chat-messages" ref={messagesRef}>
              <div className="chat-message agent">
                I generated this drawing table. Tell me what to change —
                tolerances, datums, extra controls or notes — and I will apply
                it directly.
              </div>
              {messages.map((message, index) => (
                <div
                  className={`chat-message ${message.role} ${
                    message.failed ? "failed" : ""
                  }`}
                  key={`${index}-${message.role}`}
                >
                  {message.text}
                </div>
              ))}
              {chatBusy && (
                <div className="chat-message agent pending">
                  Zookeeper is updating the drawing…
                </div>
              )}
            </div>
            <form
              className="chat-input"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <input
                aria-label="Message for the Zoo agent"
                disabled={chatBusy}
                maxLength={600}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder="e.g. Tighten the hole position to ⌀0.1 on A|B"
                value={chatInput}
              />
              <button disabled={chatBusy || !chatInput.trim()} type="submit">
                Send
              </button>
            </form>
          </aside>
        </div>
      </div>
    </div>
  );
}

export function DrawingsView({
  auth,
  workspace,
  refresh,
  onNavigate,
}: {
  auth: AuthState;
  workspace: WorkspaceState;
  refresh: () => Promise<void>;
  onNavigate: (view: PlatformView) => void;
}) {
  const [partId, setPartId] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const drawings = workspace.drawings;
  // Only parts whose CAD file is still archived can be detailed by the agent.
  // A part replaced by a newer namesake is not offered any more (its drawings
  // stay readable, and the visible part with that name is the new one).
  const detailableParts = useMemo(
    () =>
      visibleParts(workspace.parts).filter(
        (item) =>
          item.status !== "analyzing" && (item.cadBlobKey || item.reportId),
      ),
    [workspace.parts],
  );
  const generating = drawings.filter(
    (item) => item.status === "generating",
  ).length;

  // Generation runs server-side; poll while any drawing is pending so the
  // page stays live even after navigating away and back.
  useEffect(() => {
    if (generating === 0) return;
    const timer = setInterval(() => void refresh(), 4_000);
    return () => clearInterval(timer);
  }, [generating, refresh]);

  const filtered = useMemo(
    () =>
      drawings
        .filter(
          (item) =>
            matchesQuery(
              query,
              `${drawingLabel(item)} ${item.partName} ${item.fileName}`,
              [],
            ) && matchesSelection(statusFilter, item.status),
        )
        .sort((a, b) =>
          compareBySort(
            sort,
            {
              title: drawingLabel(a),
              updatedAt: a.updatedAt,
              statusKey: a.status,
            },
            {
              title: drawingLabel(b),
              updatedAt: b.updatedAt,
              statusKey: b.status,
            },
          ),
        ),
    [drawings, query, statusFilter, sort],
  );
  const openDrawing = drawings.find((item) => item.id === openId) ?? null;

  async function startGeneration() {
    if (!partId || starting) return;
    setStarting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/drawings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partId }),
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(
            response,
            "The drawing table could not be started.",
          ),
        );
      setNotice(
        "Zookeeper is measuring the part and choosing datums and tolerances. This runs in the background — the table appears here when it lands.",
      );
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The drawing table could not be started.",
      );
    } finally {
      setStarting(false);
    }
  }

  async function removeDrawing(id: string) {
    setBusyId(id);
    setError("");
    try {
      const response = await fetch(
        `/api/drawings?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "The drawing could not be deleted."),
        );
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The drawing could not be deleted.",
      );
    } finally {
      setBusyId(null);
    }
  }

  function sortButton(field: SortField, label: string) {
    return (
      <button
        className="sort-button"
        onClick={() => setSort((current) => toggleSort(current, field))}
        type="button"
      >
        {label} <i>{sortIndicator(sort, field)}</i>
      </button>
    );
  }

  if (!auth.authenticated) {
    return (
      <div className="connect-gate">
        <span className="gate-mark">Z</span>
        <h2>Connect Zoo to generate drawing tables</h2>
        <p>
          The Zoo agent picks datums and tolerances automatically from your
          uploaded CAD geometry.
        </p>
        <button
          className="primary-button"
          onClick={() => window.location.assign("/api/auth/login")}
          type="button"
        >
          Connect Zoo <ArrowIcon />
        </button>
      </div>
    );
  }

  return (
    <div className="standard-view">
      <div className="view-title">
        <div>
          <span>AUTOMATED DRAWING TABLES</span>
          <h1>Datums and tolerances, chosen by Zookeeper.</h1>
          <p>
            Pick an uploaded part and the Zoo agent inspects its geometry,
            selects the datum reference frame and proposes the dimensional and
            geometric tolerances for the drawing.
          </p>
        </div>
        <button
          className="secondary-button"
          onClick={() => onNavigate("parts")}
          type="button"
        >
          Manage parts
        </button>
      </div>
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="upload-success" role="status">
          {notice}
        </div>
      )}
      <section className="technical-panel drawing-generator">
        <div className="panel-heading">
          <div>
            <span className="step-number">⌁</span>
            <div>
              <small>ZOO AGENT</small>
              <h2>Generate a drawing table</h2>
            </div>
          </div>
          <span>DATUMS + GD&T</span>
        </div>
        <div className="drawing-generator-grid">
          <div className="field">
            <span>Part</span>
            <PartPicker
              onChange={setPartId}
              parts={detailableParts}
              value={partId}
            />
          </div>
          <button
            className="primary-button"
            disabled={!partId || starting}
            onClick={() => void startGeneration()}
            type="button"
          >
            {starting ? "Starting…" : "Choose datums + tolerances"}
            <ArrowIcon />
          </button>
        </div>
        {detailableParts.length === 0 && (
          <p className="drawing-empty">
            No archived parts yet — upload and analyse a CAD file first.
          </p>
        )}
      </section>
      <section className="technical-panel report-library">
        <div className="library-toolbar">
          <label>
            <span>Search drawings</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Part or file…"
              value={query}
            />
          </label>
          <MultiSelectFilter
            label="Status"
            onChange={setStatusFilter}
            options={[
              { value: "ready", label: "Ready" },
              { value: "generating", label: "Generating" },
              { value: "failed", label: "Failed" },
            ]}
            selected={statusFilter}
          />
          {generating > 0 && (
            <span className="kcl-chip generating">
              {generating} generating…
            </span>
          )}
          <span>{filtered.length} drawings</span>
        </div>
        {filtered.length === 0 ? (
          <div className="compact-empty">
            <p>
              {drawings.length === 0
                ? "No drawing tables yet. Select a part above to generate the first one."
                : "No drawing matches the current filter."}
            </p>
          </div>
        ) : (
          <>
            <div className="report-list-head drawings-head">
              <span>{sortButton("name", "Drawing")}</span>
              <span>Datums</span>
              <span>{sortButton("status", "Status")}</span>
              <span>{sortButton("updated", "Updated")}</span>
              <span>Actions</span>
            </div>
            {filtered.map((item) => {
              const busy = busyId === item.id;
              return (
                <article className="report-list-row drawings-row" key={item.id}>
                  <div>
                    <span
                      className={`report-status ${
                        item.status === "ready"
                          ? "ready"
                          : item.status === "failed"
                            ? "blocked"
                            : "review"
                      }`}
                    />
                    <div>
                      <strong>{drawingLabel(item)}</strong>
                      <small>
                        {item.status === "failed"
                          ? (item.error ?? "Generation failed.")
                          : item.status === "generating"
                            ? "Zookeeper is choosing datums and tolerances…"
                            : `${item.rows.length} rows · ${item.fileName}`}
                      </small>
                    </div>
                  </div>
                  <span className="drawing-datums">
                    {item.datums.length > 0
                      ? item.datums.map((datum) => datum.label).join(" · ")
                      : "—"}
                  </span>
                  {item.status === "generating" ? (
                    <span className="kcl-chip generating">Generating…</span>
                  ) : (
                    <span
                      className={`part-status ${
                        item.status === "failed" ? "failed" : "analyzed"
                      }`}
                    >
                      {STATUS_LABELS[item.status]}
                    </span>
                  )}
                  <time>
                    {formatDate(
                      item.updatedAt,
                      workspace.settings.timezone,
                      true,
                    )}
                  </time>
                  <div>
                    {item.status === "ready" && (
                      <button
                        disabled={busy}
                        onClick={() => setOpenId(item.id)}
                        type="button"
                      >
                        Open
                      </button>
                    )}
                    {item.status === "ready" && (
                      <a
                        className="row-link"
                        href={`/api/drawings/pdf?id=${encodeURIComponent(item.id)}`}
                      >
                        PDF
                      </a>
                    )}
                    <button
                      disabled={busy || item.status === "generating"}
                      onClick={() => void removeDrawing(item.id)}
                      type="button"
                    >
                      <TrashIcon /> Delete
                    </button>
                  </div>
                </article>
              );
            })}
          </>
        )}
      </section>
      {openDrawing && (
        <DrawingWorkbench
          drawing={openDrawing}
          key={openDrawing.id}
          onClose={() => setOpenId(null)}
          part={
            workspace.parts.find((item) => item.id === openDrawing.partId) ??
            null
          }
          refresh={refresh}
        />
      )}
    </div>
  );
}
