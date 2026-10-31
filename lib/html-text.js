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
export function removeBlocks(html, tag) {
  const source = String(html || '');
  const open = `<${tag}`;
  const close = `</${tag}`;
  const lower = source.toLowerCase();
  let out = '';
  let cursor = 0;
  let guard = 0;

  for (;;) {
    guard += 1;
    if (guard > MAX_HTML_CHARS) break; // pathological input: stop, do not spin
    const start = lower.indexOf(open, cursor);
    if (start === -1) break;
    out += source.slice(cursor, start);
    const end = lower.indexOf(close, start);
    if (end === -1) {
      // No closing tag at all: drop the rest of this tag's opening markup and
      // carry on after ">", so a run of "<script" cannot rescan the tail.
      const gt = source.indexOf('>', start);
      cursor = gt === -1 ? source.length : gt + 1;
      continue;
    }
    const endGt = source.indexOf('>', end);
    cursor = endGt === -1 ? source.length : endGt + 1;
  }
  out += source.slice(cursor);
  return out;
}
