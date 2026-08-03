"use client";

/**
 * Confirmation shown whenever a part name already belongs to another part —
 * both when naming an analysis in the planner and when renaming a part. Reusing
 * a name is an overwrite, so it is never silent: the user either confirms or
 * goes back and picks another name.
 */
export function OverwritePartDialog({
  partName,
  busy = false,
  confirmLabel = "Overwrite the part",
  busyLabel = "Overwriting…",
  cancelLabel = "Cancel — change the name",
  onConfirm,
  onCancel,
}: {
  /** Name of the part that would be overwritten. */
  partName: string;
  busy?: boolean;
  confirmLabel?: string;
  busyLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="document-viewer-backdrop"
      onClick={busy ? undefined : onCancel}
      role="presentation"
    >
      <div
        aria-label={`Overwrite the part ${partName}`}
        className="confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <strong>“{partName}” already exists</strong>
          <button
            aria-label="Cancel the overwrite"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            ×
          </button>
        </header>
        <p>
          A part named “{partName}” is already in this workspace. Are you sure
          you want to overwrite it?
        </p>
        <ul className="confirm-notes">
          <li>
            <span>NAME</span>The new part takes the name over — the parts list
            keeps a single “{partName}”.
          </li>
          <li>
            <span>HISTORY</span>Results, drawings and reports already generated
            keep referencing the original part, with its CAD file and 3D
            preview. Nothing is deleted.
          </li>
        </ul>
        <div className="confirm-actions">
          <button
            className="danger-button"
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? busyLabel : confirmLabel}
          </button>
          <button
            className="text-button"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
