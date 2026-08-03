"use client";

import { useState } from "react";

import { ArrowIcon, TrashIcon } from "@/components/icons";
import { responseMessage } from "@/lib/client-http";
import { formatDate } from "@/lib/format";
import { useFileDrop } from "@/lib/use-file-drop";
import { isDrawingAttachment } from "@/lib/result-context";
import type {
  ResultAttachment,
  StoredPart,
  StoredReport,
} from "@quoteredy/core/types";

const CAD_ACCEPT = ".step,.stp,.stl,.obj,.ply,.sldprt,.ipt,.sat,.x_t,.x_b";
const MATERIAL_ACCEPT = ".pdf,.png,.jpg,.jpeg";
/**
 * Notes travel as a multipart field, which the parser caps at 4 KiB; 2 000
 * characters stay inside that budget even with multi-byte text.
 */
const MAX_NOTE_LENGTH = 2_000;

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

function attachmentKind(attachment: ResultAttachment): string {
  if (attachment.kind === "note") return "NOTE";
  return isDrawingAttachment(attachment) ? "DRAWING" : "DOCUMENT";
}

/**
 * Additional-material workbench of a result: attach drawings, documents and
 * notes, replace the 3D part, and re-run the analysis with everything attached
 * as extra context. The re-run stores a new result linked to this one.
 */
export function ResultContextDialog({
  result,
  part,
  timezone,
  onClose,
  onRerun,
  refresh,
}: {
  result: StoredReport;
  part: StoredPart | null;
  timezone: string;
  onClose: () => void;
  onRerun: (message: string) => void;
  refresh: () => Promise<void>;
}) {
  const [materialFile, setMaterialFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [cadFile, setCadFile] = useState<File | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const materialDrop = useFileDrop(setMaterialFile);
  const cadDrop = useFileDrop(setCadFile);
  const attachments = result.attachments ?? [];
  // A part left in "uploaded" was replaced after the analysis ran, so this
  // result no longer describes the CAD file currently attached to it.
  const stale = part?.status === "uploaded";
  const analyzing = part?.status === "analyzing";

  async function send(
    label: string,
    request: () => Promise<Response>,
    fallback: string,
    success: string,
  ): Promise<boolean> {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const response = await request();
      if (!response.ok) {
        throw new Error(await responseMessage(response, fallback));
      }
      await refresh();
      setNotice(success);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
      return false;
    } finally {
      setBusy("");
    }
  }

  async function attachMaterial() {
    if (!materialFile && !note.trim()) return;
    const body = new FormData();
    body.append("resultId", result.id);
    if (note.trim()) body.append("note", note.trim());
    if (materialFile) body.append("drawing", materialFile);
    const done = await send(
      "attach",
      () => fetch("/api/reports/attachments", { method: "POST", body }),
      "The material could not be attached.",
      "Material attached — re-run the analysis to fold it into the result.",
    );
    if (done) {
      setMaterialFile(null);
      setNote("");
    }
  }

  async function removeAttachment(attachment: ResultAttachment) {
    await send(
      attachment.id,
      () =>
        fetch(
          `/api/reports/attachments?resultId=${encodeURIComponent(result.id)}&attachmentId=${encodeURIComponent(attachment.id)}`,
          { method: "DELETE" },
        ),
      "The attachment could not be removed.",
      "Attachment removed.",
    );
  }

  async function replacePart() {
    if (!cadFile) return;
    const body = new FormData();
    body.append("resultId", result.id);
    body.append("cadFile", cadFile);
    const done = await send(
      "part",
      () => fetch("/api/reports/part", { method: "POST", body }),
      "The 3D part could not be replaced.",
      "3D part replaced — re-run the analysis to measure the new geometry.",
    );
    if (done) setCadFile(null);
  }

  async function rerun() {
    setBusy("rerun");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/reports/rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: result.id }),
      });
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, "The analysis could not be re-run."),
        );
      }
      await refresh();
      onRerun(
        "Analysis re-run with the attached material — the updated result is at the top of the list.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The analysis could not be re-run.",
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <div
      className="document-viewer-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-label={`Additional material for ${result.title}`}
        className="document-viewer result-context"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <strong>{result.title} · additional material</strong>
          <div className="workbench-header-actions">
            {stale && <span className="context-chip">RE-RUN PENDING</span>}
            <button
              aria-label="Close additional material"
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          </div>
        </header>

        <div className="result-context-body">
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

          <section className="context-block">
            <div className="panel-heading">
              <div>
                <span className="step-number">3D</span>
                <div>
                  <small>SOURCE GEOMETRY</small>
                  <h2>3D part</h2>
                </div>
              </div>
              <span>{part ? part.format.toUpperCase() : "NOT LINKED"}</span>
            </div>
            {part ? (
              <>
                <div className="context-part">
                  <div>
                    <span>CURRENT FILE</span>
                    <strong>{part.fileName}</strong>
                    <small>
                      {megabytes(part.sizeBytes)} ·{" "}
                      {formatDate(part.updatedAt, timezone, true)}
                    </small>
                  </div>
                  <div>
                    <span>ANALYSED FILE</span>
                    <strong>{result.report.file.name}</strong>
                    <small>
                      {stale
                        ? "Replaced — this result is stale"
                        : "Matches this result"}
                    </small>
                  </div>
                </div>
                <div className="context-upload compact">
                  <label
                    className={`drop-zone ${cadFile ? "has-file" : ""} ${
                      cadDrop.active ? "drag-active" : ""
                    }`}
                    {...cadDrop.dropProps}
                  >
                    <input
                      accept={CAD_ACCEPT}
                      onChange={(event) =>
                        setCadFile(event.target.files?.[0] ?? null)
                      }
                      type="file"
                    />
                    <span className="file-type">CAD / REPLACEMENT</span>
                    <strong>
                      {cadFile?.name ?? "Choose or drop a new CAD file"}
                    </strong>
                    <small>
                      {cadFile
                        ? megabytes(cadFile.size)
                        : "STEP · STL · Parasolid · native CAD · drag & drop"}
                    </small>
                  </label>
                  <button
                    className="secondary-button"
                    disabled={!cadFile || Boolean(busy) || analyzing}
                    onClick={() => void replacePart()}
                    type="button"
                  >
                    {busy === "part" ? "Replacing…" : "Replace 3D part"}
                  </button>
                </div>
              </>
            ) : (
              <div className="compact-empty">
                <p>
                  The part record of this result is gone, so its 3D file cannot
                  be replaced or re-analysed. Start a new analysis from the
                  Planner instead.
                </p>
              </div>
            )}
          </section>

          <section className="context-block">
            <div className="panel-heading">
              <div>
                <span className="step-number">+</span>
                <div>
                  <small>CONTEXT</small>
                  <h2>Attached material</h2>
                </div>
              </div>
              <span>{attachments.length} ITEMS</span>
            </div>
            {attachments.length === 0 ? (
              <div className="compact-empty">
                <p>
                  Nothing attached yet. Add drawings, specifications or notes —
                  they enrich the readiness checks, the pricing agent and the
                  detailed report.
                </p>
              </div>
            ) : (
              <div className="context-attachments">
                {attachments.map((attachment) => (
                  <article className="context-attachment" key={attachment.id}>
                    <span className="file-type">
                      {attachmentKind(attachment)}
                    </span>
                    <div>
                      <strong>
                        {attachment.kind === "note"
                          ? attachment.text
                          : attachment.fileName}
                      </strong>
                      <small>
                        {attachment.kind === "note"
                          ? formatDate(attachment.createdAt, timezone, true)
                          : `${megabytes(attachment.sizeBytes)} · ${formatDate(
                              attachment.createdAt,
                              timezone,
                              true,
                            )}${attachment.text ? ` · ${attachment.text}` : ""}`}
                      </small>
                    </div>
                    <div className="context-attachment-actions">
                      {attachment.blobKey && (
                        <a
                          className="row-link"
                          href={`/api/reports/attachments?resultId=${encodeURIComponent(result.id)}&attachmentId=${encodeURIComponent(attachment.id)}`}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open
                        </a>
                      )}
                      <button
                        className="row-link"
                        disabled={Boolean(busy)}
                        onClick={() => void removeAttachment(attachment)}
                        type="button"
                      >
                        <TrashIcon /> Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            <div className="context-upload">
              <label
                className={`drop-zone secondary ${materialFile ? "has-file" : ""} ${
                  materialDrop.active ? "drag-active" : ""
                }`}
                {...materialDrop.dropProps}
              >
                <input
                  accept={MATERIAL_ACCEPT}
                  onChange={(event) =>
                    setMaterialFile(event.target.files?.[0] ?? null)
                  }
                  type="file"
                />
                <span className="file-type">DRAWING / DOCUMENT</span>
                <strong>
                  {materialFile?.name ?? "Choose or drop a drawing or spec"}
                </strong>
                <small>
                  {materialFile
                    ? megabytes(materialFile.size)
                    : "PDF · PNG · JPEG · drag & drop · optional"}
                </small>
              </label>
              <label className="field">
                <span>Notes / information</span>
                <textarea
                  maxLength={MAX_NOTE_LENGTH}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Threads, inspection requirements, target cost, anything the CAD does not say…"
                  value={note}
                />
              </label>
              <button
                className="secondary-button"
                disabled={(!materialFile && !note.trim()) || Boolean(busy)}
                onClick={() => void attachMaterial()}
                type="button"
              >
                {busy === "attach" ? "Attaching…" : "Attach material"}
              </button>
            </div>
          </section>
        </div>

        <div className="result-context-actions">
          <p>
            Re-running measures the current 3D part again and feeds every note
            and attached drawing into the readiness checks, the manufacturing
            plan and the price estimate. The result is stored as a new revision
            of this one — nothing is overwritten.
          </p>
          <button
            className="primary-button"
            disabled={!part || Boolean(busy) || analyzing}
            onClick={() => void rerun()}
            type="button"
          >
            {busy === "rerun" ? "Re-running…" : "Re-run analysis"}
            <ArrowIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
