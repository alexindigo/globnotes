// One fragment grammar, one module. Every UI element that wants a URL
// fragment delegates here for parsing/serialization; Note.vue decides WHEN
// a fragment is written and does so with path-string router navigations —
// hash-only location objects re-serialize the title param into %2F, and raw
// history calls corrupt vue-router's history.state bookkeeping.
//
// Grammar: #<mode>[:L<n>[-<m>]][:<future-aspect>...]
//   view:            #view, optionally with a line aspect for the rendered
//                    highlight: #view:L12, #view:L12-34
//   WYSIWYG editing: #edit
//   source editing:  #source, with the caret/selection as a line aspect:
//                    #source:L12, #source:L12-34

const MODES = ["edit", "source", "view"];
// Modes whose fragment carries the line aspect.
const LINE_MODES = ["source", "view"];

function parseLineAspect(segment) {
  const m = /^L(\d+)(?:-(?:L)?(\d+))?$/.exec(segment || "");
  if (!m) return null;
  const a = Math.max(1, parseInt(m[1], 10));
  const b = m[2] !== undefined ? Math.max(1, parseInt(m[2], 10)) : a;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

export function parseFragment(hash) {
  const empty = { mode: null, line: null };
  if (!hash || hash[0] !== "#") return empty;
  const segments = hash.slice(1).split(":");
  const mode = MODES.includes(segments[0]) ? segments[0] : null;
  if (!mode) return empty;
  const line = LINE_MODES.includes(mode) ? parseLineAspect(segments[1]) : null;
  return { mode, line };
}

export function serializeFragment(frag) {
  if (!frag || !frag.mode) return "";
  let out = `#${frag.mode}`;
  if (LINE_MODES.includes(frag.mode) && frag.line) {
    out += frag.line.from === frag.line.to
      ? `:L${frag.line.from}`
      : `:L${frag.line.from}-${frag.line.to}`;
  }
  return out;
}
