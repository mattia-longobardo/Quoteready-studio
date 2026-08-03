"use client";

import { useEffect, useMemo, useState } from "react";

import {
  ArchiveIcon,
  ArrowIcon,
  FolderIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/icons";
import { responseMessage } from "@/lib/client-http";
import { formatDate } from "@/lib/format";
import { documentLabel } from "@/lib/item-naming";
import {
  collectTags,
  compareBySort,
  DEFAULT_SORT,
  matchesQuery,
  matchesSelection,
  matchesTagSelection,
  MultiSelectFilter,
  sortIndicator,
  TagEditor,
  toggleSort,
  type SortField,
  type SortState,
} from "@/components/workspace-controls";
import type {
  AuthState,
  PlatformView,
  ReportDocumentSummary,
  WorkspaceState,
} from "@quoteredy/core/types";

const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  ready: "Ready",
  generating: "Generating",
  failed: "Failed",
};

type Scope = "active" | "archived" | "trash";

function inScope(item: ReportDocumentSummary, scope: Scope): boolean {
  if (scope === "trash") return Boolean(item.trashedAt);
  if (scope === "archived") return Boolean(item.archivedAt && !item.trashedAt);
  return Boolean(!item.archivedAt && !item.trashedAt);
}

export function DocumentsView({
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
  const [scope, setScope] = useState<Scope>("active");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [viewer, setViewer] = useState<{
    title: string;
    html: string;
  } | null>(null);

  const settings = workspace.settings;
  const availableTags = useMemo(
    () => collectTags(workspace.documents),
    [workspace.documents],
  );
  const documents = useMemo(
    () =>
      workspace.documents
        .filter((item) => inScope(item, scope))
        .filter(
          (item) => folderId === null || (item.folderId ?? null) === folderId,
        )
        .filter((item) =>
          matchesQuery(
            query,
            `${documentLabel(item)} ${item.title}`,
            item.tags,
          ),
        )
        .filter((item) => matchesSelection(statusFilter, item.status))
        .filter((item) => matchesTagSelection(tagFilter, item.tags))
        .sort((a, b) =>
          compareBySort(
            sort,
            { ...a, title: documentLabel(a), statusKey: a.status },
            { ...b, title: documentLabel(b), statusKey: b.status },
          ),
        ),
    [
      workspace.documents,
      scope,
      folderId,
      query,
      sort,
      statusFilter,
      tagFilter,
    ],
  );
  const trashCount = workspace.documents.filter((item) =>
    inScope(item, "trash"),
  ).length;
  const generatingCount = workspace.documents.filter(
    (item) => item.status === "generating",
  ).length;

  // The AI writes reports server-side; poll while any is pending so the page
  // shows live progress even after navigating away and back.
  useEffect(() => {
    if (generatingCount === 0) return;
    const timer = setInterval(() => void refresh(), 4_000);
    return () => clearInterval(timer);
  }, [generatingCount, refresh]);

  async function retryGeneration(item: ReportDocumentSummary) {
    if (!item.resultId) return;
    setBusyId(item.id);
    setError("");
    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId: item.resultId }),
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "Report generation failed."),
        );
      // The failed attempt is replaced by the new run's document.
      await fetch("/api/documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, trashedAt: "now" }),
      }).catch(() => undefined);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Report generation failed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function mutate(id: string, changes: Record<string, unknown>) {
    setBusyId(id);
    setError("");
    try {
      const response = await fetch("/api/documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...changes }),
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "Report update failed."),
        );
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Report update failed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function addFolder() {
    if (!folderName.trim()) return;
    setError("");
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: folderName }),
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "Folder creation failed."),
        );
      setFolderName("");
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Folder creation failed.",
      );
    }
  }

  async function emptyTrash() {
    setError("");
    try {
      const response = await fetch("/api/documents?scope=trash", {
        method: "DELETE",
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "The trash could not be emptied."),
        );
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The trash could not be emptied.",
      );
    }
  }

  async function openViewer(item: ReportDocumentSummary) {
    setBusyId(item.id);
    setError("");
    try {
      const response = await fetch(`/api/documents/${item.id}`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "The report could not be opened."),
        );
      const payload = (await response.json()) as {
        document: { html: string };
      };
      setViewer({ title: documentLabel(item), html: payload.document.html });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The report could not be opened.",
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

  return (
    <div className="standard-view">
      <div className="view-title">
        <div>
          <span>AI ENGINEERING DOSSIER</span>
          <h1>Detailed manufacturing reports.</h1>
          <p>
            Formatted engineering reports generated from your analysis results —
            costs, processes, illustrations and risks. Reports mirror the folder
            of the result they came from. Download as PDF.
          </p>
        </div>
        <button
          className="secondary-button"
          onClick={() => onNavigate("results")}
          type="button"
        >
          Generate from a result
        </button>
      </div>

      {auth.authenticated &&
        settings.aiReports.enabled &&
        !settings.hasAiApiKey && (
          <div className="global-notice inline-alert" role="alert">
            Detailed reports need an OpenAI API key. Add your key and model in
            Settings to start generating.
            <button onClick={() => onNavigate("settings")} type="button">
              Open Settings <ArrowIcon />
            </button>
          </div>
        )}
      {!settings.aiReports.enabled && (
        <div className="global-notice inline-alert" role="alert">
          Detailed reports are disabled. Re-enable them in Settings.
          <button onClick={() => onNavigate("settings")} type="button">
            Open Settings <ArrowIcon />
          </button>
        </div>
      )}
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}

      <div className="reports-layout">
        <aside className="folder-panel">
          <strong>LIBRARY</strong>
          {(["active", "archived", "trash"] as const).map((item) => (
            <button
              aria-pressed={scope === item}
              className={scope === item ? "active" : ""}
              key={item}
              onClick={() => setScope(item)}
              type="button"
            >
              {item === "active" ? (
                <FolderIcon />
              ) : item === "archived" ? (
                <ArchiveIcon />
              ) : (
                <TrashIcon />
              )}
              {item}
            </button>
          ))}
          <strong>FOLDERS</strong>
          <button
            aria-pressed={folderId === null}
            className={folderId === null ? "active" : ""}
            onClick={() => setFolderId(null)}
            type="button"
          >
            <FolderIcon />
            All folders
          </button>
          {workspace.folders.map((folder) => (
            <button
              aria-pressed={folderId === folder.id}
              className={folderId === folder.id ? "active" : ""}
              key={folder.id}
              onClick={() => setFolderId(folder.id)}
              type="button"
            >
              <FolderIcon />
              {folder.name}
            </button>
          ))}
          <div className="new-folder">
            <input
              aria-label="New folder name"
              maxLength={100}
              onChange={(event) => setFolderName(event.target.value)}
              placeholder="New folder"
              value={folderName}
            />
            <button
              aria-label="Create folder"
              disabled={!folderName.trim()}
              onClick={() => void addFolder()}
              type="button"
            >
              <PlusIcon />
            </button>
          </div>
        </aside>

        <section className="technical-panel report-library">
          <div className="library-toolbar">
            <label>
              <span>Search reports</span>
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name or tag…"
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
            <MultiSelectFilter
              label="Tags"
              onChange={setTagFilter}
              options={availableTags.map((tag) => ({
                value: tag,
                label: tag,
              }))}
              selected={tagFilter}
            />
            {generatingCount > 0 && (
              <span className="kcl-chip generating">
                {generatingCount} generating…
              </span>
            )}
            <span>{documents.length} items</span>
          </div>

          {scope === "trash" && trashCount > 0 && (
            <div className="trash-actions">
              <button
                className="text-button danger"
                onClick={() => void emptyTrash()}
                type="button"
              >
                <TrashIcon /> Empty trash ({trashCount})
              </button>
            </div>
          )}

          {documents.length === 0 ? (
            <div className="compact-empty">
              <p>
                {workspace.documents.length === 0
                  ? "No detailed reports yet. Open Results and generate one from an analysis."
                  : "No report matches the current filter."}
              </p>
            </div>
          ) : (
            <>
              <div className="report-list-head documents-head">
                <span>{sortButton("name", "Report")}</span>
                <span>Tags</span>
                <span>Model</span>
                <span>{sortButton("status", "Status")}</span>
                <span>{sortButton("updated", "Updated")}</span>
                <span>Actions</span>
              </div>
              {documents.map((item) => {
                const busy = busyId === item.id;
                const generating = item.status === "generating";
                return (
                  <article
                    className="report-list-row documents-row"
                    key={item.id}
                  >
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
                        <strong>{documentLabel(item)}</strong>
                        <small>
                          {generating
                            ? "Being generated…"
                            : item.status === "failed"
                              ? (item.error ?? "Generation failed.")
                              : `${(item.sizeBytes / 1024).toFixed(0)} KB · PDF`}
                        </small>
                      </div>
                    </div>
                    <TagEditor
                      disabled={busy}
                      onSave={(tags) => void mutate(item.id, { tags })}
                      tags={item.tags ?? []}
                    />
                    <small className="document-model">{item.model}</small>
                    {generating ? (
                      <span className="kcl-chip generating">Generating…</span>
                    ) : (
                      <span
                        className={`part-status ${
                          item.status === "failed" ? "failed" : "analyzed"
                        }`}
                      >
                        {DOCUMENT_STATUS_LABELS[item.status] ?? item.status}
                      </span>
                    )}
                    <time>
                      {formatDate(item.updatedAt, settings.timezone, true)}
                    </time>
                    <div>
                      <select
                        aria-label={`Folder for ${documentLabel(item)}`}
                        className="folder-select"
                        disabled={busy}
                        onChange={(event) =>
                          void mutate(item.id, {
                            folderId: event.target.value || null,
                          })
                        }
                        value={item.folderId ?? ""}
                      >
                        <option value="">No folder</option>
                        {workspace.folders.map((folder) => (
                          <option key={folder.id} value={folder.id}>
                            {folder.name}
                          </option>
                        ))}
                      </select>
                      {item.status === "failed" && item.resultId && (
                        <button
                          disabled={
                            busy ||
                            !settings.aiReports.enabled ||
                            !settings.hasAiApiKey
                          }
                          onClick={() => void retryGeneration(item)}
                          title={
                            settings.hasAiApiKey
                              ? undefined
                              : "Add your OpenAI API key in Settings to generate detailed reports."
                          }
                          type="button"
                        >
                          Retry
                        </button>
                      )}
                      {item.status === "ready" && (
                        <button
                          disabled={busy}
                          onClick={() => void openViewer(item)}
                          type="button"
                        >
                          View
                        </button>
                      )}
                      {item.status === "ready" && (
                        <a
                          className="row-link"
                          href={`/api/documents/${item.id}?format=pdf`}
                        >
                          PDF
                        </a>
                      )}
                      {scope !== "archived" ? (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void mutate(item.id, { archivedAt: "now" })
                          }
                          type="button"
                        >
                          <ArchiveIcon /> Archive
                        </button>
                      ) : (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void mutate(item.id, { archivedAt: null })
                          }
                          type="button"
                        >
                          Restore
                        </button>
                      )}
                      {scope !== "trash" ? (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void mutate(item.id, { trashedAt: "now" })
                          }
                          type="button"
                        >
                          <TrashIcon /> Trash
                        </button>
                      ) : (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void mutate(item.id, { trashedAt: null })
                          }
                          type="button"
                        >
                          Restore
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </>
          )}
        </section>
      </div>

      {viewer && (
        <div
          className="document-viewer-backdrop"
          onClick={() => setViewer(null)}
          role="presentation"
        >
          <div
            className="document-viewer"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-label={viewer.title}
          >
            <header>
              <strong>{viewer.title}</strong>
              <button
                aria-label="Close report"
                onClick={() => setViewer(null)}
                type="button"
              >
                ×
              </button>
            </header>
            <iframe sandbox="" srcDoc={viewer.html} title={viewer.title} />
          </div>
        </div>
      )}
    </div>
  );
}
