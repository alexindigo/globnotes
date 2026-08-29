// Subsequence fuzzy matcher (fzf-lite). No dependency — small enough to
// hand-roll, and we want scoring tuned for note paths/titles.

/**
 * Score `query` as a subsequence of `target` (case-insensitive).
 * Returns { score, positions } when every query char appears in order,
 * or null when it isn't a subsequence.
 *
 * Scoring rewards: consecutive runs, word starts (after space or /-_:.),
 * exact/prefix matches, and earlier matches; penalizes longer targets.
 */
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
  return { score, positions };
}

/**
 * Filter + rank `items` by `query`. `getText(item)` returns the candidate
 * strings to match (e.g. [title, ...aliases, basename]) — the best-scoring
 * candidate wins. Empty query returns items in order (score 0).
 * Returns [{ item, score, positions }] sorted best-first.
 */
export function fuzzyFilter(query, items, getText) {
  if (!query || !query.trim()) {
    return items.map((item) => ({ item, score: 0, positions: [] }));
  }
  const out = [];
  for (const item of items) {
    let best = null;
    for (const text of getText(item)) {
      if (!text) continue;
      const m = fuzzyScore(query, text);
      if (m && (!best || m.score > best.score)) best = m;
    }
    if (best) out.push({ item, score: best.score, positions: best.positions });
  }
  return out.sort((a, b) => b.score - a.score);
}
