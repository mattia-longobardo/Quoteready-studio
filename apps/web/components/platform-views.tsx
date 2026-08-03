"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ArchiveIcon,
  ArrowIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@/components/icons";
import { ResultContextDialog } from "@/components/result-context";
import { responseMessage } from "@/lib/client-http";
import { formatDate } from "@/lib/format";
import { loadPlannerReport } from "@/lib/planner-store";
import { findResultPart } from "@/lib/result-context";
import { useFileDrop } from "@/lib/use-file-drop";
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
import { MACHINE_PROCESSES } from "@quoteredy/core/manufacturing";
import { MATERIALS } from "@quoteredy/core/materials";
import type {
  AuthState,
  MachineProfile,
  PlannerSeed,
  PlatformView,
  ReportFolder,
  StoredReport,
  WorkspaceState,
} from "@quoteredy/core/types";

type Navigate = (view: PlatformView) => void;

const DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const MONEY_FORMATTER = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

function ConnectGate({
  auth,
  children,
}: {
  auth: AuthState;
  children: React.ReactNode;
}) {
  if (auth.authenticated) return children;
  return (
    <div className="connect-gate">
      <span className="gate-mark">Z</span>
      <h2>Connect Zoo to unlock your workspace</h2>
      <p>
        Your project library, factory profile, Zoo Agent settings and report
        history stay scoped to your Zoo identity.
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

function statusName(report: StoredReport) {
  return report.report.status === "ready"
    ? "Ready"
    : report.report.status === "review"
      ? "Review"
      : "Blocked";
}

function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "Unknown"
    : DATE_FORMATTER.format(parsed);
}

export function DashboardView({
  auth,
  workspace,
  onNavigate,
}: {
  auth: AuthState;
  workspace: WorkspaceState;
  onNavigate: Navigate;
}) {
  const recent = workspace.reports
    .filter((item) => !item.trashedAt)
    .slice(0, 5);
  return (
    <div className="dashboard-view">
      <div className="view-title dashboard-title">
        <div>
          <span>MANUFACTURING CONTROL ROOM</span>
          <h1>
            Decide how to make it.
            <br />
            <em>Before you quote it.</em>
          </h1>
          <p>
            One workspace for CAD evidence, process planning, factory-aware
            costing and quote-ready reports.
          </p>
        </div>
        <button
          className="primary-button hero-action"
          onClick={() => onNavigate("planner")}
          type="button"
        >
          Start a new plan <ArrowIcon />
        </button>
      </div>

      <div className="stats-grid">
        <article>
          <span>01 / REPORTS</span>
          <strong>{auth.authenticated ? workspace.stats.reports : "—"}</strong>
          <p>Engineering analyses saved to your workspace.</p>
        </article>
        <article>
          <span>02 / QUOTE READY</span>
          <strong>{auth.authenticated ? workspace.stats.ready : "—"}</strong>
          <p>Packages with no blocking RFQ omissions.</p>
        </article>
        <article>
          <span>03 / FACTORY ASSETS</span>
          <strong>{auth.authenticated ? workspace.stats.machines : "—"}</strong>
          <p>Enabled machines used for make-or-buy planning.</p>
        </article>
        <article className="zoo-stat">
          <span>04 / INTELLIGENCE</span>
          <strong>ZOO</strong>
          <p>Geometry and Agent reasoning with a validated fallback.</p>
        </article>
      </div>

      <div className="dashboard-grid">
        <section className="technical-panel recent-panel">
          <div className="panel-heading">
            <div>
              <span className="step-number">R</span>
              <div>
                <small>WORKSPACE</small>
                <h2>Recent reports</h2>
              </div>
            </div>
            <button
              className="inline-button"
              onClick={() => onNavigate("results")}
              type="button"
            >
              View all <ArrowIcon />
            </button>
          </div>
          {!auth.authenticated ? (
            <div className="compact-empty">
              <p>Connect Zoo to load your private report history.</p>
            </div>
          ) : recent.length === 0 ? (
            <div className="compact-empty">
              <p>No reports yet. Run the sample or analyse your first part.</p>
              <button onClick={() => onNavigate("planner")} type="button">
                Create first plan <ArrowIcon />
              </button>
            </div>
          ) : (
            <div className="report-table">
              {recent.map((item) => {
                const route = item.report.manufacturingPlan.routes.find(
                  (candidate) =>
                    candidate.id ===
                    item.report.manufacturingPlan.recommendedRouteId,
                );
                return (
                  <button
                    key={item.id}
                    onClick={() => onNavigate("results")}
                    type="button"
                  >
                    <span className={`report-status ${item.report.status}`} />
                    <strong>{item.title}</strong>
                    <small>{route?.name ?? "Route pending"}</small>
                    <span>{statusName(item)}</span>
                    <time>{date(item.updatedAt)}</time>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="technical-panel workflow-panel">
          <div className="panel-heading">
            <div>
              <span className="step-number">F</span>
              <div>
                <small>DECISION CHAIN</small>
                <h2>Part to production</h2>
              </div>
            </div>
          </div>
          <div className="workflow-map">
            <button onClick={() => onNavigate("library")} type="button">
              <span>01</span>
              <strong>Source geometry</strong>
              <small>Local CAD + Zoo context</small>
            </button>
            <i>
              <ArrowIcon />
            </i>
            <button onClick={() => onNavigate("planner")} type="button">
              <span>02</span>
              <strong>Plan routes</strong>
              <small>Single + multi-step</small>
            </button>
            <i>
              <ArrowIcon />
            </i>
            <button onClick={() => onNavigate("factory")} type="button">
              <span>03</span>
              <strong>Fit factory</strong>
              <small>Capabilities + costs</small>
            </button>
            <i>
              <ArrowIcon />
            </i>
            <button onClick={() => onNavigate("results")} type="button">
              <span>04</span>
              <strong>Release report</strong>
              <small>Evidence + estimate</small>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

interface ZooProject {
  id: string;
  name: string;
  updatedAt?: string;
  description?: string;
}

function normaliseProjects(payload: unknown): ZooProject[] {
  const object =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const collection = Array.isArray(payload)
    ? payload
    : Array.isArray(object.items)
      ? object.items
      : Array.isArray(object.projects)
        ? object.projects
        : [];
  return collection
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .slice(0, 50)
    .map((item, index) => ({
      id:
        typeof item.id === "string"
          ? item.id.slice(0, 200)
          : `project-${index}`,
      name:
        typeof item.name === "string"
          ? item.name.slice(0, 160)
          : typeof item.title === "string"
            ? item.title.slice(0, 160)
            : "Untitled Zoo project",
      updatedAt:
        typeof item.updated_at === "string"
          ? item.updated_at
          : typeof item.updatedAt === "string"
            ? item.updatedAt
            : undefined,
      description:
        typeof item.description === "string"
          ? item.description.slice(0, 500)
          : undefined,
    }));
}

export function ZooLibraryView({
  auth,
  settings,
  onPlan,
  onLocalPlan,
  onNavigate,
}: {
  auth: AuthState;
  settings: WorkspaceState["settings"];
  onPlan: (seed: PlannerSeed) => void;
  onLocalPlan: () => void;
  onNavigate: Navigate;
}) {
  const [projects, setProjects] = useState<ZooProject[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState("");
  const [uploadError, setUploadError] = useState("");
  const uploadDrop = useFileDrop((file) => {
    setUploadFile(file);
    setUploadNotice("");
    setUploadError("");
  });

  const hasZooToken = settings.hasZooApiToken;

  const loadProjects = useCallback(async () => {
    if (!auth.authenticated) return;
    // Without a personal token the Projects API rejects the OAuth session,
    // so the library features stay disabled instead of surfacing a 403.
    if (!hasZooToken) {
      setProjects([]);
      setError("");
      setLoading(false);
      return;
    }
    try {
      const response = await fetch("/api/zoo/projects", { cache: "no-store" });
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "Zoo library unavailable."),
        );
      setProjects(normaliseProjects(await response.json()));
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Zoo library unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, [auth.authenticated, hasZooToken]);

  useEffect(() => {
    void Promise.resolve().then(loadProjects);
  }, [loadProjects]);

  async function uploadToZoo() {
    if (!uploadFile || uploading) return;
    setUploading(true);
    setUploadError("");
    setUploadNotice("");
    try {
      const body = new FormData();
      if (uploadName.trim()) body.set("projectName", uploadName.trim());
      body.set("cadFile", uploadFile);
      const response = await fetch("/api/zoo/upload", {
        method: "POST",
        body,
      });
      if (!response.ok)
        throw new Error(await responseMessage(response, "Zoo upload failed."));
      const created = (await response.json()) as { name?: string };
      setUploadNotice(
        `“${created.name ?? uploadFile.name}” was created as a draft project in your Zoo library.`,
      );
      setUploadFile(null);
      setUploadName("");
      await loadProjects();
    } catch (cause) {
      setUploadError(
        cause instanceof Error ? cause.message : "Zoo upload failed.",
      );
    } finally {
      setUploading(false);
    }
  }

  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return projects;
    return projects.filter((project) =>
      `${project.name} ${project.description ?? ""}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [projects, query]);

  return (
    <ConnectGate auth={auth}>
      <div className="standard-view">
        <div className="view-title">
          <div>
            <span>ZOO PROJECTS API</span>
            <h1>Your Zoo library, inside the quoting flow.</h1>
            <p>
              Carry project identity into a plan, then attach the manufacturable
              CAD file for measured analysis.
            </p>
          </div>
          <button
            className="secondary-button"
            onClick={onLocalPlan}
            type="button"
          >
            Upload local CAD
          </button>
        </div>
        {auth.authenticated && !hasZooToken && (
          <div className="global-notice inline-alert" role="alert">
            The Zoo library and CAD upload need your personal Zoo API token. Add
            it in Settings to enable these features.
            <button onClick={() => onNavigate("settings")} type="button">
              Open Settings <ArrowIcon />
            </button>
          </div>
        )}
        <section className="technical-panel zoo-upload-panel">
          <div className="panel-heading">
            <div>
              <span className="step-number">↑</span>
              <div>
                <small>ZOO PROJECTS API</small>
                <h2>Upload CAD to your Zoo library</h2>
              </div>
            </div>
            <span>STEP · STL · OBJ · PLY · SLDPRT</span>
          </div>
          <div className="zoo-upload-grid">
            <label
              className={`drop-zone ${uploadFile ? "has-file" : ""} ${
                uploadDrop.active ? "drag-active" : ""
              }`}
              {...uploadDrop.dropProps}
            >
              <input
                accept=".step,.stp,.stl,.obj,.ply,.sldprt"
                onChange={(event) => {
                  setUploadFile(event.target.files?.[0] ?? null);
                  setUploadNotice("");
                  setUploadError("");
                }}
                type="file"
              />
              <span className="file-type">CAD / TO ZOO</span>
              <strong>{uploadFile?.name ?? "Choose or drop a CAD file"}</strong>
              <small>
                {uploadFile
                  ? `${(uploadFile.size / 1_048_576).toFixed(2)} MB`
                  : "Drag & drop · creates a draft project with a KCL entrypoint"}
              </small>
            </label>
            <div className="zoo-upload-side">
              <label className="field">
                <span>Project title</span>
                <input
                  maxLength={100}
                  onChange={(event) => setUploadName(event.target.value)}
                  placeholder="Defaults to the file name"
                  value={uploadName}
                />
              </label>
              <button
                className="primary-button"
                disabled={!hasZooToken || !uploadFile || uploading}
                onClick={() => void uploadToZoo()}
                title={
                  hasZooToken
                    ? undefined
                    : "Add your Zoo API token in Settings to upload CAD to Zoo."
                }
                type="button"
              >
                {uploading ? "Uploading…" : "Upload to Zoo"}
                <ArrowIcon />
              </button>
            </div>
          </div>
          {uploadError && (
            <div className="error-message" role="alert">
              {uploadError}
            </div>
          )}
          {uploadNotice && (
            <div className="upload-success" role="status">
              {uploadNotice}
            </div>
          )}
        </section>
        <div className="library-toolbar">
          <label>
            <span>Search projects</span>
            <input
              aria-label="Search Zoo projects"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by project name…"
              value={query}
            />
          </label>
          <span>
            {filteredProjects.length} of {projects.length} projects
          </span>
        </div>
        {!hasZooToken ? (
          <div className="connect-gate embedded">
            <span className="gate-mark">Z</span>
            <h2>Zoo API token required</h2>
            <p>
              The Projects API does not accept third-party OAuth tokens, so your
              library stays disabled until you add your personal Zoo API token
              in Settings.
            </p>
            <button
              className="primary-button"
              onClick={() => onNavigate("settings")}
              type="button"
            >
              Open Settings <ArrowIcon />
            </button>
          </div>
        ) : loading ? (
          <div className="compact-empty">
            <p>Loading your Zoo projects…</p>
          </div>
        ) : error ? (
          <div className="error-message" role="alert">
            {error}
          </div>
        ) : projects.length === 0 ? (
          <div className="connect-gate embedded">
            <span className="gate-mark">Z</span>
            <h2>No projects returned</h2>
            <p>
              Create a project in Zoo or upload a local CAD model to start a
              manufacturing plan.
            </p>
            <button
              className="primary-button"
              onClick={onLocalPlan}
              type="button"
            >
              Open planner <ArrowIcon />
            </button>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="compact-empty">
            <p>No Zoo project matches “{query}”.</p>
          </div>
        ) : (
          <div className="project-grid">
            {filteredProjects.map((project) => (
              <article key={project.id}>
                <div className="project-preview">
                  <span>ZOO</span>
                  <i />
                  <i />
                </div>
                <small>{project.id.slice(0, 8)}</small>
                <h3>{project.name}</h3>
                <p>{project.description || "Zoo design project"}</p>
                <div>
                  <span>
                    {project.updatedAt ? date(project.updatedAt) : "Synced"}
                  </span>
                  <button
                    onClick={() =>
                      onPlan({
                        projectId: project.id,
                        projectName: project.name,
                      })
                    }
                    type="button"
                  >
                    Prepare CAD upload <ArrowIcon />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </ConnectGate>
  );
}

export function ResultsView({
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
  const [scope, setScope] = useState<"active" | "archived" | "trash">("active");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [folderName, setFolderName] = useState("");
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [error, setError] = useState("");
  const [notice, setNoticeMessage] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [contextId, setContextId] = useState<string | null>(null);
  const [folderToDelete, setFolderToDelete] = useState<ReportFolder | null>(
    null,
  );
  const [deletingFolder, setDeletingFolder] = useState(false);

  const settings = workspace.settings;
  const availableTags = useMemo(
    () => collectTags(workspace.reports),
    [workspace.reports],
  );
  const reports = useMemo(
    () =>
      workspace.reports
        .filter((item) => {
          const route = item.report.manufacturingPlan.routes.find(
            (candidate) =>
              candidate.id === item.report.manufacturingPlan.recommendedRouteId,
          );
          const matchesSearch = matchesQuery(
            query,
            `${item.title} ${item.report.file.name} ${route?.name ?? ""}`,
            item.tags,
          );
          const matchesFolder = folderId === null || item.folderId === folderId;
          const matchesScope =
            scope === "trash"
              ? Boolean(item.trashedAt)
              : scope === "archived"
                ? Boolean(item.archivedAt && !item.trashedAt)
                : Boolean(!item.archivedAt && !item.trashedAt);
          return (
            matchesSearch &&
            matchesFolder &&
            matchesScope &&
            matchesSelection(statusFilter, item.report.status) &&
            matchesTagSelection(tagFilter, item.tags)
          );
        })
        .sort((a, b) =>
          compareBySort(
            sort,
            { ...a, statusKey: a.report.status },
            { ...b, statusKey: b.report.status },
          ),
        ),
    [workspace.reports, query, scope, folderId, sort, statusFilter, tagFilter],
  );
  const trashCount = workspace.reports.filter((item) => item.trashedAt).length;
  const contextResult =
    workspace.reports.find((item) => item.id === contextId) ?? null;
  // Documents still being written by the AI, keyed by their source result:
  // used to keep the "Report" button honest across page changes.
  const generatingDocs = useMemo(
    () =>
      new Set(
        workspace.documents
          .filter((item) => item.status === "generating")
          .map((item) => item.resultId)
          .filter(Boolean),
      ),
    [workspace.documents],
  );
  const failedDocs = useMemo(
    () =>
      new Map(
        workspace.documents
          .filter((item) => item.status === "failed" && item.resultId)
          .map((item) => [item.resultId, item.error ?? "Generation failed."]),
      ),
    [workspace.documents],
  );

  // Report generation runs server-side; poll while any document is pending
  // so the state stays live even after navigating away and back.
  useEffect(() => {
    if (generatingDocs.size === 0) return;
    const timer = setInterval(() => void refresh(), 4_000);
    return () => clearInterval(timer);
  }, [generatingDocs.size, refresh]);

  async function mutate(id: string, changes: Record<string, unknown>) {
    setBusyId(id);
    setError("");
    try {
      const response = await fetch("/api/reports", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...changes }),
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "Result update failed."),
        );
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Result update failed.",
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
      const response = await fetch("/api/reports?scope=trash", {
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

  async function removeFolder(folder: ReportFolder, mode: "purge" | "release") {
    setDeletingFolder(true);
    setError("");
    setNoticeMessage("");
    try {
      const response = await fetch(
        `/api/reports?folderId=${encodeURIComponent(folder.id)}&mode=${mode}`,
        { method: "DELETE" },
      );
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "The folder could not be deleted."),
        );
      const outcome = (await response.json()) as {
        removedReports: number;
        removedDocuments: number;
      };
      if (folderId === folder.id) setFolderId(null);
      setNoticeMessage(
        mode === "purge"
          ? `Folder “${folder.name}” deleted with ${outcome.removedReports} results and ${outcome.removedDocuments} reports.`
          : `Folder “${folder.name}” deleted — its contents were moved to All folders.`,
      );
      setFolderToDelete(null);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The folder could not be deleted.",
      );
    } finally {
      setDeletingFolder(false);
    }
  }

  async function generateDocument(resultId: string) {
    setGeneratingId(resultId);
    setError("");
    setNoticeMessage("");
    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId }),
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "Report generation failed."),
        );
      setNoticeMessage(
        "Report generation started — it keeps running even if you change page. Follow it on the Reports page.",
      );
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Report generation failed.",
      );
    } finally {
      setGeneratingId(null);
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
    <ConnectGate auth={auth}>
      <div className="standard-view">
        <div className="view-title">
          <div>
            <span>ANALYSIS RESULT FILE SYSTEM</span>
            <h1>Every analysis, traceable and reusable.</h1>
            <p>
              Organise analysis results into folders and tags, archive completed
              work, recover items from trash and promote any result to a
              detailed report.
            </p>
          </div>
          <button
            className="secondary-button"
            onClick={() => onNavigate("reports")}
            type="button"
          >
            Open reports
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
              <div className="folder-line" key={folder.id}>
                <button
                  aria-pressed={folderId === folder.id}
                  className={folderId === folder.id ? "active" : ""}
                  onClick={() => setFolderId(folder.id)}
                  type="button"
                >
                  <FolderIcon />
                  {folder.name}
                </button>
                <button
                  aria-label={`Delete folder ${folder.name}`}
                  className="folder-delete"
                  onClick={() => setFolderToDelete(folder)}
                  type="button"
                >
                  <TrashIcon />
                </button>
              </div>
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
                <span>Search results</span>
                <input
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Part, file, route or tag…"
                  value={query}
                />
              </label>
              <MultiSelectFilter
                label="Status"
                onChange={setStatusFilter}
                options={[
                  { value: "ready", label: "Ready" },
                  { value: "review", label: "Review" },
                  { value: "blocked", label: "Blocked" },
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
              <span>{reports.length} items</span>
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
            {reports.length === 0 ? (
              <div className="compact-empty">
                <p>No result matches the selected library and filters.</p>
              </div>
            ) : (
              <div className="report-list-head results-head">
                <span>{sortButton("name", "Result")}</span>
                <span>Tags</span>
                <span>Route / estimate</span>
                <span>{sortButton("status", "Status")}</span>
                <span>{sortButton("updated", "Updated")}</span>
                <span>Actions</span>
              </div>
            )}
            {reports.map((item) => {
              const route = item.report.manufacturingPlan.routes.find(
                (candidate) =>
                  candidate.id ===
                  item.report.manufacturingPlan.recommendedRouteId,
              );
              const generating =
                generatingId === item.id || generatingDocs.has(item.id);
              const busy = busyId === item.id || generating;
              const attachmentCount = (item.attachments ?? []).length;
              return (
                <article className="report-list-row results-row" key={item.id}>
                  <div>
                    <span className={`report-status ${item.report.status}`} />
                    <div>
                      <strong>{item.title}</strong>
                      <small>
                        {item.report.file.name}
                        {item.revision ? ` · re-run ${item.revision}` : ""}
                        {attachmentCount > 0
                          ? ` · ${attachmentCount} attached`
                          : ""}
                      </small>
                    </div>
                  </div>
                  <TagEditor
                    disabled={busy}
                    onSave={(tags) => void mutate(item.id, { tags })}
                    tags={item.tags ?? []}
                  />
                  <div>
                    <strong>{route?.name ?? "Route pending"}</strong>
                    <small>
                      {route
                        ? `${MONEY_FORMATTER.format(route.price.expected)} · ${route.leadTimeHours} h`
                        : "—"}
                    </small>
                  </div>
                  <span className={`status-pill ${item.report.status}`}>
                    {statusName(item)}
                  </span>
                  <time>
                    {formatDate(item.updatedAt, settings.timezone, true)}
                  </time>
                  <div>
                    <button
                      disabled={busy}
                      onClick={() => {
                        loadPlannerReport(item.report);
                        onNavigate("planner");
                      }}
                      type="button"
                    >
                      Review
                    </button>
                    {scope === "active" && (
                      <button
                        disabled={busy}
                        onClick={() => setContextId(item.id)}
                        title="Attach drawings and notes, replace the 3D part, re-run the analysis"
                        type="button"
                      >
                        {attachmentCount > 0
                          ? `Material (${attachmentCount})`
                          : "Material"}
                      </button>
                    )}
                    {scope === "active" && (
                      <button
                        className="generate-button"
                        disabled={
                          busy ||
                          !settings.aiReports.enabled ||
                          !settings.hasAiApiKey
                        }
                        onClick={() => void generateDocument(item.id)}
                        title={
                          !settings.hasAiApiKey
                            ? "Add your OpenAI API key in Settings to generate detailed reports."
                            : failedDocs.get(item.id)
                        }
                        type="button"
                      >
                        {generating
                          ? "Generating…"
                          : failedDocs.has(item.id)
                            ? "Retry report"
                            : "Report"}
                      </button>
                    )}
                    <select
                      aria-label={`Folder for ${item.title}`}
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
                    {scope !== "archived" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void mutate(item.id, {
                            archivedAt: new Date().toISOString(),
                          })
                        }
                        type="button"
                      >
                        <ArchiveIcon /> Archive
                      </button>
                    )}
                    {scope === "archived" && (
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
                          void mutate(item.id, {
                            trashedAt: new Date().toISOString(),
                          })
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
          </section>
        </div>
        {contextResult && (
          <ResultContextDialog
            key={contextResult.id}
            onClose={() => setContextId(null)}
            onRerun={(message) => {
              setContextId(null);
              setNoticeMessage(message);
            }}
            part={findResultPart(
              workspace.parts,
              workspace.reports,
              contextResult.id,
            )}
            refresh={refresh}
            result={contextResult}
            timezone={settings.timezone}
          />
        )}
        {folderToDelete && (
          <div
            className="document-viewer-backdrop"
            onClick={() => setFolderToDelete(null)}
            role="presentation"
          >
            <div
              aria-label={`Delete folder ${folderToDelete.name}`}
              className="confirm-dialog"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <header>
                <strong>Delete “{folderToDelete.name}”?</strong>
                <button
                  aria-label="Cancel folder deletion"
                  onClick={() => setFolderToDelete(null)}
                  type="button"
                >
                  ×
                </button>
              </header>
              <p>
                This folder is shared by Results and Reports. Do you want to
                also delete the results and reports inside it, or move them back
                to All folders?
              </p>
              <div className="confirm-actions">
                <button
                  className="danger-button"
                  disabled={deletingFolder}
                  onClick={() => void removeFolder(folderToDelete, "purge")}
                  type="button"
                >
                  <TrashIcon /> Delete contents too
                </button>
                <button
                  className="secondary-button"
                  disabled={deletingFolder}
                  onClick={() => void removeFolder(folderToDelete, "release")}
                  type="button"
                >
                  Move to All folders
                </button>
                <button
                  className="text-button"
                  disabled={deletingFolder}
                  onClick={() => setFolderToDelete(null)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ConnectGate>
  );
}

const SELECTABLE_MATERIALS = MATERIALS.filter(
  (material) => material.id !== "unknown",
);

export function FactoryView({
  auth,
  machines,
  refresh,
}: {
  auth: AuthState;
  machines: MachineProfile[];
  refresh: () => Promise<void>;
}) {
  const EMPTY_MACHINE_FORM = {
    name: "",
    process: "cnc_milling",
    hourlyRate: "75",
    setupMinutes: "30",
    notes: "",
    materials: [] as string[],
  };
  const [form, setForm] = useState(EMPTY_MACHINE_FORM);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  function toggleMaterial(id: string) {
    setForm((current) => ({
      ...current,
      materials: current.materials.includes(id)
        ? current.materials.filter((material) => material !== id)
        : [...current.materials, id],
    }));
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_MACHINE_FORM);
  }

  function startEdit(machine: MachineProfile) {
    setForm({
      name: machine.name,
      process: machine.process,
      hourlyRate: String(machine.hourlyRate),
      setupMinutes: String(machine.setupMinutes),
      notes: machine.notes,
      materials: [...machine.materials],
    });
    setEditingId(machine.id);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function save() {
    setError("");
    try {
      const editing = editingId
        ? machines.find((item) => item.id === editingId)
        : undefined;
      const response = await fetch("/api/factory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          ...(editingId ? { id: editingId } : {}),
          hourlyRate: Number(form.hourlyRate),
          setupMinutes: Number(form.setupMinutes),
          enabled: editing ? editing.enabled : true,
        }),
      });
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "Capability could not be saved."),
        );
      closeForm();
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Capability could not be saved.",
      );
    }
  }

  async function remove(id: string) {
    setError("");
    try {
      const response = await fetch(
        `/api/factory?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!response.ok)
        throw new Error(
          await responseMessage(response, "Machine could not be removed."),
        );
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Machine could not be removed.",
      );
    }
  }

  return (
    <ConnectGate auth={auth}>
      <div className="standard-view">
        <div className="view-title">
          <div>
            <span>CAPABILITY + COST MODEL</span>
            <h1>Teach QuoteReady Studio how your factory works.</h1>
            <p>
              Compatible internal routes receive a ranking boost and use your
              saved rates for preliminary estimates; every route remains
              available for comparison.
            </p>
          </div>
          <button
            className="primary-button"
            onClick={() => (showForm ? closeForm() : setShowForm(true))}
            type="button"
          >
            {showForm ? "Close" : "Add machine"}
            {showForm ? <span aria-hidden="true">×</span> : <PlusIcon />}
          </button>
        </div>
        {error && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}
        {showForm && (
          <section className="technical-panel machine-form">
            <div className="form-grid">
              <label className="field">
                <span>Machine name</span>
                <input
                  maxLength={100}
                  onChange={(event) =>
                    setForm({ ...form, name: event.target.value })
                  }
                  placeholder="Haas VF-2"
                  value={form.name}
                />
              </label>
              <label className="field">
                <span>Capability</span>
                <select
                  onChange={(event) =>
                    setForm({ ...form, process: event.target.value })
                  }
                  value={form.process}
                >
                  {MACHINE_PROCESSES.map((process) => (
                    <option key={process.id} value={process.id}>
                      {process.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field compact">
                <span>Hourly rate €</span>
                <input
                  max="10000"
                  min="0"
                  onChange={(event) =>
                    setForm({ ...form, hourlyRate: event.target.value })
                  }
                  type="number"
                  value={form.hourlyRate}
                />
              </label>
              <label className="field compact">
                <span>Setup min</span>
                <input
                  max="10080"
                  min="0"
                  onChange={(event) =>
                    setForm({ ...form, setupMinutes: event.target.value })
                  }
                  type="number"
                  value={form.setupMinutes}
                />
              </label>
              <fieldset className="field wide material-options">
                <legend>
                  Supported materials{" "}
                  <small>Leave empty for all catalogue materials</small>
                </legend>
                {SELECTABLE_MATERIALS.map((material) => (
                  <label key={material.id}>
                    <input
                      checked={form.materials.includes(material.id)}
                      onChange={() => toggleMaterial(material.id)}
                      type="checkbox"
                    />
                    {material.label}
                  </label>
                ))}
              </fieldset>
              <label className="field wide">
                <span>Notes</span>
                <input
                  maxLength={500}
                  onChange={(event) =>
                    setForm({ ...form, notes: event.target.value })
                  }
                  placeholder="Work envelope, spindle, special constraints…"
                  value={form.notes}
                />
              </label>
            </div>
            <div className="panel-actions">
              <button
                className="primary-button"
                disabled={!form.name.trim()}
                onClick={() => void save()}
                type="button"
              >
                {editingId ? "Update machine" : "Save capability"} <ArrowIcon />
              </button>
              {editingId && (
                <button
                  className="text-button"
                  onClick={() => closeForm()}
                  type="button"
                >
                  Cancel edit
                </button>
              )}
            </div>
          </section>
        )}
        <div className="factory-summary">
          <span>
            <strong>{machines.length}</strong> assets
          </span>
          <span>
            <strong>{machines.filter((item) => item.enabled).length}</strong>{" "}
            enabled
          </span>
          <span>
            <strong>
              {new Set(machines.map((item) => item.process)).size}
            </strong>{" "}
            processes
          </span>
          <p>
            Factory matches influence ranking; all supported routes are still
            evaluated.
          </p>
        </div>
        {machines.length === 0 ? (
          <div className="connect-gate embedded">
            <span className="gate-mark">M</span>
            <h2>No factory capabilities yet</h2>
            <p>
              Add machines and rates, or leave the list empty to evaluate all
              manufacturing routes with benchmark costs.
            </p>
          </div>
        ) : (
          <div className="machine-grid">
            {machines.map((machine) => (
              <article key={machine.id}>
                <div className="machine-code">
                  {machine.process.slice(0, 3).toUpperCase()}
                </div>
                <div>
                  <small>{machine.process.replaceAll("_", " ")}</small>
                  <h3>{machine.name}</h3>
                  <p>{machine.notes || "No operational notes"}</p>
                  <span>
                    {machine.materials.length
                      ? machine.materials
                          .map(
                            (id) =>
                              MATERIALS.find((material) => material.id === id)
                                ?.label ?? id,
                          )
                          .join(" · ")
                      : "All catalogue materials"}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>Rate</dt>
                    <dd>{MONEY_FORMATTER.format(machine.hourlyRate)}/h</dd>
                  </div>
                  <div>
                    <dt>Setup</dt>
                    <dd>{machine.setupMinutes} min</dd>
                  </div>
                </dl>
                <div className="machine-actions">
                  <button onClick={() => startEdit(machine)} type="button">
                    <PencilIcon /> Edit
                  </button>
                  <button
                    className="danger"
                    onClick={() => void remove(machine.id)}
                    type="button"
                  >
                    <TrashIcon /> Remove
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </ConnectGate>
  );
}
