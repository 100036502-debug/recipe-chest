# Retro cookbook layer: scroll-craft brief

Interviewed, then authored. The owner answered three questions; everything else
below is an authored decision, not a quotation.

## Owner's answers
- Where: scroll moments inside the app (empty state, recipe detail, cook mode). No landing page.
- Look: retro. Old cookbook, index cards, print.
- Assets: the photos already in the app. Nothing generated.

## Grammar
Working surface, not a film. The app keeps its Tonight shell (dark, sidebar, grid).
Three places become paper under a lamp. The grid, calendar, shopping list and lock
screen are untouched.

## Feeling curve (recipe window)
1. Anticipation: the photograph pins to the top and holds still.
2. Arrival: a pinking-sheared card slides up over it. This is the peak.
3. Focus: ingredients typed in a column, steps with large margin numerals.
4. Progress: red pencil underlines each line as it comes up the window.
5. Resolve: a rubber stamp lands at the foot and the page stops.

## Peak
"The recipe card slides up over the photo like a card pulled from a drawer."
It lives in beat 2 and gets the only large layout change.

## Signature move
Red pencil. Ingredients and steps are underlined as they scroll into view, so what
has been read stays marked. In cook mode the same idea becomes a red reading bar in
the margin beside the step in the middle of the screen.

## Devices (no device twice in a row)
| Beat | Device | Why |
|---|---|---|
| Anticipation to arrival | sticky pin + overlap, slow drift on the photo | Occlusion is the cheapest depth there is |
| Focus | static typography | Quiet before the move |
| Progress | scroll-driven reveal (red pencil) | Marks the reader's place |
| Resolve | scroll-driven stamp | The ending holds |
| Empty chest | one-shot rise | A drawer of cards, nothing to scroll |

## Constraints respected
- CSS only, no new JavaScript, no new requests (CSP unchanged: `script-src 'self'`, data: images only).
- `transform` and `opacity` only for anything that moves.
- Without `animation-timeline` support the layout is intact; the pencil, stamp motion and reading bar stay still.
- Reduced motion: the photo stops pinning; app.css already disables animation.
- Print stays plain black on white.
- Existing fonts only: DM Serif Display, DM Sans, plus system monospace for typed labels.

## Not verified here
Written without a browser. Check on a real phone and in Firefox (no scroll-driven
animation yet in some versions) before merging.
