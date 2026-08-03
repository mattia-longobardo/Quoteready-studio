/**
 * SVG primitives of the annotated technical drawing, all in paper millimetres:
 * ISO 129 linear dimensions, ISO 5459 datum indicators, ISO 1101 feature
 * control frames with drawn (font-independent) geometric symbols, ISO 6433
 * item balloons, ISO 128 cutting-plane lines and section hatching — plus the
 * occupancy map that keeps them from overlapping each other or the views.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ISO 128 line widths: 0.18 mm for annotation, 0.4 mm for visible outlines. */
const THIN = 'stroke="#16211b" stroke-width="0.18" fill="none"';
const THICK = 'stroke="#16211b" stroke-width="0.4" fill="none"';
const INK = "#16211b";
const FONT = 'font-family="Helvetica, Arial, sans-serif"';
/** Nominal text height of dimensions and callouts, in millimetres. */
const TEXT_MM = 3;
const CHAR_MM = 1.75;

export function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

export function segment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): string {
  return `M${round(x0)} ${round(y0)}L${round(x1)} ${round(y1)}`;
}

function line(x0: number, y0: number, x1: number, y1: number): string {
  return `<path d="${segment(x0, y0, x1, y1)}" ${THIN}/>`;
}

/** Solid ISO 129 arrowhead, tip at (x, y), pointing along (dx, dy). */
function arrowHead(
  x: number,
  y: number,
  dx: number,
  dy: number,
  size = 2.6,
): string {
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const baseX = x + ux * size;
  const baseY = y + uy * size;
  const half = size * 0.22;
  return `<path d="M${round(x)} ${round(y)}L${round(baseX - uy * half)} ${round(
    baseY + ux * half,
  )}L${round(baseX + uy * half)} ${round(baseY - ux * half)}Z" fill="${INK}"/>`;
}

function textWidth(text: string, size = TEXT_MM): number {
  return text.length * CHAR_MM * (size / TEXT_MM);
}

function label(
  text: string,
  x: number,
  y: number,
  options: {
    size?: number;
    anchor?: "start" | "middle" | "end";
    color?: string;
  } = {},
): string {
  const size = options.size ?? TEXT_MM;
  return `<text x="${round(x)}" y="${round(y)}" fill="${options.color ?? INK}" font-size="${round(size)}" ${FONT} text-anchor="${options.anchor ?? "middle"}">${text}</text>`;
}

/* ------------------------------------------------------------------ layout */

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function inflate(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + by * 2,
    height: rect.height + by * 2,
  };
}

export function boundsOf(points: Point[], pad = 0): Rect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return inflate(
    {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    },
    pad,
  );
}

/**
 * Keeps track of the paper already used, so every annotation can be pushed to
 * the nearest free spot instead of landing on top of a view or of another
 * callout.
 */
export class Occupancy {
  private readonly taken: Rect[] = [];

  constructor(private readonly bounds: Rect) {}

  reserve(rect: Rect): void {
    this.taken.push(rect);
  }

  free(rect: Rect): boolean {
    if (
      rect.x < this.bounds.x ||
      rect.y < this.bounds.y ||
      rect.x + rect.width > this.bounds.x + this.bounds.width ||
      rect.y + rect.height > this.bounds.y + this.bounds.height
    ) {
      return false;
    }
    return !this.taken.some((other) => overlaps(rect, other));
  }

  /**
   * Nearest free box of `size` whose centre sits on a ray from `target`:
   * directions are tried in the caller's order of preference, radii from the
   * shortest, so leaders stay short.
   */
  place(
    target: Point,
    size: { width: number; height: number },
    directions: Point[],
    radii: number[],
    /** Extra condition, e.g. that the leader stays clear of other views. */
    accept?: (rect: Rect) => boolean,
  ): Rect | null {
    for (const radius of radii) {
      for (const direction of directions) {
        const centre = {
          x: target.x + direction.x * radius,
          y: target.y + direction.y * radius,
        };
        const rect = {
          x: centre.x - size.width / 2,
          y: centre.y - size.height / 2,
          width: size.width,
          height: size.height,
        };
        if (!this.free(rect)) continue;
        if (accept && !accept(rect)) continue;
        return rect;
      }
    }
    return null;
  }
}

/** Unit directions ordered by how close they are to `preferredDeg`. */
export function directions(preferredDeg: number, count = 12): Point[] {
  return Array.from({ length: count }, (_, index) => (index * 360) / count)
    .sort((a, b) => {
      const delta = (value: number): number => {
        const raw = Math.abs(((value - preferredDeg) % 360) + 360) % 360;
        return Math.min(raw, 360 - raw);
      };
      return delta(a) - delta(b);
    })
    .map((degrees) => ({
      x: Math.cos((degrees * Math.PI) / 180),
      y: Math.sin((degrees * Math.PI) / 180),
    }));
}

export function centreOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Where the segment from the centre of `rect` towards `to` leaves the box. */
export function edgePoint(rect: Rect, to: Point): Point {
  const centre = centreOf(rect);
  const dx = to.x - centre.x;
  const dy = to.y - centre.y;
  if (dx === 0 && dy === 0) return centre;
  const scaleX = dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY, 1);
  return { x: centre.x + dx * scale, y: centre.y + dy * scale };
}

/* -------------------------------------------------------------- dimensions */

const EXTENSION_GAP = 1.2;
const EXTENSION_OVERSHOOT = 2;
/** Below this the arrows are turned outwards, as ISO 129 requires. */
const MIN_INSIDE_MM = 7;
/**
 * How far the box a dimension claims reaches back towards the feature. The
 * extension lines themselves may run over the view — that is what they are for
 * — so only the strip next to the dimension line is claimed, which is enough to
 * keep parallel dimension lines apart.
 */
const REACH_MM = 3.5;

export interface DimensionResult {
  svg: string;
  /** Everything the dimension occupies, including its text. */
  rect: Rect;
  /** Middle of the dimension line: where a balloon leader should point. */
  anchor: Point;
}

/**
 * Horizontal ISO 129 dimension between x0 and x1: extension lines growing from
 * `baseY` to the dimension line at `atY`, arrowheads and the value above the
 * line. `atY` above `baseY` or below it both work.
 */
export function horizontalDimension(
  x0: number,
  x1: number,
  baseY: number,
  atY: number,
  text: string,
): DimensionResult {
  const [left, right] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const up = atY <= baseY;
  const direction = up ? -1 : 1;
  const parts = [
    line(
      left,
      baseY + direction * EXTENSION_GAP,
      left,
      atY + direction * EXTENSION_OVERSHOOT,
    ),
    line(
      right,
      baseY + direction * EXTENSION_GAP,
      right,
      atY + direction * EXTENSION_OVERSHOOT,
    ),
  ];
  const inside = right - left >= MIN_INSIDE_MM;
  if (inside) {
    parts.push(
      `<path d="${segment(left, atY, right, atY)}" ${THIN}/>`,
      arrowHead(left, atY, 1, 0),
      arrowHead(right, atY, -1, 0),
    );
  } else {
    parts.push(
      `<path d="${segment(left - 5, atY, right + 5, atY)}" ${THIN}/>`,
      arrowHead(left, atY, -1, 0),
      arrowHead(right, atY, 1, 0),
    );
  }
  const centre = (left + right) / 2;
  const textY = atY - 1.3;
  parts.push(label(text, centre, textY));
  const width = Math.max(right - left, textWidth(text));
  const reach = atY - direction * Math.min(REACH_MM, Math.abs(atY - baseY));
  const far = atY + direction * EXTENSION_OVERSHOOT;
  const spanTop = Math.min(reach, far, textY - TEXT_MM);
  const spanBottom = Math.max(reach, far, textY);
  return {
    svg: parts.join(""),
    rect: {
      x: centre - width / 2 - 1,
      y: spanTop - 0.8,
      width: width + 2,
      height: spanBottom - spanTop + 1.6,
    },
    anchor: { x: centre, y: atY },
  };
}

/** Vertical counterpart of {@link horizontalDimension}; the value is rotated. */
export function verticalDimension(
  y0: number,
  y1: number,
  baseX: number,
  atX: number,
  text: string,
): DimensionResult {
  const [top, bottom] = y0 <= y1 ? [y0, y1] : [y1, y0];
  const left = atX <= baseX;
  const direction = left ? -1 : 1;
  const parts = [
    line(
      baseX + direction * EXTENSION_GAP,
      top,
      atX + direction * EXTENSION_OVERSHOOT,
      top,
    ),
    line(
      baseX + direction * EXTENSION_GAP,
      bottom,
      atX + direction * EXTENSION_OVERSHOOT,
      bottom,
    ),
  ];
  if (bottom - top >= MIN_INSIDE_MM) {
    parts.push(
      `<path d="${segment(atX, top, atX, bottom)}" ${THIN}/>`,
      arrowHead(atX, top, 0, 1),
      arrowHead(atX, bottom, 0, -1),
    );
  } else {
    parts.push(
      `<path d="${segment(atX, top - 5, atX, bottom + 5)}" ${THIN}/>`,
      arrowHead(atX, top, 0, -1),
      arrowHead(atX, bottom, 0, 1),
    );
  }
  const centre = (top + bottom) / 2;
  const textX = atX - 1.3;
  const height = Math.max(bottom - top, textWidth(text));
  const reach = atX - direction * Math.min(REACH_MM, Math.abs(atX - baseX));
  const far = atX + direction * EXTENSION_OVERSHOOT;
  const spanLeft = Math.min(reach, far, textX - TEXT_MM);
  const spanRight = Math.max(reach, far, textX);
  return {
    svg: [
      ...parts,
      `<text transform="translate(${round(textX)} ${round(centre)}) rotate(-90)" fill="${INK}" font-size="${TEXT_MM}" ${FONT} text-anchor="middle">${text}</text>`,
    ].join(""),
    rect: {
      x: spanLeft - 0.8,
      y: centre - height / 2 - 1,
      width: spanRight - spanLeft + 1.6,
      height: height + 2,
    },
    anchor: { x: atX, y: centre },
  };
}

/* ----------------------------------------------------------------- symbols */

type GdtSymbol =
  | "straightness"
  | "flatness"
  | "circularity"
  | "cylindricity"
  | "profile-line"
  | "profile-surface"
  | "angularity"
  | "perpendicularity"
  | "parallelism"
  | "position"
  | "concentricity"
  | "symmetry"
  | "runout"
  | "total-runout";

/** Recognise the geometric characteristic named in a tolerance or feature. */
export function gdtSymbolOf(text: string): GdtSymbol | null {
  const value = text.toLowerCase();
  if (/straight/.test(value)) return "straightness";
  if (/flat/.test(value)) return "flatness";
  if (/cylindric/.test(value)) return "cylindricity";
  if (/circular(ity)?|round/.test(value)) return "circularity";
  if (/angular/.test(value)) return "angularity";
  if (/perpendicular|squareness/.test(value)) return "perpendicularity";
  if (/parallel/.test(value)) return "parallelism";
  if (/position|located|location/.test(value)) return "position";
  if (/concentric|coaxial/.test(value)) return "concentricity";
  if (/symmetr/.test(value)) return "symmetry";
  if (/total\s*runout/.test(value)) return "total-runout";
  if (/runout/.test(value)) return "runout";
  if (/profile.*(line|linea)/.test(value)) return "profile-line";
  if (/profile/.test(value)) return "profile-surface";
  return null;
}

/**
 * ISO 1101 characteristic symbols drawn as geometry rather than glyphs: the
 * print container has no font with the GD&T block, so paths keep the sheet
 * identical everywhere.
 */
function gdtSymbolSvg(
  symbol: GdtSymbol,
  x: number,
  y: number,
  size: number,
): string {
  const at = (u: number, v: number): string =>
    `${round(x + u * size)} ${round(y + v * size)}`;
  const path = (definition: string): string =>
    `<path d="${definition}" fill="none" stroke="${INK}" stroke-width="0.18" stroke-linecap="round"/>`;
  const circle = (cx: number, cy: number, r: number): string =>
    `<circle cx="${round(x + cx * size)}" cy="${round(y + cy * size)}" r="${round(r * size)}" fill="none" stroke="${INK}" stroke-width="0.18"/>`;
  switch (symbol) {
    case "straightness":
      return path(`M${at(0.05, 0.5)}L${at(0.95, 0.5)}`);
    case "flatness":
      return path(
        `M${at(0.05, 0.85)}L${at(0.35, 0.15)}L${at(0.95, 0.15)}L${at(0.65, 0.85)}Z`,
      );
    case "circularity":
      return circle(0.5, 0.5, 0.4);
    case "cylindricity":
      return [
        circle(0.5, 0.5, 0.3),
        path(
          `M${at(0.08, 0.9)}L${at(0.3, 0.1)}M${at(0.7, 0.9)}L${at(0.92, 0.1)}`,
        ),
      ].join("");
    case "profile-line":
      return path(`M${at(0.05, 0.8)}Q${at(0.5, 0.05)} ${at(0.95, 0.8)}`);
    case "profile-surface":
      return [
        path(`M${at(0.05, 0.75)}Q${at(0.5, 0.0)} ${at(0.95, 0.75)}`),
        path(`M${at(0.05, 0.9)}L${at(0.95, 0.9)}`),
      ].join("");
    case "angularity":
      return path(
        `M${at(0.08, 0.9)}L${at(0.95, 0.9)}M${at(0.08, 0.9)}L${at(0.8, 0.2)}`,
      );
    case "perpendicularity":
      return path(
        `M${at(0.5, 0.08)}L${at(0.5, 0.9)}M${at(0.1, 0.9)}L${at(0.9, 0.9)}`,
      );
    case "parallelism":
      return path(
        `M${at(0.3, 0.1)}L${at(0.08, 0.9)}M${at(0.72, 0.1)}L${at(0.5, 0.9)}`,
      );
    case "position":
      return [
        circle(0.5, 0.5, 0.3),
        path(
          `M${at(0.5, 0.05)}L${at(0.5, 0.95)}M${at(0.05, 0.5)}L${at(0.95, 0.5)}`,
        ),
      ].join("");
    case "concentricity":
      return [circle(0.5, 0.5, 0.18), circle(0.5, 0.5, 0.42)].join("");
    case "symmetry":
      return path(
        `M${at(0.5, 0.05)}L${at(0.5, 0.95)}M${at(0.15, 0.32)}L${at(0.85, 0.32)}M${at(0.15, 0.68)}L${at(0.85, 0.68)}`,
      );
    case "runout":
      return path(
        `M${at(0.2, 0.9)}L${at(0.62, 0.1)}L${at(0.68, 0.42)}M${at(0.62, 0.1)}L${at(0.34, 0.3)}`,
      );
    default:
      return path(
        `M${at(0.08, 0.9)}L${at(0.5, 0.1)}M${at(0.42, 0.9)}L${at(0.84, 0.1)}L${at(0.9, 0.42)}M${at(0.84, 0.1)}L${at(0.56, 0.3)}`,
      );
  }
}

/* ---------------------------------------------------- feature control frame */

export interface FrameSpec {
  symbol: GdtSymbol | null;
  /** Tolerance compartment, e.g. "0.10" or "Ø0.20". */
  tolerance: string;
  /** Datum compartments, one letter (or letter pair) each. */
  datums: string[];
}

const FRAME_HEIGHT = 4.6;
const FRAME_PAD = 1.1;

export function frameSize(spec: FrameSpec): { width: number; height: number } {
  const cells = [
    spec.symbol ? FRAME_HEIGHT * 0.8 : 0,
    textWidth(spec.tolerance, 2.7) + FRAME_PAD * 2,
    ...spec.datums.map((datum) => textWidth(datum, 2.7) + FRAME_PAD * 2),
  ].filter((width) => width > 0);
  return {
    width: cells.reduce((sum, width) => sum + Math.max(width, 4), 0),
    height: FRAME_HEIGHT,
  };
}

/** ISO 1101 feature control frame: symbol | tolerance | datum references. */
export function featureControlFrame(rect: Rect, spec: FrameSpec): string {
  const cells: { width: number; content: (x: number) => string }[] = [];
  if (spec.symbol) {
    const width = Math.max(FRAME_HEIGHT * 0.8, 4);
    cells.push({
      width,
      content: (x) =>
        gdtSymbolSvg(
          spec.symbol as GdtSymbol,
          x + (width - FRAME_HEIGHT * 0.62) / 2,
          rect.y + (FRAME_HEIGHT - FRAME_HEIGHT * 0.62) / 2,
          FRAME_HEIGHT * 0.62,
        ),
    });
  }
  for (const text of [spec.tolerance, ...spec.datums]) {
    const width = Math.max(textWidth(text, 2.7) + FRAME_PAD * 2, 4);
    cells.push({
      width,
      content: (x) =>
        label(text, x + width / 2, rect.y + FRAME_HEIGHT - 1.4, { size: 2.7 }),
    });
  }
  const parts = [
    `<rect x="${round(rect.x)}" y="${round(rect.y)}" width="${round(rect.width)}" height="${round(FRAME_HEIGHT)}" fill="#ffffff" stroke="${INK}" stroke-width="0.25"/>`,
  ];
  let x = rect.x;
  cells.forEach((cell, index) => {
    if (index > 0) {
      parts.push(
        `<path d="${segment(x, rect.y, x, rect.y + FRAME_HEIGHT)}" stroke="${INK}" stroke-width="0.25" fill="none"/>`,
      );
    }
    parts.push(cell.content(x));
    x += cell.width;
  });
  return parts.join("");
}

/** Frame plus the leader that ties it to the toleranced feature. */
export function frameWithLeader(
  rect: Rect,
  spec: FrameSpec,
  target: Point,
): string {
  const start = edgePoint(rect, target);
  return [
    `<path d="${segment(start.x, start.y, target.x, target.y)}" ${THIN}/>`,
    arrowHead(target.x, target.y, start.x - target.x, start.y - target.y, 2.2),
    featureControlFrame(rect, spec),
  ].join("");
}

/* ------------------------------------------------------------ datum symbol */

const DATUM_BOX = 4.6;

export function datumBoxSize(): { width: number; height: number } {
  return { width: DATUM_BOX, height: DATUM_BOX };
}

/**
 * ISO 5459 datum feature indicator: a filled triangle seated on the datum
 * surface (or on its extension line), a leader, and the boxed datum letter.
 */
export function datumIndicator(
  rect: Rect,
  letter: string,
  target: Point,
  outward: Point,
): string {
  const size = 2.8;
  // The triangle is seated on the surface with its base, and the leader to the
  // boxed letter starts from its apex, clear of the material.
  const tip = {
    x: target.x + outward.x * size * 0.9,
    y: target.y + outward.y * size * 0.9,
  };
  const perpX = -outward.y;
  const perpY = outward.x;
  const triangle = `<path d="M${round(tip.x)} ${round(tip.y)}L${round(
    target.x + perpX * size * 0.5,
  )} ${round(target.y + perpY * size * 0.5)}L${round(
    target.x - perpX * size * 0.5,
  )} ${round(target.y - perpY * size * 0.5)}Z" fill="${INK}"/>`;
  const start = edgePoint(rect, tip);
  return [
    `<path d="${segment(start.x, start.y, tip.x, tip.y)}" ${THIN}/>`,
    triangle,
    `<rect x="${round(rect.x)}" y="${round(rect.y)}" width="${round(rect.width)}" height="${round(rect.height)}" fill="#ffffff" stroke="${INK}" stroke-width="0.25"/>`,
    label(letter, rect.x + rect.width / 2, rect.y + rect.height - 1.4, {
      size: 3.2,
    }),
  ].join("");
}

/* ---------------------------------------------------------------- balloons */

export const BALLOON_RADIUS = 4;

/** ISO 6433 item reference: numbered circle, leader and dot on the feature. */
export function balloonSvg(centre: Point, target: Point, text: string): string {
  const dx = target.x - centre.x;
  const dy = target.y - centre.y;
  const length = Math.hypot(dx, dy) || 1;
  const startX = centre.x + (dx / length) * BALLOON_RADIUS;
  const startY = centre.y + (dy / length) * BALLOON_RADIUS;
  // A balloon sitting against its control frame needs no leader at all.
  const leader =
    length > BALLOON_RADIUS + 1.5
      ? [
          `<path d="${segment(startX, startY, target.x, target.y)}" ${THIN}/>`,
          `<circle cx="${round(target.x)}" cy="${round(target.y)}" r="0.55" fill="${INK}"/>`,
        ]
      : [];
  return [
    ...leader,
    `<circle cx="${round(centre.x)}" cy="${round(centre.y)}" r="${BALLOON_RADIUS}" fill="#ffffff" stroke="${INK}" stroke-width="0.25"/>`,
    label(text, centre.x, centre.y + 1.1, { size: 3.2 }),
  ].join("");
}

/* ----------------------------------------------------------------- section */

/**
 * ISO 128 cutting-plane line: a long-dash-dot line across the view with a
 * thick stroke at each end, the viewing arrows and the section letters.
 */
export function cuttingPlane(input: {
  from: Point;
  to: Point;
  /** Unit vector the observer looks along. */
  towards: Point;
  letter: string;
}): string {
  const { from, to, towards, letter } = input;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const end = 5;
  const parts = [
    `<path d="${segment(from.x + ux * end, from.y + uy * end, to.x - ux * end, to.y - uy * end)}" stroke="${INK}" stroke-width="0.25" fill="none" stroke-dasharray="6 1.2 1 1.2"/>`,
    `<path d="${segment(from.x, from.y, from.x + ux * end, from.y + uy * end)}" ${THICK}/>`,
    `<path d="${segment(to.x, to.y, to.x - ux * end, to.y - uy * end)}" ${THICK}/>`,
  ];
  for (const at of [from, to]) {
    // The arrow shows the direction of sight; the letter sits beyond its head.
    parts.push(
      `<path d="${segment(at.x, at.y, at.x + towards.x * 5, at.y + towards.y * 5)}" ${THICK}/>`,
      arrowHead(
        at.x + towards.x * 5,
        at.y + towards.y * 5,
        towards.x,
        towards.y,
        3,
      ),
      label(letter, at.x + towards.x * 12.5, at.y + towards.y * 12.5 + 1.2, {
        size: 3.4,
      }),
    );
  }
  return parts.join("");
}
