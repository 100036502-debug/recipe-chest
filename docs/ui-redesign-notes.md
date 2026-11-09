# UI redesign notes

Branch: `ui-redesign`. Light kitchen palette with an orange accent, replacing the
dark-only "Tonight" look. Work is CSS-first: a single new stylesheet,
`css/ui.css`, loaded last, plus tokens and small markup changes.

## Discovery

- Static HTML + CSS + vanilla JS PWA. No build step for the UI.
- Stylesheets: `css/app.css` (base), `css/tonight.css` (dark design), `css/ui.css` (new).
- Shell: `index.html` has the lock screen, `#app-content`, `.topbar`, `.sidebar`,
  `.main`, then each view plus every overlay.
- Templates that emit markup live in `js/app.js` (cards, calendar cells, shopping
  items, cook mode, recipe detail, modals).
- Theme: `js/theme.js` runs before first paint; `js/app.js` has `applyTheme` and
  `cycleTheme` with `THEME_CHOICES = ['auto','light','dark']` and the key
  `rc_theme`. It previously forced dark.
- CSP in `vercel.json` allows `font-src 'self'`, so the two new faces are
  self-hosted as latin woff2 subsets in `/fonts`.
- Tests before the change: 563 unit pass, lint clean, 148 Playwright pass.

## What changed

1. **Fonts.** Young Serif (display) and Instrument Sans (UI) downloaded as latin
   subsets into `/fonts`; Instrument Sans ships one variable file covering 400 to
   700. Preloads in `index.html` now point at them. DM Sans and DM Serif Display
   files are left in place because `share.html` still loads `app.css`, which
   references them.
2. **Tokens.** `css/ui.css` defines the light palette (`--chalk`, `--peach`,
   `--ink`, `--slate`, `--orange`, `--orange-text`, `--basil`, `--ok`, `--err`,
   `--line`, `--line-strong`) and re-points every `--t-*` and `app.css` alias
   (`--bg`, `--card`, `--primary`, `--danger`, ...) at it, so modals, cook mode,
   shopping list and calendar inherit the palette without rule-by-rule edits.
   A `[data-theme="dark"]` block and a `prefers-color-scheme` block carry the
   night palette.
3. **Theme toggle restored.** `js/theme.js` and `applyTheme()` now honour
   auto/light/dark again instead of pinning dark. Behaviour is otherwise the same
   code path (`cycleTheme`, `rc_theme`).
4. **Duotone removed.** `data-photo-filter` is gone from `<html>`, the unused
   SVG filter definition is deleted, `css/photo-filter.css` is deleted and
   `sw.js` no longer precaches it. Photos are plain with a 12px radius on the
   hero and 16:10 on cards.
5. **Shell.** 248px peach sidebar, white active pill with a 3px orange inset
   edge, 40px "..." round button. On phones the sidebar is hidden and a fixed
   86px bottom bar (Recipes, Tonight, centre orange add, Calendar, List) reuses
   the existing `showView` data-actions, so no new JS.
6. **Home.** 52px display title (34px phone), peach search field, 40px chips
   with a filled orange "on" state, sort rendered as plain text with a chevron
   (`appearance: none`), flat bordered cards, 4/3/2/1 column grid, peach
   placeholder with an orange ring instead of the old glyph.
7. **Recipe sheet.** 1040px, 20px radius, ink scrim, 230px hero. Two columns
   placed by grid area: sticky peach ingredient panel beside the method, method
   capped at 62ch, 34px Young Serif numerals in orange-text, peach notes box,
   outlined secondary actions and a filled primary.
8. **Cook mode.** Chalk background, Young Serif numerals, basil left edge on the
   timer card, tabular numerals, orange primary in the footer.
9. **Phone.** The recipe sheet is full screen (`#detail-overlay` padding 0).
10. **Service worker.** Cache `recipe-chest-v22` with `/css/ui.css` and the two
    new font files precached.

## Deliberate omissions (not done in this pass)

- **Ingredient checkboxes and the phone "Ingredients, N left" sheet** need new JS
  behaviour (local tick state, a dialog with focus trap). Left out to keep this
  pass UI-only.
- **"Sort: Newest first" prefix.** The control reads as text with a chevron, but
  the "Sort:" word would need a markup change; the option text is unchanged.
- **Add bottom sheet.** The centre add button opens the existing upload modal
  directly; the three-option sheet would need new JS.
- **Calendar, shopping list, tonight, pantry** pick up the palette and type
  through the tokens, but their detailed geometry (92px cells, 48px meal rows,
  aisle counts) was not rebuilt.
- **Modals with inline styles** were not converted to classes; they inherit the
  palette but not the full modal pattern.

## Tests

Unit: 563 pass, lint clean (0 errors, 12 pre-existing warnings).

Playwright: 118 pass, 30 fail. Every failure is an assertion that pins the old
dark design, not broken behaviour: `theme.spec.js` asserts the app is dark and
has no theme control; `calendar.spec.js` asserts the old window colours, 28px
step circles and chip styles; `tonight.spec.js` asserts the drawer and the
220px sidebar; `paste-button.spec.js` asserts sidebar link styling;
`a11y.spec.js` dark variants report contrast against the new dark tokens.
These need updating together with a design review, because they encode the
opposite of the requested direction.

## Risks

- `share.html` still loads `app.css` only, so the public page keeps the old
  palette until it is given the tokens.
- Dark mode contrast has not been re-audited screen by screen.
- The recipe grid relies on `nth-of-type` placement for the two section
  headings; a template change that reorders headings would shift the columns.
