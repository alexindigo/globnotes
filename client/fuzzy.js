// Subsequence fuzzy matcher (fzf-lite). No dependency — small enough to
// hand-roll, and we want scoring tuned for note paths/titles.

/**
 * Score `query` as a subsequence of `target` (case-insensitive).
 * Returns { score, positions } when every query char appears in order,
 * or null when it isn't a subsequence.
 *
 * Scoring rewards: consecutive runs, word starts (after space or /-_:.),
 * exact/prefix matches, and earlier matches; penalizes longer targets and
 * the spread of the match (gap penalty — a scattered subsequence loses to
 * a contiguous one, which is simply gap 0).
 */
const GAP_PENALTY = 1;

export function fuzzyScore(query, target) {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevIndex = -2;
  const positions = [];

  for (let qi = 0; qi < q.length; qi++) {
    let found = false;
    while (ti < t.length) {
      if (t[ti] === q[qi]) {
        found = true;
        positions.push(ti);
        score += 1;
        if (prevIndex === ti - 1) score += 2; // consecutive run
        if (ti === 0 || /[\s/\-_.]/.test(t[ti - 1])) score += 3; // word start
        prevIndex = ti;
        ti++;
        break;
      }
      ti++;
    }
    if (!found) return null;
  }
  score += Math.max(0, 10 - (positions[0] ?? 0) * 0.5); // earlier first match
  score -= (t.length - q.length) * 0.01; // prefer shorter targets
  // Distance penalty: the wider the spread of matched characters, the
  // weaker the hit. Contiguous matches have gap 0 and are untouched.
  const gap =
    positions[positions.length - 1] - positions[0] + 1 - q.length;
  score -= gap * GAP_PENALTY;
  return { score, positions };
}

/**
 * Filter + rank `items` by `query`. `getText(item)` returns the candidate
 * strings to match (e.g. [title, ...aliases, path]) — or weighted,
 * kind-tagged candidates ({ text, weight, kind }) so callers can rank
 * match classes (title > alias > file > path). The best *weighted* score
 * wins. Empty query returns items in order (score 0).
 * Returns [{ item, score, positions, matchedText, matchedKind }] sorted
 * best-first; matchedKind is null for string candidates / empty query.
 */
export function fuzzyFilter(query, items, getText) {
  if (!query || !query.trim()) {
    return items.map((item) => ({
      item,
      score: 0,
      positions: [],
      matchedText: null,
      matchedKind: null,
    }));
  }
  const out = [];
  for (const item of items) {
    let best = null;
    for (const raw of getText(item)) {
      const cand =
        typeof raw === "string"
          ? { text: raw, weight: 1, kind: null }
          : raw;
      if (!cand?.text) continue;
      const m = fuzzyScore(query, cand.text);
      if (!m) continue;
      const weighted = {
        ...m,
        text: cand.text,
        weight: cand.weight ?? 1,
        kind: cand.kind ?? null,
        score: m.score * (cand.weight ?? 1),
      };
      if (!best || weighted.score > best.score) best = weighted;
    }
    if (best) {
      out.push({
        item,
        score: best.score,
        positions: best.positions,
        matchedText: best.text,
        matchedKind: best.kind,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Split `text` into [{ text, matched }] runs using `positions` (matched
 * character indices from fuzzyScore) so callers can highlight what
 * matched.
 */
export function highlightSegments(text, positions) {
  const set = new Set(positions ?? []);
  const segments = [];
  let current = null;
  for (let i = 0; i < text.length; i++) {
    const matched = set.has(i);
    if (!current || current.matched !== matched) {
      current = { text: text[i], matched };
      segments.push(current);
    } else {
      current.text += text[i];
    }
  }
  return segments;
}

/**
 * Window a matched candidate so the first matched character stays inside
 * the visible area: when `text` exceeds `maxChars`, the head is elided and
 * the window anchors on the tail, keeping the match in view. Positions are
 * re-based into the window. Returns { text, positions, elidedStart }.
 */
export function windowAroundMatch(text, positions, maxChars = 64) {
  if (!positions?.length || text.length <= maxChars) {
    return { text, positions: positions ?? [], elidedStart: false };
  }
  const first = Math.min(...positions);
  let start = Math.max(0, first - 12);
  if (start + maxChars > text.length) {
    start = Math.max(0, text.length - maxChars);
  }
  const shift = start > 0 ? 1 : 0; // room for the ellipsis
  return {
    text: (start > 0 ? "…" : "") + text.slice(start),
    positions: positions.map((p) => p - start + shift),
    elidedStart: start > 0,
  };
}
