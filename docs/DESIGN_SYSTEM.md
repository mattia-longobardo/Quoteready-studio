# Design system

## Design intent

QuoteReady Studio is a technical workspace inspired by CAD terminals, inspection
sheets, and Zoo's precise product language. The interface should feel like an
engineering instrument: dense enough to compare evidence, but calm enough that
readiness, price, and risk remain legible during a demo.

The dark theme is the default and the design's primary expression; a light theme
ships alongside it for bright rooms and printed screenshots. Both are driven from
the same semantic token set, so components are written once.

The design is not a claim of official Zoo branding. It is a product-specific
system that uses a high-contrast green accent, squared geometry, grid lines,
compact labels, and restrained status colors.

## Visual principles

1. **Evidence has hierarchy.** Part identity, readiness, selected route, and
   expected price lead; traces and assumptions are available without competing.
2. **Status is never color-only.** Ready/review/blocked include text, shape,
   and color.
3. **Controls look actionable.** Buttons, cards, tabs, and upload zones have
   visible boundaries and focus states.
4. **Density must remain readable.** Monospace labels may be compact, but
   explanatory text and interactive labels must not become microprint.
5. **Geometry is the motif.** Square marks, technical borders, grids, and
   operation chains create continuity without decorative noise.
6. **Responsive behavior is designed, not compressed.** Complex grids collapse
   to one-column reading order on small screens.

## Color tokens

All tokens are defined in `apps/web/app/globals.css`. `:root` carries the dark
theme with `color-scheme: dark`; `:root[data-theme="light"]` overrides the same
names with `color-scheme: light`. Components never reference a raw hex value —
they reference the semantic name, which is why one stylesheet serves both themes.

### Semantic palette

| Token | Dark | Light | Use |
|---|---|---|---|
| `--canvas` | `#191a1a` | `#f2f3f0` | Page background |
| `--canvas-deep` | `#131515` | `#e9ebe6` | Inputs and nested technical areas |
| `--surface` | `#202222` | `#fff` | Primary panels |
| `--surface-raised` | `#282b2a` | `#eef0ec` | Hover/raised surface |
| `--surface-soft` | `#242726` | `#f6f7f4` | Subtle grouped surface |
| `--text` | `#f1f3ed` | `#1a1e1b` | Primary text |
| `--text-secondary` | `#bcc3bc` | `#46524a` | Secondary prose |
| `--text-muted` | `#919b93` | `#67736a` | Tertiary labels and metadata |
| `--border` | `#3d4540` | `#d4d9d2` | Standard borders |
| `--border-strong` | `#667169` | `#a2ada4` | Stronger/interactive borders |
| `--green` | `#2bffa6` | `#0c9059` | Primary action, active state, success |
| `--green-ink` | `#052519` | `#fff` | Text on the green action surface |
| `--green-soft` | `#16382a` | `#ddf1e6` | Selected/success background |
| `--blue` / `--blue-soft` | `#4f7cff` / `#1e2d54` | `#2f5fe0` / `#e2e9fb` | Zoo project context |
| `--amber` / `--amber-soft` | `#ffc269` / `#392c1d` | `#b26b00` / `#f7ead6` | Review/warning |
| `--red` / `--red-soft` | `#ff827a` / `#3c2323` | `#c23d33` / `#f9e2e0` | Blocked/error/destructive |

Note that the accent hues invert in intent between themes: on dark the greens and
ambers are luminous foreground colors, on light they are darkened so they keep
contrast against white panels. Never hardcode the dark value in a component.

### Supporting tokens

Chrome and state colors that also flip per theme:

| Token | Use |
|---|---|
| `--grid-line` | Technical grid overlay on the canvas |
| `--topbar-bg`, `--panel-bg`, `--panel-heading-bg`, `--panel-deep` | Translucent chrome layers |
| `--drop-hover`, `--drop-secondary` | File-drop zone states |
| `--row-hover` | Table row hover |
| `--placeholder` | Input placeholder text |
| `--amber-border`, `--amber-text`, `--red-text`, `--blue-text` | Text/border variants tuned for legibility inside tinted banners |
| `--shadow` | Elevation shadow |

Theme-independent tokens live only in `:root`: `--font-sans`, `--font-display`,
`--font-mono` and `--sidebar-width` (`272px`, narrowed to `230px` at
`max-width: 1180px`).

Do not add a new status color when an existing semantic token fits, and never add
a token to only one theme. Verify contrast in the actual rendered state in
**both** themes — muted text on dark panels and green text on green-tinted
backgrounds are the two usual failure points.

## Typography

### Families

- Body (`--font-sans`): Arial, Helvetica, sans-serif.
- Display (`--font-display`): `Helvetica Neue`, `Segoe UI`, Arial, sans-serif.
- Technical metadata (`--font-mono`): `Cascadia Mono`, `SFMono-Regular`,
  Consolas, `Liberation Mono`, monospace.

The stack uses system fonts only, so the standalone image needs no font download
and the CSP needs no external `font-src` origin. The runtime container installs
`ttf-dejavu` purely so headless Chromium has a usable font when rendering PDFs.

### Hierarchy

| Role | Guidance |
|---|---|
| View title | Responsive display size, tight tracking, short line length |
| Panel title | Clear 14–18 px visual weight |
| Body/explanation | At least 13–16 px in normal reading contexts |
| Form label/button | At least 12 px with sufficient letter spacing |
| Technical metadata | Compact monospace, but never the only place critical information appears |
| Numeric KPI | Large display number paired with a text label |

The source contains intentionally compact technical labels, but visible screen
text has a 12 px floor. New work must not introduce content below 12 px. Long
descriptions belong in body styles, not metadata styles, and all compact labels
must still pass a 200% zoom review.

## Spacing and geometry

- Panels use square corners and one-pixel borders.
- Main page padding is responsive with `clamp()`.
- Related controls use 7–14 px internal gaps; major page sections use 24–34 px.
- Technical grids use explicit boundaries rather than shadows.
- Primary, authentication, and secondary buttons have a minimum height of
  44 px; compact inline/icon controls use at least 40 px and become 44 px at
  the mobile breakpoint.
- File zones are large labels whose invisible file input covers the complete
  target.

Do not reduce click targets simply to preserve desktop density. At narrow
breakpoints, allow controls to occupy the full row.

## Layout system

### Desktop

- 272 px sticky sidebar;
- 76 px sticky top bar;
- flexible main content;
- planner split into intake and result columns;
- report evidence and route cards use two-column grids;
- dashboard uses four KPIs plus recent/workflow panels.

### Medium viewport (`<= 1180px`)

- sidebar narrows;
- planner becomes one column;
- dashboard panels stack;
- project and machine grids become two columns.

### Compact navigation (`<= 900px`)

- sidebar becomes an off-canvas navigation drawer;
- scrim and close button are enabled;
- Escape closes the drawer and restores focus;
- reports/folder layout and settings chains simplify;
- top-bar status detail is reduced.

### Mobile (`<= 760px`)

- top bar hides non-essential user/status detail;
- titles, forms, route cards, checks, operation flow, report library, factory
  cards, and settings collapse to one column as needed.
- interactive controls have a minimum height of 44 px.

### Narrow mobile (`<= 430px`)

- RFQ fields become a single column;
- the readiness hero stacks vertically;
- remaining top-bar context is removed to protect action space.

## Core components

### Navigation

The sidebar uses numbered views and `aria-current="page"`. On mobile, the menu
button exposes `aria-controls` and `aria-expanded`; a dedicated close button and
scrim provide redundant dismissal.

### Buttons

- Primary: filled green, uppercase technical label, clear arrow/action mark.
- Secondary/authentication: outlined green.
- Text: green, no container, used for low-emphasis actions.
- Destructive: red text/border and explicit verb such as **Remove** or **Trash**.
- Disabled: reduced opacity plus native `disabled`; never only color.

Every button must have a visible hover and `:focus-visible` state. Icon-only
buttons require an accessible name.

### Technical panel

`.technical-panel` is the main container. A standard heading includes a step
mark, eyebrow label, heading, and optional provider/limit metadata. It should
not be nested repeatedly when a divider is sufficient.

### Upload zone

The whole zone activates the file input. States:

- empty: dashed boundary and accepted-format hint;
- hover/focus: green boundary;
- selected: solid green boundary and filename/size;
- error: a separate alert below the intake panel.

File acceptance in the browser is a convenience; server validation remains
authoritative.

### Status and provenance

| State | Color | Required text |
|---|---|---|
| `ready` | Green | Ready |
| `review` | Amber | Review |
| `blocked` | Red | Blocked |
| deterministic fallback | Amber | Fallback reason |
| Zoo Agent accepted | Green | Provider label |

Badges must remain readable at zoom and should not carry a paragraph. The
explanatory text appears immediately nearby.

### Route card and operation flow

A route card shows fit, factory availability, name, short description,
expected price, lead time, range, and confidence. Selection changes both border
and background. The detail panel below shows the operation sequence and risk
evidence.

Route cards are interactive comparison controls, not navigation links. Preserve
keyboard activation and do not hide non-selected route information.

### Evidence check

Each check pairs a status symbol, label, detail, and source/evidence line.
Symbols (`✓`, `!`, `×`) supplement the textual status encoded by surrounding
content. Screen-reader improvements should add explicit visually-hidden status
text if symbols become ambiguous.

### Empty, loading, and error states

- Empty states explain what is missing and provide the next action.
- Loading states say which engineering phase is running; animation is
  decorative and must not be the only signal.
- Error messages use `role="alert"` where immediate attention is needed.
- Global notices are dismissible and retain readable backend messages.

### Library table controls

Results, Reports, Parts and Drawings share one control set so the four views
stay learnable as a single pattern: free-text search, a multi-select **Status**
filter, a multi-select **Tags** filter where the collection is tagged, and
sortable name / status / updated columns. The header and the rows use identical,
content-independent column tracks, so headers stay aligned with their data
regardless of cell contents.

### Asynchronous item states

Report documents and drawing tables are generated in the background, so their
rows are a state machine, not a static list:

| State | Presentation |
|---|---|
| `generating` | Progress affordance, actions that need the artefact disabled, polling continues across navigation |
| `ready` | View and PDF actions enabled |
| `failed` | Visible bounded error text plus an explicit **Retry** action |

Never present a `generating` item as if it were empty, and never hide a `failed`
item's error behind a generic message — the stored `error` string is the only
diagnostic the user gets.

## Themes and print surfaces

### Theme selection

`UserSettings.theme` is `system`, `light` or `dark`, stored per user and applied
by stamping `data-theme` on the root element. `system` follows the operating
system preference. Because every component reads semantic tokens, adding a
component requires no theme-specific code — but it does require a visual check in
both themes.

### The drawing sheet is not themed

The ISO A3 technical drawing sheet (`apps/web/lib/drawing-sheet.ts`) and the
AI-authored detailed report are deliberately outside the design system: both are
printed documents, so they are fixed black-on-white with drafting line weights,
not application surfaces. They are rendered by headless Chromium with page
JavaScript disabled, so they must be styled entirely by inline CSS with no
custom properties inherited from the app, no external fonts, and no dependence on
the viewer's theme. Do not "fix" their contrast to match the dark UI.

## Accessibility requirements

Current foundations include a skip link, semantic main/nav/aside structure,
visible focus outline, mobile Escape handling, focus restoration, native form
controls, alert roles, and textual status labels.

Every interface change must verify:

- complete keyboard operation without pointer input;
- focus order follows visual/reading order;
- no focus is trapped behind the mobile drawer;
- accessible names for icon-only controls;
- labels remain associated with inputs;
- 200% zoom does not hide actions or require two-axis scrolling for prose;
- status and validation do not rely on color alone;
- motion does not obscure content and respects reduced-motion preferences;
- empty and error states announce meaningful text.

The project does not currently claim formal accessibility conformance. Manual
and automated audits remain part of [Testing](TESTING.md).

## Content style

- Use direct manufacturing language: **Build manufacturing plan**, **Validate
  before quote**, **Supporting drawing**.
- Distinguish **measured**, **declared**, **deterministic**, and **Zoo Agent**.
- Never call indicative ranges quotations.
- Do not say a drawing was reviewed when only presence/signature was checked.
- Do not say a Zoo project was imported when only planner context was selected.
- Prefer concise sentence case over title case in controls.
- Error text should explain the corrective action without exposing internals.

## Adding a component

Before introducing a new visual pattern:

1. check whether a panel, badge, field, card, or empty state already fits;
2. use existing semantic tokens rather than hardcoded near-duplicates, and never
   introduce a token that exists in only one theme;
3. test desktop and both sides of the 1180, 900, 760, and 430 px breakpoints;
4. test in **both** the dark and the light theme;
5. test keyboard, focus, zoom, long text, empty data, and error states — plus the
   `generating` and `failed` states if the component shows a generated artefact;
6. run `npm run format:check`, which covers `apps/web/**/*.css`;
7. document a reusable pattern here if it changes the system.

## Related documents

- [Product](PRODUCT.md) — the interaction goals these patterns serve.
- [Testing](TESTING.md#manual-interface-matrix) — the responsive, keyboard and
  accessibility matrix.
- [Architecture](ARCHITECTURE.md) — the shell, the views, and the drawing
  pipeline that produces the print surfaces.
