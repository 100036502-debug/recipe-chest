// Bounded HTML handling for imported pages.
//
// A lazy regex like /<script[\s\S]*?<\/script>/ backtracks quadratically when
// the input is full of unclosed "<script" runs: 2 MB of that can burn the whole
// function budget. These helpers walk the string once with indexOf instead.

export const MAX_HTML_CHARS = 500_000;

/** Cut fetched HTML down to a size the parsers can handle predictably. */
export function truncateHtml(html) {
  const text = String(html || '');
  return text.length > MAX_HTML_CHARS ? text.slice(0, MAX_HTML_CHARS) : text;
}

/**
 * Remove every <tag ...> ... </tag> block, including unclosed openers (which
 * lose only their own tag text). Linear: each indexOf continues from the end of
 * the previous match, and there is no backtracking.
 */
// toLowerCase() can change a string's length ("İ" becomes two characters),
// which shifts every index found in `lower` against `source`. Lowering only
// ASCII letters keeps the two strings the same length.
export function asciiLower(text) {
  return String(text).replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

export function removeBlocks(html, tag) {
  const source = String(html || '');
  const lower = asciiLower(source);
  const name = String(tag).toLowerCase();

  // "<script" must be a whole tag name: "<stylesheet" and "<scripts" are not
  // scripts, and removing them silently ate real content. A letter or digit
  // right after the name means it is a different tag; anything else ("<script>",
  // "<script ", "</script", or the hostile "<script<script" run) is treated as
  // ours, so hostile markup is still removed rather than kept.
  const isTagAt = (index, prefix) => {
    const after = lower.slice(index + prefix.length, index + prefix.length + 1);
    return !/[a-z0-9]/i.test(after);
  };
  const findOpen = (from) => {
    const prefix = `<${name}`;
    let at = lower.indexOf(prefix, from);
    while (at !== -1 && !isTagAt(at, prefix)) at = lower.indexOf(prefix, at + prefix.length);
    return at;
  };
  const findClose = (from) => {
    const prefix = `</${name}`;
    let at = lower.indexOf(prefix, from);
    while (at !== -1 && !isTagAt(at, prefix)) at = lower.indexOf(prefix, at + prefix.length);
    return at;
  };

  let out = '';
  let cursor = 0;
  let guard = 0;

  for (;;) {
    guard += 1;
    if (guard > MAX_HTML_CHARS) break; // pathological input: stop, do not spin
    const start = findOpen(cursor);
    if (start === -1) break;
    out += source.slice(cursor, start);

    // One scan decides it: if there is no closing tag anywhere after this
    // point, there never will be, so the rest of the document is skipped
    // without searching again. Without this a run of unclosed "<script"
    // rescanned the whole tail on every iteration (billions of comparisons on
    // a 500 KB page).
    const end = findClose(start);
    if (end === -1) {
      const gt = source.indexOf('>', start);
      cursor = gt === -1 ? source.length : gt + 1;
      out += source.slice(cursor);
      return out;
    }
    const endGt = source.indexOf('>', end);
    cursor = endGt === -1 ? source.length : endGt + 1;
  }
  out += source.slice(cursor);
  return out;
}

/**
 * Remove every <!-- ... --> comment in a single pass. An unclosed comment
 * drops the rest of the text, as a browser would. The lazy regex this
 * replaces took quadratic time on a page full of unclosed "<!--".
 */
export function removeComments(html) {
  const source = String(html || '');
  let out = '';
  let cursor = 0;
  for (;;) {
    const start = source.indexOf('<!--', cursor);
    if (start === -1) break;
    out += source.slice(cursor, start) + ' ';
    const end = source.indexOf('-->', start + 4);
    if (end === -1) return out;
    cursor = end + 3;
  }
  return out + source.slice(cursor);
}
