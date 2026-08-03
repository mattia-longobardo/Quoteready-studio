"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { ArrowIcon, TrashIcon } from "@/components/icons";

// <model-viewer> is a custom element registered by @google/model-viewer,
// which is imported lazily when the preview dialog first opens.
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        src?: string;
        alt?: string;
        "camera-controls"?: boolean;
        "auto-rotate"?: boolean;
        "shadow-intensity"?: string;
        "interaction-prompt"?: string;
        exposure?: string;
      };
    }
  }
}
import { OverwritePartDialog } from "@/components/overwrite-part-dialog";
import { responseMessage } from "@/lib/client-http";
import { formatDate } from "@/lib/format";
import { readPartNameConflict } from "@/lib/part-names";
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
import { findPartByName, visibleParts } from "@quoteredy/core/parts";
import type {
  AuthState,
  PlatformView,
  StoredPart,
  WorkspaceState,
} from "@quoteredy/core/types";

const STATUS_LABELS: Record<StoredPart["status"], string> = {
  uploaded: "Uploaded",
  analyzing: "Analyzing",
  analyzed: "Analyzed",
  failed: "Failed",
};

function megabytes(sizeBytes: number): string {
  return `${(sizeBytes / 1_048_576).toFixed(2)} MB`;
}

/** Interactive 3D preview of the part's stored glTF conversion. */
function ModelPreview({
  part,
  onClose,
}: {
  part: StoredPart;
  onClose: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const viewerRef = useRef<HTMLElement | null>(null);

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

  // Surface load/render failures instead of leaving a silent empty canvas.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const onError = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string }>).detail;
      setError(
        detail?.type === "webglcontexterror"
          ? "The browser could not create a WebGL context for the 3D preview."
          : "The 3D model could not be loaded. Reopen the preview to retry.",
      );
    };
    viewer.addEventListener("error", onError);
    return () => viewer.removeEventListener("error", onError);
  }, [ready]);

  return (
    <div
      className="document-viewer-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-label={`3D preview of ${part.name}`}
        className="document-viewer model-preview"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <strong>
            {part.name} · 3D preview ({part.format.toUpperCase()} → glTF)
          </strong>
          <button aria-label="Close preview" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <div className="model-preview-body">
          {error ? (
            <div className="error-message" role="alert">
              {error}
            </div>
          ) : ready ? (
            <model-viewer
              alt={`3D model of ${part.name}`}
              auto-rotate
              camera-controls
              ref={viewerRef}
              shadow-intensity="1"
              src={`/api/parts/model?id=${encodeURIComponent(part.id)}`}
            />
          ) : (
            <p className="model-preview-loading">Loading the 3D viewer…</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Rename form for one part; the name is the only editable field. */
function RenamePartDialog({
  part,
  value,
  error,
  busy,
  onChange,
  onSubmit,
  onClose,
}: {
  part: StoredPart;
  value: string;
  error: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="document-viewer-backdrop"
      onClick={busy ? undefined : onClose}
      role="presentation"
    >
      <form
        aria-label={`Rename the part ${part.name}`}
        className="confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        role="dialog"
      >
        <header>
          <strong>Rename “{part.name}”</strong>
          <button
            aria-label="Cancel the rename"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="confirm-form">
          <label className="field wide">
            <span>Part name</span>
            <input
              autoFocus
              maxLength={140}
              onChange={(event) => onChange(event.target.value)}
              placeholder="BR-042 sensor bracket"
              value={value}
            />
            <small>
              {part.fileName} · {part.format.toUpperCase()}
            </small>
          </label>
          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="confirm-actions">
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? "Saving…" : "Save name"}
          </button>
          <button
            className="text-button"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

export function PartsView({
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
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [previewPartId, setPreviewPartId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renaming, setRenaming] = useState(false);
  // Name of the part the rename would overwrite, while the user decides.
  const [overwriteName, setOverwriteName] = useState<string | null>(null);

  // Parts a newer namesake replaced stay in storage so the results, drawings
  // and reports made from them keep resolving, but they are no longer part of
  // the workspace the user manages here.
  const parts = useMemo(() => visibleParts(workspace.parts), [workspace.parts]);
  const analyzing = parts.filter((item) => item.status === "analyzing").length;

  // Analyses run server-side, so poll while any part is still in flight.
  useEffect(() => {
    if (analyzing === 0) return;
    const timer = setInterval(() => void refresh(), 4_000);
    return () => clearInterval(timer);
  }, [analyzing, refresh]);

  const filtered = useMemo(
    () =>
      parts
        .filter(
          (item) =>
            matchesQuery(
              query,
              `${item.name} ${item.fileName} ${item.format}`,
              [],
            ) && matchesSelection(statusFilter, item.status),
        )
        .sort((a, b) =>
          compareBySort(
            sort,
            { title: a.name, updatedAt: a.updatedAt, statusKey: a.status },
            { title: b.name, updatedAt: b.updatedAt, statusKey: b.status },
          ),
        ),
    [parts, query, statusFilter, sort],
  );
  const previewPart = parts.find((item) => item.id === previewPartId) ?? null;

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

  const renamePart = parts.find((item) => item.id === renameId) ?? null;

  function closeRename() {
    setRenameId(null);
    setRenameValue("");
    setRenameError("");
    setOverwriteName(null);
  }

  /** Persist the new name; `overwrite` carries the user's confirmation. */
  async function submitRename(part: StoredPart, overwrite: boolean) {
    const name = renameValue.trim();
    if (!name) {
      setRenameError("Part name must contain 1 to 140 characters.");
      return;
    }
    if (name === part.name) {
      closeRename();
      return;
    }
    if (!overwrite) {
      // The rename never collides with the part being renamed, so only a
      // different visible part with that name needs a confirmation.
      const clash = findPartByName(parts, name, { excludeId: part.id });
      if (clash) {
        setOverwriteName(clash.name);
        return;
      }
    }
    setRenaming(true);
    setRenameError("");
    try {
      const response = await fetch("/api/parts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: part.id,
          name,
          ...(overwrite ? { overwrite: true } : {}),
        }),
      });
      if (!response.ok) {
        // The workspace list can be stale (another tab, a finished analysis):
        // the server's 409 raises the same confirmation.
        const conflict = await readPartNameConflict(response);
        if (conflict) {
          setOverwriteName(conflict.partName);
          return;
        }
        throw new Error(
          await responseMessage(response, "The part could not be renamed."),
        );
      }
      await refresh();
      closeRename();
    } catch (cause) {
      setOverwriteName(null);
      setRenameError(
        cause instanceof Error
          ? cause.message
          : "The part could not be renamed.",
      );
    } finally {
      setRenaming(false);
    }
  }

  async function removePart(id: string) {
    setBusyId(id);
    setError("");
    try {
      const response = await fetch(`/api/parts?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, "The part could not be removed."),
        );
      }
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The part could not be removed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  if (!auth.authenticated) {
    return (
      <div className="connect-gate">
        <span className="gate-mark">Z</span>
        <h2>Connect Zoo to see your uploaded parts</h2>
        <p>
          Every CAD file you upload is tracked here with its analysis state and
          3D preview.
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
          <span>UPLOADED GEOMETRY</span>
          <h1>Every part you uploaded, in one place.</h1>
          <p>
            Watch live analyses, inspect the 3D preview Zoo derived from each
            CAD file, and jump straight to the result it produced.
          </p>
        </div>
        <button
          className="secondary-button"
          onClick={() => onNavigate("planner")}
          type="button"
        >
          Upload a part
        </button>
      </div>
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      <section className="technical-panel report-library">
        <div className="library-toolbar">
          <label>
            <span>Search parts</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, file or format…"
              value={query}
            />
          </label>
          <MultiSelectFilter
            label="Status"
            onChange={setStatusFilter}
            options={[
              { value: "uploaded", label: "Uploaded" },
              { value: "analyzing", label: "Analyzing" },
              { value: "analyzed", label: "Analyzed" },
              { value: "failed", label: "Failed" },
            ]}
            selected={statusFilter}
          />
          {analyzing > 0 && (
            <span className="part-status analyzing">
              <i /> {analyzing} in analysis
            </span>
          )}
          <span>{filtered.length} parts</span>
        </div>
        {filtered.length === 0 ? (
          <div className="compact-empty">
            <p>
              {parts.length === 0
                ? "No parts yet. Upload a CAD file from the planner or the Zoo library."
                : "No part matches the current filter."}
            </p>
            <button onClick={() => onNavigate("planner")} type="button">
              Open planner <ArrowIcon />
            </button>
          </div>
        ) : (
          <>
            <div className="report-list-head parts-head">
              <span>{sortButton("name", "Part")}</span>
              <span>{sortButton("status", "Status")}</span>
              <span>{sortButton("updated", "Updated")}</span>
              <span>Actions</span>
            </div>
            {filtered.map((item) => {
              const busy = busyId === item.id;
              return (
                <article className="report-list-row parts-row" key={item.id}>
                  <div>
                    <span
                      className={`report-status ${
                        item.status === "failed"
                          ? "blocked"
                          : item.status === "analyzed"
                            ? "ready"
                            : "review"
                      }`}
                    />
                    <div>
                      <strong>{item.name}</strong>
                      <small>
                        {item.fileName} · {item.format.toUpperCase()} ·{" "}
                        {megabytes(item.sizeBytes)}
                      </small>
                    </div>
                  </div>
                  <span className={`part-status ${item.status}`}>
                    {item.status === "analyzing" && <i />}
                    {STATUS_LABELS[item.status]}
                  </span>
                  <time>
                    {formatDate(
                      item.updatedAt,
                      workspace.settings.timezone,
                      true,
                    )}
                  </time>
                  <div>
                    {item.modelBlobKey && (
                      <button
                        disabled={busy}
                        onClick={() => setPreviewPartId(item.id)}
                        type="button"
                      >
                        3D view
                      </button>
                    )}
                    {item.reportId && (
                      <button
                        disabled={busy}
                        onClick={() => onNavigate("results")}
                        type="button"
                      >
                        Result
                      </button>
                    )}
                    <button
                      disabled={busy}
                      onClick={() => {
                        setRenameId(item.id);
                        setRenameValue(item.name);
                        setRenameError("");
                        setOverwriteName(null);
                      }}
                      type="button"
                    >
                      Rename
                    </button>
                    <button
                      disabled={busy || item.status === "analyzing"}
                      onClick={() => void removePart(item.id)}
                      type="button"
                    >
                      <TrashIcon /> Remove
                    </button>
                  </div>
                </article>
              );
            })}
          </>
        )}
      </section>
      {previewPart && (
        <ModelPreview
          key={previewPart.id}
          onClose={() => setPreviewPartId(null)}
          part={previewPart}
        />
      )}
      {renamePart && !overwriteName && (
        <RenamePartDialog
          busy={renaming}
          error={renameError}
          key={renamePart.id}
          onChange={setRenameValue}
          onClose={closeRename}
          onSubmit={() => void submitRename(renamePart, false)}
          part={renamePart}
          value={renameValue}
        />
      )}
      {renamePart && overwriteName && (
        <OverwritePartDialog
          busy={renaming}
          busyLabel="Renaming…"
          cancelLabel="Back — change the name"
          confirmLabel="Overwrite the existing part"
          // Cancelling returns to the rename field instead of dropping the
          // edit, so the user can just pick another name.
          onCancel={() => setOverwriteName(null)}
          onConfirm={() => void submitRename(renamePart, true)}
          partName={overwriteName}
        />
      )}
    </div>
  );
}
