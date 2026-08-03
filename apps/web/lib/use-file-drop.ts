"use client";

import { useState, type DragEvent } from "react";

/**
 * Drag & drop support for the file drop zones: returns the props to spread
 * on the zone element plus an `active` flag for the highlight style. The
 * dropped file goes through the same handler as the file picker, so the
 * existing validation paths apply unchanged.
 */
export function useFileDrop(onFile: (file: File) => void): {
  active: boolean;
  dropProps: {
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragEnter: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
} {
  const [active, setActive] = useState(false);

  return {
    active,
    dropProps: {
      onDragOver: (event) => {
        event.preventDefault();
      },
      onDragEnter: (event) => {
        event.preventDefault();
        setActive(true);
      },
      onDragLeave: (event) => {
        // Ignore transitions between children of the same drop zone.
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        setActive(false);
      },
      onDrop: (event) => {
        event.preventDefault();
        setActive(false);
        const file = event.dataTransfer.files?.[0];
        if (file) onFile(file);
      },
    },
  };
}
