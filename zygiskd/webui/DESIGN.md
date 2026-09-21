---
version: alpha
name: OnyxZygisk WebUI
description: A strictly monochrome Android module WebUI. Hierarchy is carried by type, weight, hairlines, spacing and a grayscale surface ramp — never by hue.
colors:
  light:
    background: "#ffffff"
    surface: "#ffffff"
    container: "#f5f5f5"
    container-high: "#ebebeb"
    on-surface: "#000000"
    on-surface-muted: "#5c5c5c"
    on-surface-disabled: "#8a8a8a"
    divider: "#e0e0e0"
    accent: "#000000"
    on-accent: "#ffffff"
  dark:
    background: "#121212"
    surface: "#1a1a1a"
    container: "#242424"
    container-high: "#2e2e2e"
    on-surface: "#ffffff"
    on-surface-muted: "#a3a3a3"
    on-surface-disabled: "#6b6b6b"
    divider: "#333333"
    accent: "#ffffff"
    on-accent: "#000000"
  amoled:
    background: "#000000"
    surface: "#000000"
    container: "#0a0a0a"
    container-high: "#161616"
    on-surface: "#ffffff"
    on-surface-muted: "#9e9e9e"
    on-surface-disabled: "#5e5e5e"
    divider: "#262626"
    accent: "#ffffff"
    on-accent: "#000000"
---

# OnyxZygisk WebUI — Design Standard

## Overview

The WebUI is **strictly monochrome**. Every surface, divider and text tone resolves to a
grayscale value. There is no accent hue, no semantic red/green/amber, and no dynamic colour
extraction.

This is an intentional constraint, not an unfinished palette. It follows from the aim of the
rewrite: the previous Vue build carried a green accent, four status hues and a light/dark/AMOLED
palette that each had to be maintained by hand, and state was signalled by colour in more than
one place. Removing colour entirely removes the whole class of problem.

Because hue is unavailable, hierarchy must come from exactly five levers. Every component
specification below is expressed through them and nothing else:

| Lever | Tokens |
|---|---|
| Type size | 7 roles, see [Typography](#typography) |
| Weight | 400 regular / 500 medium / 600 semibold |
| Hairline | `--onx-hairline`, `--onx-hairline-strong` |
| Surface level | `background` → `surface` → `container` → `container-high` |
| Spacing | 4 px grid, see [Spacing](#spacing) |

### Machine enforcement

`tests/unit/monochrome.test.mjs` scans the **built stylesheet** — not the sources — and fails
the build when:

1. any hex literal is not achromatic;
2. any numeric `rgb()`/`rgba()` value is not achromatic;
3. any chromatic colour keyword reaches a rendered declaration (feature-detection probes inside
   `@supports` preludes are excluded, since they never render);
4. any of the three themes is missing a token from the required set;
5. body or muted text falls below the 4.5:1 WCAG AA floor on **any** surface it can land on —
   `background`, `container` and `container-high`, not just the page canvas;
6. a theme collapses `disabled` and `muted` onto the same value, which would allow the two to be
   used interchangeably.

Scanning build output rather than source means the guard also catches colour arriving through a
Tailwind utility or a third-party component. Check 5 exists because a background-only version
passed a stylesheet whose muted-on-container text measured 3.16:1.

Runtime contrast is checked separately by `tests/site/a11y.spec.ts`, which runs axe over the
rendered gallery in all three themes. The static guard and axe catch different classes of
mistake: the guard reasons about token pairs, axe about what actually composed on screen
(including `opacity`, which the guard cannot see).

## Colors

### Surfaces

Four levels, applied fill-first. Elevation is expressed by filling a container with a lighter
(or, in light theme, slightly darker) gray — **not** by shadow.

| Level | Role |
|---|---|
| `background` | Page canvas. Sits behind everything. |
| `surface` | Persistent bars: top app bar, navigation bar, dialogs. In light theme this equals `background`; the bar is separated by a hairline instead. |
| `container` | Cards, grouped list bodies, section bodies. This is the default "raised" treatment. |
| `container-high` | The top step: pressed/selected rows, input fields, nested panels. |

### Text

| Token | Role |
|---|---|
| `on-surface` | Primary text and icons. |
| `on-surface-muted` | Summaries, captions, unselected navigation labels, placeholder text, and status values that are merely *absent* rather than *inactive*. Clears AA on every surface. |
| `on-surface-disabled` | Genuinely inactive controls only. Exempt from the contrast floor by WCAG, and the only token allowed below it. |
| `on-accent` | Text and icons drawn on an `accent` fill. |

`on-surface-disabled` is the one token WCAG lets below 4.5:1, and the exemption is narrow: it
covers *inactive user interface components*. Two consequences follow.

- **Never express disabled with `opacity`.** Opacity composites to a value neither the guard nor
  a reviewer can predict, and it also drops the text out of the exempt category as far as tooling
  is concerned, because there is nothing marking the element as inactive. Use the token, and mark
  the element `disabled` or `aria-disabled`.
- **An unavailable status value is not an inactive control.** "Not installed" is text the user must
  read, so it uses `on-surface-muted`.

### Accent

`accent` is **pure black in light theme and pure white in dark/amoled**. It marks the single
most important action in view, selected states, and active controls. It is an inversion, not a
hue: a primary button is a solid black rectangle in light theme and a solid white one in dark
theme.

At most **one** accent-filled element should be visible per screen region. Two solid inverted
blocks in the same card is a specification violation.

### Boundaries

| Token | Value | Role |
|---|---|---|
| `divider` | solid, 1 px | List separators, card outlines, bar edges, inactive track fills. |
| `hairline` | 1 px `divider` | Default border. |
| `hairline-strong` | 1 px `on-surface` at 14% | Focus rings, selected outlines, error emphasis. |

### Contrast invariants

Verified at build time for every theme:

| Pair | Floor |
|---|---|
| `on-surface` on `background` / `container` / `container-high` | 4.5:1 |
| `on-surface-muted` on `background` / `container` / `container-high` | 4.5:1 |
| `on-accent` on `accent` | 4.5:1 (implied by the inversion) |
| `on-surface-disabled` | exempt; must differ from `on-surface-muted` |
| `divider` vs any surface | not asserted — decorative boundary, not text |

Both the token-pair table above and the rendered result are asserted, by the guard and by axe
respectively.

## Typography

One family (the platform UI font). No web fonts are loaded: the WebView must render offline and
the CSP forbids remote origins.

| Token | Size | Weight | Line height | Role |
|---|---|---|---|---|
| `text-onx-display` | 28 px | 600 | 36 px | A single large figure, e.g. the module count. |
| `text-onx-title` | 20 px | 600 | 28 px | Page title, top app bar title, dialog title. |
| `text-onx-body` | 16 px | 400 | 24 px | Body copy, list primary text. |
| `text-onx-body-strong` | 16 px | 500 | 24 px | Setting row titles, status values. |
| `text-onx-label` | 14 px | 500 | 20 px | Button labels, field labels, section headers. |
| `text-onx-caption` | 13 px | 400 | 18 px | Setting summaries, helper text, badges. |
| `text-onx-mono` | 13 px | 400 | 18 px | Log lines, paths, versions. Monospace, tabular figures. |

**Rules**

- A component uses at most two type roles. A card with three sizes is a violation.
- Weight, not size, carries emphasis inside a row. `text-onx-body` → `text-onx-body-strong` is the
  preferred promotion; jumping to `text-onx-title` inside a list is not allowed.
- `text-onx-mono` is mandatory for anything a user may copy verbatim (log lines, paths, version
  strings).

`text-onx-mono` is declared as a utility rather than a `--text-*` theme token, because Tailwind's
type sub-tokens cover line-height, letter-spacing and weight but not font-family. A monospace
role defined without a monospace face silently renders in the UI font.

## Layout

### Spacing

4 px grid. Only these values are permitted: **4, 8, 12, 16, 20, 24, 32**.

| Context | Value |
|---|---|
| Inside a control (icon to label) | 8 |
| Card padding | 16 |
| Between rows in a group | 0 (separated by hairline) |
| Between groups | 16 |
| Page horizontal inset | 16 |
| Section top/bottom | 24 |

### Insets

KernelSU injects the safe-area variables through `/internal/insets.css`. Only the
`--window-inset-*` family exists — there is no `--top-inset` family.

```
--onx-top-inset     : var(--window-inset-top, env(safe-area-inset-top, 0px))
--onx-bottom-inset  : var(--window-inset-bottom, env(safe-area-inset-bottom, 0px))
--onx-left-inset    : var(--window-inset-left, env(safe-area-inset-left, 0px))
--onx-right-inset   : var(--window-inset-right, env(safe-area-inset-right, 0px))
```

Bars add their inset to their own height; scrollable content pads by the inset only where it is
not already covered by a persistent bar.

### Radius

| Token | Value | Applied to |
|---|---|---|
| `radius-onx-sm` | 6 px | Badges, small swatches |
| `radius-onx-md` | 10 px | Buttons, inputs, snackbars |
| `radius-onx-lg` | 14 px | Cards, dialogs |
| `radius-full` | 9999 px | Switches, pills |

Radii are consistent per class. A card is never `radius-sm`; a badge is never `radius-lg`.

## Elevation & Depth

There are **no shadows**. On a `#000000` or `#121212` canvas a black shadow is invisible, and
on `#ffffff` it degrades into a grey blur that reads as grime rather than depth. The previous
Vue build used a green-tinted hero shadow for exactly this reason, and it was the first thing the
monochrome ramp made impossible to keep.

Depth is expressed by exactly three means:

1. **Surface step** — moving a block from `background` to `container` to `container-high`.
2. **Boundary** — a `hairline` where two adjacent surfaces are the same level.
3. **Scrim** — modal overlays only: `rgb(0 0 0 / 32%)` in light, `rgb(0 0 0 / 60%)` in
   dark and amoled. In amoled the scrim is effectively invisible against the pure-black canvas;
   the modal is separated by its `surface` fill instead. This is accepted.

## Shapes

The system is **geometric, not organic**: small consistent radii, flat fills, straight hairlines.
No shape morphing, no capsule-shaped cards, no asymmetric corners.

## Components

Layering follows the repository convention: `atoms` → `molecules` → `views`. Imports only
point upward. A molecule may compose atoms; an atom never imports a molecule or a view.

### Tier A — required before any view can be rebuilt

**Atoms**

| Component | Surface | Boundary | Notes |
|---|---|---|---|
| `Button` | variant-dependent | variant-dependent | primary / secondary / ghost |
| `IconButton` | transparent | transparent | Square hit area, `aria-label` mandatory |
| `Card` | `container` | none | `pressable` adds a pressed fill step |
| `Divider` | — | `hairline` | Full-bleed or 16 px inset |
| `Icon` | — | — | Material Symbols, 16/20/24 px, inherits `currentColor` |
| `ProgressIndicator` | — | — | Circular (stroke ring) and linear (2 px track) |
| `Badge` | `accent` or transparent | optional `hairline` | 20 px tall, `text-caption` |
| `Switch` | track `container-high` → `accent` | `hairline` when off | Headless UI |

**Molecules**

| Component | Composes | Notes |
|---|---|---|
| `SettingRow` | `Icon`, `Divider`, trailing control | The workhorse. Variants: plain, switch, list, separator |
| `SectionHeader` | — | `text-label`, `on-surface-muted`, 16 px inset |
| `TopAppBar` | `IconButton`, `Icon` | 56 px + `--onx-top-inset`, `surface` fill, bottom hairline. Always titled with the module name |
| `NavigationBar` | `Icon` | 64 px + `--onx-bottom-inset`, top hairline, one item per tab |
| `Dialog` | `Button` | Headless UI, max-width 360 px, `radius-lg`, `scrim` overlay |
| `SnackbarHost` | — | Inverse surface, 48 px min height, `radius-md`, queued, `aria-live` |
| `StatusField` | `Icon` | Label + value + tone; values wrap rather than truncate |
| `ChoiceRow` | `SettingRow`, `Dialog` | A copy-free picker: appearance and mount mode both use it |
| `LanguageRow` | `SettingRow`, `Dialog` | Language picker; changing it reloads the document |

### Component specifications

**Button**

| Variant | Fill | Label | Boundary | Height | Padding |
|---|---|---|---|---|---|
| primary | `accent` | `on-accent` | none | 40 px | 0 20 px |
| secondary | transparent | `on-surface` | `hairline` | 40 px | 0 20 px |
| ghost | transparent | `on-surface` | none | 40 px | 0 12 px |

States: hover fills `container` (secondary/ghost only); pressed fills `container-high`;
`focus-visible` draws `hairline-strong` with 2 px offset; disabled uses `on-surface-disabled`
for the label and `divider` for the fill or boundary. Loading swaps the label for a circular
indicator at the leading edge and sets `aria-busy`.

**SettingRow**

```
[icon]  Title                          [trailing control]
        Summary
────────────────────────────────────────────────────
```

Minimum height 56 px, or 72 px when a summary is present. Horizontal inset 16 px. Title
`text-body-strong`; summary `text-caption` in `on-surface-muted`. The trailing control is
vertically centred. The separator hairline is inset 16 px on the start edge and full-bleed on the
end edge. A row is a `<button>`, `<label>` or `<div>` according to whether it navigates,
toggles or is inert — never a `<div>` with a click handler.

**StatusField** — the semantic-tone problem

Colour previously carried success/error/pending. With no hue available, tone is expressed by
glyph and weight:

| Tone | Treatment |
|---|---|
| normal | no prefix; value in `text-body-strong` |
| error | leading `!` icon; value in `text-body-strong`; field boundary `hairline-strong` |
| pending | leading circular indicator; value in `on-surface-muted` |
| unavailable | muted value text; the string itself states the absence ("Not installed") |

The tone must also be exposed as text, not only as a glyph: the value string itself states what
is wrong ("Monitor stopped", "Not installed"). A screen reader user receives the same information
as a sighted one. This is the rule the previous Vue build's green/red/amber hero badge violated:
"stopped" and "working" differed only by hue.

**Status rows replace the old status hero**

The Vue build pinned a collapsing hero to the top of the page and encoded the whole framework
state in one coloured badge. The app bar now names the module and the Status tab renders one
`StatusField` per fact, so a partially healthy system — monitor tracing while the daemon is
down — reads as exactly that instead of collapsing to a single word.

**Scroll containers hide their scrollbar, and must clip mid-item**

Scrollable regions use `.onx-scroll`, which hides the scrollbar in every engine. The WebUI is
touch-first, where a scrollbar is a desktop affordance rather than a control, and the grayscale
ramp has no colour available to make a native scrollbar sit quietly inside the design.

Hiding it removes the one obvious hint that a list continues, so **a scroll container must clip at
a partial item**. The rule that follows: cap the **container**, never the list, and let the list
fill the remainder. A dialog therefore sets `max-h-[85dvh]` on its panel and `flex-1 min-h-0`
on the list, so the clip lands wherever the viewport puts it — in practice, mid-item. The FN and
module lists are page-length rather than capped, so the navigation bar stays the only fixed
element.

**The app bar names the module, not the page**

Every app bar reads `MODULE_NAME`, and a drill-down adds a back button instead of a page title.
The navigation bar already marks which page is current, so repeating it in the bar was redundant,
and the duplication cost the title the width it needed. The module name is short, stable, and
identifies the product the WebUI belongs to; the content below identifies the page.

**A row that owns a toggle is the control**

`SettingRowSwitch` does not wrap a `<label>` around a control. The control *is* the row: one
`<button role="switch">` containing the row text and the track.

The reason is not stylistic. A `<label>` that both contains the control and points at it with
`htmlFor` forwards the activation a second time, so the value toggles and immediately toggles
back — the user sees nothing happen. The element is also the correct answer for accessible
naming, which a wrapping label never was for a `role="switch"` button.

Inert and navigating rows are still a `div` and a `button` respectively. The rule is only that
a row owning a control must not be a third element sitting on top of it.

**Overlays own one history entry each**

Every modal layer — a picker dialog, the log detail — pushes one entry through
`useOverlayHistory`, so the Android back gesture closes the topmost layer. The host sets
`backInterceptor: native`, which is the only route a native back press has into React state.

**A global key layer claims a key only when it acts on it**

`Keybind` calls `preventDefault` only when a handler returned `true`. A shortcut layer that
always claims its keys swallows them from everything else — `Escape` in particular belongs to
whichever dialog is open, and Headless UI closes its own.

**Naming a control inside a row**

A row that owns a control renders the control itself as the row, and Headless UI renders a
`role="switch"` button. Chromium's accessible-name computation for a button does not consume an
associated label, and Headless UI also drops `aria-labelledby` on those components.

The rule that follows: the control carries `aria-label` copied from the row title. Do not reach
for `aria-labelledby` here, and do not assume the surrounding text did the job — verify the
computed name, because the failure mode is silent and axe reports it only as
`aria-input-field-name`.

**SnackbarHost**

Inverse surface — `on-surface` fill with `background` text. A solid black bar on white in
light theme, a solid white bar on black in dark. This is the strongest available emphasis and is
reserved for transient feedback. Minimum height 48 px, `radius-md`, offset from the bottom by
`--onx-bottom-inset` + 16 px. Error snackbars add a leading `!` icon and a `hairline-strong`
boundary; they do not change hue.

**The log panel stays monochrome**

The Vue build colourised logcat lines by level: green for `I`, amber for `W`, red for `E`.
The rewrite cannot, so level is carried by the leading level letter plus weight — `E`/`F` are
semibold and their message is `on-surface`, while `V`/`D` are `on-surface-muted`. The
message text is what the user came to read, so it is never muted by level alone.

Log output is written imperatively into the `<pre>` rather than through React's renderer, so an
auto-refresh does not reset the reader's scroll position. It is the one place in the WebUI that
touches the DOM directly, and it is deliberate.

## Do's and Don'ts

**Do**

- Reach for weight and spacing before reaching for a new size.
- Use `container-high` for a pressed state. It is the only permitted "darker on press" step.
- Keep exactly one accent-filled element per screen region.
- Give every icon-only control an accessible name.
- Add the component's keyboard and focus assertions in the same change that introduces it.

**Don't**

- Introduce any chromatic value. The build fails, and the failure is intentional.
- Use a shadow for elevation.
- Use colour alone to signal state.
- Use `opacity` to express a disabled or unavailable state.
- Put `on-surface-disabled` on text the user is expected to read.
- Add a token that is not on the grayscale ramp — including "just for the disabled state".
- Add a type size outside the seven roles.

## Resolved decisions

Each of these was open at review and is now fixed. The reasoning is recorded so a later change
does not silently undo it.

**Radius — soft (6/10/14 px).** Chosen over a tighter 4/6/8 px set. The system is already
geometric through its flat fills and hairlines; sharper corners on top of that read as severe
rather than modern, and the softer set stays closer to the platform surfaces the WebUI sits
inside. Only the soft set is defined — there is no runtime radius switch, because a second
character with no consumer is dead configuration.

**Navigation bar selected state — `container-high` pill plus medium label weight.** With no hue
available, the surface step is the strongest signal that does not compete with the label. An
indicator bar was rejected as a second, redundant signal; a small bottom stub in particular
looked fussy at 64 px row height.

**Five tabs, not three.** Status, Modules, FN, Logs, Settings are the module's five real feature
areas, and every one of them is reachable in a single tap. Folding FN into Modules or Settings
into the app bar would have meant either a nested navigation the design standard does not define,
or a feature that is only discoverable by accident. Five items at 412 px still clear a 44 px
touch target with room to spare.

**Snackbar — inverse surface.** `on-surface` fill with `background` text: a solid black bar in
light theme, a solid white bar in dark. It is the strongest emphasis the ramp can produce and is
reserved for transient feedback, so it does not compete with the `container` fill that cards use.
The quieter alternative (`container-high` plus a hairline) was rejected because it made a
transient message look like another card.

**Card — fill-based, no boundary.** A `container` fill on the page canvas, with
`container-high` as the pressed step. This keeps elevation entirely on the surface ladder, leaves
the hairline free to mean "separator" rather than "edge", and avoids drawing a border between two
adjacent levels that are already distinct.

**Night mode — an explicit four-way choice, not a single toggle.** The appearance row offers
Automatic, Light, Night and Night (pure black). That is the same four-way set the Vue build
exposed, and both the follow-the-system behaviour and the pure-black theme are worth keeping. The
picker is a dialog rather than a `<select>`: the WebUI is touch-only, and a native dropdown
inside a WebView renders as a desktop popup.

**One `ChoiceRow`, not one picker per setting.** Appearance and mount mode are the same control
with different options, so they share a component. The earlier Vue build had a `<select>` per
setting, which is exactly the desktop affordance the touch-first rule rejects.

## Runtime environment

The WebUI runs inside a KernelSU / APatch / MMRL WebView, where the host injects `window.ksu`
or `window.mmrl`. `src/bridge.ts` is the single seam onto it, and it resolves to the
`kernelsu-alt` package for KernelSU and APatch, plus a small MMRL adapter, because OnyxZygisk
ships to all three hosts. Two things follow, and both are enforced by
`tests/unit/bundle.test.mjs`.

**A release build never fabricates device state.** `src/bridge/dev.ts` answers the status
protocol so development and Playwright can exercise the production code path without a device. It
is installed only under `import.meta.env.DEV`, so Vite removes it from release builds. The
failure mode this prevents is the worst one available: a device with a broken or missing bridge
showing a healthy-looking monitor and module list that no native call produced, leaving the user
convinced the framework is running.

**A release build without a bridge says so.** Rather than rendering the ordinary shell — whose
every field would read "unavailable" for no stated reason — it shows the blocking page from
`renderBridgeUnavailablePage()`.

**Shell output is base64-wrapped.** The WebView bridge mangles non-ASCII bytes on the way back
from the shell, and the module names and descriptions this WebUI renders are routinely Chinese or
emoji. `cli.ts` therefore wraps every command's output in `base64` on the shell side and decodes
it as UTF-8 in the page. The exit status is preserved explicitly, because piping straight into
`base64` would otherwise turn every failed write into a fake success.

## Copy and translation

No component hard-codes user-visible copy. Strings arrive from `i18n`, and the components that
need them together (a picker's options, a row's title and summary) take them as a `labels` prop,
so the owning view supplies the translation rather than the component inventing one.

Three rules, all enforced by `tests/unit/i18n_keys.test.mjs`:

- **Every key used by the sources exists in `en.xml`.** A missing key does not crash — it renders
  the English fallback, which in a translated UI is a silent regression.
- **`en.xml` and `zh-CN.xml` define the same key set.** They are the reference locales; `ja.xml`
  is complete today but is not held to the same guard, so it may lag without failing the build.
- **Placeholders match across locales.** A locale that drops or renames `%s` renders the
  placeholder verbatim.

The English fallback passed to `tr()` is defence in depth, not the source of truth. If it drifts
from `en.xml` the screen shows the `en.xml` text, so tests must assert the shipped copy rather
than the fallback.

## Validation

```sh
pnpm --dir zygiskd/webui exec biome ci ./src   # formatting and lint, no writes
pnpm --dir zygiskd/webui run type-check        # tsc --noEmit, strict
pnpm --dir zygiskd/webui run build             # emits zygiskd/webui/dist
pnpm --dir zygiskd/webui test                  # node --test, incl. the monochrome guard
pnpm --dir zygiskd/webui exec playwright test  # behaviour plus axe in all three themes
```
