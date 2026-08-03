/**
 * Builds the printable technical drawing (tavola tecnica) of a drawing table:
 * an ISO 5457 A3 landscape sheet with border frame and zone markers, the
 * first-angle projection views of the part, the datum reference frame and the
 * dimension/GD&T tables, and an ISO 7200 title block. The markup is pure
 * HTML/CSS/SVG in millimetres so Chromium prints it 1:1 with the sheet scale.
 */

import type { DrawingTable } from "@quoteredy/core/types";

import type { DrawingScale, DrawingViewport } from "@/lib/drawing-views";
import { drawingLabel } from "@/lib/item-naming";

/** Paper area of the drawing region: frame interior minus the table column. */
export const SHEET_VIEW_AREA: DrawingViewport = {
  widthMm: 239,
  heightMm: 276,
};

/**
 * Paper budget of the table column, in millimetres. The sheets carry no
 * scripting, so the rows that fit are counted here instead of being measured
 * by the browser; the estimates are deliberately generous (every clamped cell
 * is assumed to wrap onto two lines).
 */
const COLUMN_HEIGHT_MM = 201;
const TABLE_HEAD_MM = 13;
const ROW_HEIGHT_MM = 8.2;
const NOTE_LINE_MM = 4.4;
const DISCLAIMER_MM = 10;
/** Dimension rows per continuation sheet, where the table spans the frame. */
const CONTINUATION_ROWS = 22;
const ZONE_COLUMNS = 8;
const ZONE_ROWS = 4;

interface DrawingSheetInput {
  drawing: DrawingTable;
  /** First-angle arrangement of the part, empty when it could not be built. */
  viewsSvg: string;
  scale: DrawingScale | null;
  /** Shown in the drawing area when `viewsSvg` is empty. */
  viewsNote: string;
  /** Measured facts printed next to the views (envelope, volume, mass, …). */
  partData: { label: string; value: string }[];
  /**
   * Row numbers that carry a balloon on the views: they are circled in the
   * table so the reader can find the feature each row controls.
   */
  balloonedRows?: number[];
  material: string;
  drawnAt: Date;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** How many tolerance rows still fit under the datum frame and the notes. */
function firstSheetRows(drawing: DrawingTable): number {
  const datums =
    TABLE_HEAD_MM + Math.max(1, drawing.datums.length) * ROW_HEIGHT_MM + 4;
  const notes =
    drawing.notes.length > 0
      ? 10 + (drawing.notes.length + 2) * NOTE_LINE_MM
      : 10 + 2 * NOTE_LINE_MM;
  const free =
    COLUMN_HEIGHT_MM - datums - notes - DISCLAIMER_MM - TABLE_HEAD_MM;
  return Math.max(4, Math.floor(free / ROW_HEIGHT_MM));
}

function chunk<T>(items: T[], first: number, rest: number): T[][] {
  const pages = [items.slice(0, first)];
  for (let at = first; at < items.length; at += rest) {
    pages.push(items.slice(at, at + rest));
  }
  return pages;
}

const SHEET_STYLE = `
  @page { size: A3 landscape; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    color: #16211b;
    font-family: Helvetica, Arial, sans-serif;
    font-size: 3mm;
    line-height: 1.25;
    -webkit-print-color-adjust: exact;
  }
  .sheet { position: relative; width: 420mm; height: 297mm; overflow: hidden; page-break-after: always; }
  .sheet:last-child { page-break-after: auto; }
  .frame { position: absolute; left: 20mm; top: 10mm; width: 390mm; height: 277mm; border: 0.5mm solid #16211b; }
  .zones { position: absolute; display: flex; font-size: 2.4mm; color: #16211b; }
  .zones div { flex: 1; display: flex; align-items: center; justify-content: center; }
  .zones.top { left: 20mm; top: 0; width: 390mm; height: 10mm; }
  .zones.bottom { left: 20mm; bottom: 0; width: 390mm; height: 10mm; }
  .zones.left { left: 0; top: 10mm; width: 20mm; height: 277mm; flex-direction: column; }
  .zones.right { right: 0; top: 10mm; width: 10mm; height: 277mm; flex-direction: column; }
  .zones.top div + div, .zones.bottom div + div { border-left: 0.2mm solid #16211b; }
  .zones.left div + div, .zones.right div + div { border-top: 0.2mm solid #16211b; }

  .views { position: absolute; left: 0; top: 0; right: 150mm; bottom: 0; overflow: hidden; }
  .views svg { display: block; width: 239mm; height: 276mm; }
  .part-data { position: absolute; left: 6mm; bottom: 5mm; width: 74mm; border: 0.2mm solid #16211b; }
  .part-data th, .part-data td { font-size: 2.5mm; padding: 0.7mm 1.2mm; }
  .part-data th { text-align: left; }
  .part-data caption { text-align: left; padding: 0 0 1mm; font-size: 2.4mm;
    letter-spacing: 0.08em; text-transform: uppercase; color: #5a6b61; }
  .no-views { position: absolute; left: 0; top: 0; right: 150mm; bottom: 0;
    display: flex; align-items: center; justify-content: center; padding: 20mm;
    text-align: center; color: #5a6b61; }

  .tables { position: absolute; right: 0; top: 0; width: 150mm; height: 207mm;
    border-left: 0.35mm solid #16211b; padding: 3mm; overflow: hidden; }
  .tables.wide { position: absolute; left: 0; right: 0; top: 0; width: auto; height: 207mm; border-left: 0; }
  .tables h2 { margin: 0 0 1.5mm; font-size: 2.8mm; letter-spacing: 0.08em; text-transform: uppercase; color: #5a6b61; }
  .tables h2 + table { margin-bottom: 4mm; }
  table { width: 100%; border-collapse: collapse; font-size: 2.6mm; }
  th, td { border: 0.2mm solid #16211b; padding: 0.8mm 1.2mm; text-align: left; vertical-align: top; }
  th { background: #eef3f0; font-size: 2.4mm; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 600; }
  td.datum, td.symbol { font-weight: 700; text-align: center; }
  td.symbol .balloon { display: inline-block; width: 5mm; height: 5mm; line-height: 4.6mm;
    border: 0.2mm solid #16211b; border-radius: 50%; text-align: center; font-size: 2.5mm; }
  .clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .notes { margin-top: 3mm; border: 0.2mm solid #16211b; padding: 1.5mm 2mm; }
  .notes strong { display: block; font-size: 2.4mm; letter-spacing: 0.08em; text-transform: uppercase; color: #5a6b61; }
  .notes ol { margin: 1mm 0 0; padding-left: 4mm; font-size: 2.6mm; }
  .continued { margin-top: 2mm; font-size: 2.4mm; color: #5a6b61; }

  .title-block { position: absolute; right: 0; bottom: 0; width: 150mm; height: 69mm;
    overflow: hidden; border-top: 0.35mm solid #16211b; border-left: 0.35mm solid #16211b; }
  .title-block table { table-layout: fixed; font-size: 2.8mm; }
  .title-block td { border: 0.2mm solid #16211b; padding: 1.2mm 1.6mm; vertical-align: top; overflow: hidden; }
  .title-block td:first-child { border-left: 0; }
  .title-block tr:first-child td { border-top: 0; }
  .title-block small { display: block; font-size: 2.2mm; letter-spacing: 0.08em;
    text-transform: uppercase; color: #5a6b61; }
  .title-block b { display: block; font-size: 3.2mm; font-weight: 600; }
  .title-block .part-title b { font-size: 4.6mm; }
  .title-block .owner b { font-size: 4mm; }
  .title-block .owner span { font-size: 2.4mm; color: #5a6b61; }
  .title-block .projection { text-align: center; vertical-align: middle; }
  .disclaimer { margin: 2mm 0 0; font-size: 2.3mm; color: #5a6b61; }
`;

/** ISO 128 first-angle projection symbol (truncated cone). */
const PROJECTION_SYMBOL = `<svg viewBox="0 0 34 14" width="26mm" height="10.7mm" xmlns="http://www.w3.org/2000/svg">
  <g fill="none" stroke="#16211b" stroke-width="0.5">
    <path d="M2 4.5L14 1.5L14 12.5L2 9.5Z"/>
    <path d="M0.5 7L15.5 7" stroke-dasharray="2.4 1 0.6 1"/>
    <circle cx="26" cy="7" r="5.5"/>
    <circle cx="26" cy="7" r="2.6"/>
    <path d="M18.5 7L33.5 7" stroke-dasharray="2.4 1 0.6 1"/>
    <path d="M26 0L26 14" stroke-dasharray="2.4 1 0.6 1"/>
  </g>
</svg>`;

function zoneMarkers(): string {
  const columns = Array.from(
    { length: ZONE_COLUMNS },
    (_, index) => `<div>${index + 1}</div>`,
  ).join("");
  const rows = Array.from(
    { length: ZONE_ROWS },
    (_, index) => `<div>${String.fromCharCode(65 + index)}</div>`,
  ).join("");
  return [
    `<div class="zones top">${columns}</div>`,
    `<div class="zones bottom">${columns}</div>`,
    `<div class="zones left">${rows}</div>`,
    `<div class="zones right">${rows}</div>`,
  ].join("");
}

function viewsBlock(input: DrawingSheetInput): string {
  if (!input.viewsSvg) {
    return `<div class="no-views"><p>${escapeHtml(input.viewsNote)}</p></div>`;
  }
  const rows = input.partData
    .map(
      (item) =>
        `<tr><th>${escapeHtml(item.label)}</th><td>${escapeHtml(item.value)}</td></tr>`,
    )
    .join("");
  const data = rows
    ? `<table class="part-data"><caption>Part data (from the CAD model)</caption><tbody>${rows}</tbody></table>`
    : "";
  return `<div class="views">${input.viewsSvg}${data}</div>`;
}

function datumTable(drawing: DrawingTable): string {
  if (drawing.datums.length === 0) {
    return "<h2>Datum reference frame</h2><table><tbody><tr><td>No datums were proposed for this part.</td></tr></tbody></table>";
  }
  const rows = drawing.datums
    .map(
      (datum) => `<tr>
          <td class="datum">${escapeHtml(datum.label)}</td>
          <td><span class="clamp">${escapeHtml(datum.feature)}</span></td>
          <td><span class="clamp">${escapeHtml(datum.reason || "—")}</span></td>
        </tr>`,
    )
    .join("");
  return `<h2>Datum reference frame</h2>
    <table>
      <colgroup><col style="width:10mm"><col style="width:45mm"><col></colgroup>
      <thead><tr><th>Datum</th><th>Feature</th><th>Selection rationale</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function dimensionTable(
  drawing: DrawingTable,
  rows: DrawingTable["rows"],
  offset: number,
  continued: boolean,
  ballooned: Set<number>,
): string {
  const body = rows
    .map((row, index) => {
      const number = offset + index + 1;
      const marker = ballooned.has(number)
        ? `<span class="balloon">${number}</span>`
        : String(number);
      return `<tr>
          <td class="symbol">${marker}</td>
          <td><span class="clamp">${escapeHtml(row.feature)}</span></td>
          <td>${escapeHtml(row.nominal || "—")}</td>
          <td>${escapeHtml(row.tolerance || "—")}</td>
          <td class="symbol">${escapeHtml(row.datums || "—")}</td>
          <td class="symbol">${row.kind === "gdt" ? "GD&amp;T" : "DIM"}</td>
          <td><span class="clamp">${escapeHtml(row.note || "—")}</span></td>
        </tr>`;
    })
    .join("");
  const heading = continued
    ? `Dimensions + geometric controls (continued, ${offset + 1}–${offset + rows.length} of ${drawing.rows.length})`
    : ballooned.size > 0
      ? "Dimensions + geometric controls (circled = on the views)"
      : "Dimensions + geometric controls";
  return `<h2>${escapeHtml(heading)}</h2>
    <table>
      <colgroup><col style="width:7mm"><col><col style="width:22mm"><col style="width:22mm"><col style="width:14mm"><col style="width:12mm"><col style="width:30mm"></colgroup>
      <thead><tr><th>No.</th><th>Feature</th><th>Nominal</th><th>Tolerance</th><th>Datums</th><th>Type</th><th>Note</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function notesBlock(drawing: DrawingTable, tolerance: string): string {
  const items = [
    `General tolerance ${escapeHtml(tolerance)} unless otherwise stated.`,
    `All dimensions in ${escapeHtml(drawing.units || "mm")}. Remove burrs and sharp edges.`,
    ...drawing.notes.map((note) => escapeHtml(note)),
  ];
  return `<div class="notes"><strong>Notes</strong><ol>${items
    .map((item) => `<li>${item}</li>`)
    .join("")}</ol></div>`;
}

function titleBlock(
  input: DrawingSheetInput,
  tolerance: string,
  sheet: number,
  sheets: number,
): string {
  const drawing = input.drawing;
  // Sequential drawing name when the drawing has one; older drawings keep the
  // identifier-derived number.
  const number =
    drawing.name || drawing.id.replaceAll("-", "").slice(0, 10).toUpperCase();
  const date = input.drawnAt.toISOString().slice(0, 10);
  const cell = (caption: string, value: string): string =>
    `<td><small>${escapeHtml(caption)}</small><b>${escapeHtml(value)}</b></td>`;
  return `<div class="title-block">
    <table>
      <colgroup><col style="width:38mm"><col style="width:38mm"><col style="width:26mm"><col></colgroup>
      <tbody>
        <tr style="height:21mm">
          <td class="owner" colspan="2"><small>Drawn by</small><b>QuoteReady Studio</b>
            <span>Drawing table generated by the Zoo agent</span></td>
          <td class="part-title" colspan="2"><small>Title</small><b>${escapeHtml(drawing.partName)}</b></td>
        </tr>
        <tr style="height:16mm">
          ${cell("Material", input.material || "Not specified")}
          ${cell("General tolerance", tolerance)}
          ${cell("Units", drawing.units || "mm")}
          <td class="projection" rowspan="2"><small>Projection (first angle)</small>${PROJECTION_SYMBOL}</td>
        </tr>
        <tr style="height:16mm">
          ${cell("Drawing no.", number)}
          ${cell("Source file", drawing.fileName)}
          ${cell("Date", date)}
        </tr>
        <tr style="height:16mm">
          ${cell("Scale", input.scale?.label ?? "NTS")}
          ${cell("Revision", "00")}
          ${cell("Sheet", `${sheet} / ${sheets}`)}
          ${cell("Standard", "ISO 128 · ISO 7200")}
        </tr>
      </tbody>
    </table>
  </div>`;
}

/**
 * Render the complete drawing sheet set. Sheet 1 carries the views, the datum
 * frame and as many tolerance rows as fit; any remaining rows continue on
 * full-width sheets that repeat the frame and title block.
 */
export function drawingSheetHtml(input: DrawingSheetInput): string {
  const drawing = input.drawing;
  const tolerance = drawing.generalTolerance || "ISO 2768-m (assumed)";
  const ballooned = new Set(input.balloonedRows ?? []);
  const firstRows = firstSheetRows(drawing);
  const pages = chunk(drawing.rows, firstRows, CONTINUATION_ROWS);
  const sheets = pages.length;

  const body = pages
    .map((rows, index) => {
      const offset =
        index === 0 ? 0 : firstRows + (index - 1) * CONTINUATION_ROWS;
      const remaining = drawing.rows.length - (offset + rows.length);
      const tables = [
        index === 0 ? datumTable(drawing) : "",
        dimensionTable(drawing, rows, offset, index > 0, ballooned),
        remaining > 0
          ? `<p class="continued">${remaining} further row${remaining === 1 ? "" : "s"} continue on sheet ${index + 2}.</p>`
          : "",
        index === 0 ? notesBlock(drawing, tolerance) : "",
        index === 0
          ? `<p class="disclaimer">Datums and tolerances were proposed automatically by the Zoo agent from the CAD geometry. Review them before releasing a controlled drawing.</p>`
          : "",
      ].join("");
      return `<section class="sheet">
        ${zoneMarkers()}
        <div class="frame">
          ${index === 0 ? viewsBlock(input) : ""}
          <div class="tables${index === 0 ? "" : " wide"}">${tables}</div>
          ${titleBlock(input, tolerance, index + 1, sheets)}
        </div>
      </section>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(drawingLabel(drawing))} — technical drawing</title>
<style>${SHEET_STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}
