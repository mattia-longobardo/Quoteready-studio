"use client";

import { useEffect, useRef, useState } from "react";

export type SortField = "name" | "updated" | "status";
type SortDirection = "asc" | "desc";

export interface SortState {
  field: SortField;
  direction: SortDirection;
}

export const DEFAULT_SORT: SortState = { field: "updated", direction: "desc" };

export function toggleSort(current: SortState, field: SortField): SortState {
  if (current.field !== field) {
    return { field, direction: field === "updated" ? "desc" : "asc" };
  }
  return { field, direction: current.direction === "asc" ? "desc" : "asc" };
}

export function sortIndicator(sort: SortState, field: SortField): string {
  if (sort.field !== field) return "↕";
  return sort.direction === "asc" ? "↑" : "↓";
}

interface Sortable {
  title: string;
  updatedAt: string;
  /** Status label used when sorting by status; optional for legacy callers. */
  statusKey?: string;
}

export function compareBySort(
  sort: SortState,
  a: Sortable,
  b: Sortable,
): number {
  const direction = sort.direction === "asc" ? 1 : -1;
  if (sort.field === "name") {
    return (
      direction *
      a.title.localeCompare(b.title, undefined, {
        sensitivity: "base",
      })
    );
  }
  if (sort.field === "status") {
    const compared = (a.statusKey ?? "").localeCompare(b.statusKey ?? "");
    // Equal statuses keep the freshest item first.
    return compared !== 0
      ? direction * compared
      : b.updatedAt.localeCompare(a.updatedAt);
  }
  return direction * a.updatedAt.localeCompare(b.updatedAt);
}

/** Matches the query against a name plus its tags (case-insensitive). */
export function matchesQuery(
  query: string,
  haystack: string,
  tags: string[] | undefined,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${haystack} ${(tags ?? []).join(" ")}`
    .toLowerCase()
    .includes(normalized);
}

/** Empty selection = no filter; otherwise the value must be selected. */
export function matchesSelection(selected: string[], value: string): boolean {
  return selected.length === 0 || selected.includes(value);
}

/** Empty selection = no filter; otherwise any selected tag must be present. */
export function matchesTagSelection(
  selected: string[],
  tags: string[] | undefined,
): boolean {
  if (selected.length === 0) return true;
  const owned = new Set(tags ?? []);
  return selected.some((tag) => owned.has(tag));
}

/** Distinct, sorted tag list across a collection, for filter options. */
export function collectTags(items: Array<{ tags?: string[] }>): string[] {
  const tags = new Set<string>();
  for (const item of items) {
    for (const tag of item.tags ?? []) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/**
 * Compact multi-select dropdown used for status and tag filters next to the
 * search input of every library table.
 */
export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  function toggle(value: string) {
    onChange(
      selected.includes(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value],
    );
  }

  return (
    <div className="multi-filter" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className={selected.length > 0 ? "active" : ""}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {label}
        {selected.length > 0 && <em>{selected.length}</em>}
        <i>{open ? "▴" : "▾"}</i>
      </button>
      {open && (
        <div className="multi-filter-menu" role="listbox">
          {options.length === 0 ? (
            <p>No options available.</p>
          ) : (
            options.map((option) => (
              <label key={option.value}>
                <input
                  checked={selected.includes(option.value)}
                  onChange={() => toggle(option.value)}
                  type="checkbox"
                />
                {option.label}
              </label>
            ))
          )}
          {selected.length > 0 && (
            <button
              className="multi-filter-clear"
              onClick={() => onChange([])}
              type="button"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function TagEditor({
  tags,
  disabled,
  onSave,
}: {
  tags: string[];
  disabled?: boolean;
  onSave: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const value = draft.trim().replace(/,+$/, "");
    if (!value) return;
    setDraft("");
    const next = [
      ...new Set([...tags, ...value.split(",").map((t) => t.trim())]),
    ]
      .filter(Boolean)
      .slice(0, 10);
    onSave(next);
  }

  return (
    <div className="tag-editor">
      {tags.map((tag) => (
        <span className="tag-chip" key={tag}>
          {tag}
          <button
            aria-label={`Remove tag ${tag}`}
            disabled={disabled}
            onClick={() => onSave(tags.filter((item) => item !== tag))}
            type="button"
          >
            ×
          </button>
        </span>
      ))}
      <input
        aria-label="Add tag"
        disabled={disabled}
        maxLength={30}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
          }
        }}
        placeholder="+ tag"
        value={draft}
      />
    </div>
  );
}
