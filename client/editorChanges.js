// SPDX-License-Identifier: LGPL-3.0-only

// Shortest insert/delete sequence, with equal prefix/suffix removed first.
// Shared by markdown lines and ProseMirror children; this is acknowledgement
// application only, never a merge of independently edited versions.
function sequenceChanges(before, after, key = value => value) {
  const a = before.map(key), b = after.map(key);
  let prefix = 0, aEnd = a.length, bEnd = b.length;
  while (prefix < aEnd && prefix < bEnd && a[prefix] === b[prefix]) prefix++;
  while (aEnd > prefix && bEnd > prefix && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd--; }
  if (prefix === aEnd && prefix === bEnd) return [];
  const left = a.slice(prefix, aEnd), right = b.slice(prefix, bEnd);
  const n = left.length, m = right.length;
  const keys = new Set(left);
  if (!right.some(value => keys.has(value))) return [{ from: prefix, to: aEnd, otherFrom: prefix, otherTo: bEnd }];
  const trace = [], frontier = new Map([[1, 0]]);
  let complete = false;
  for (let depth = 0; depth <= n + m && !complete; depth++) {
    trace.push(new Map(frontier));
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      let x = diagonal === -depth || (diagonal !== depth && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
        ? (frontier.get(diagonal + 1) ?? 0) : frontier.get(diagonal - 1) + 1;
      let y = x - diagonal;
      while (x < n && y < m && left[x] === right[y]) { x++; y++; }
      frontier.set(diagonal, x);
      if (x === n && y === m) { complete = true; break; }
    }
  }
  const matches = [];
  let x = n, y = m;
  for (let depth = trace.length - 1; depth >= 0; depth--) {
    const frontier = trace[depth], diagonal = x - y;
    const previous = diagonal === -depth || (diagonal !== depth && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1)) ? diagonal + 1 : diagonal - 1;
    const previousX = frontier.get(previous) ?? 0, previousY = previousX - previous;
    while (x > previousX && y > previousY) { matches.push([--x, --y]); }
    if (depth) { if (x === previousX) y--; else x--; }
  }
  const changes = [];
  let from = 0, otherFrom = 0;
  for (const [to, otherTo] of [...matches.reverse(), [n, m]]) {
    if (to > from || otherTo > otherFrom) changes.push({ from: prefix + from, to: prefix + to, otherFrom: prefix + otherFrom, otherTo: prefix + otherTo });
    from = to + 1; otherFrom = otherTo + 1;
  }
  return changes;
}

function offsets(values) {
  const result = [0];
  for (const value of values) result.push(result.at(-1) + value.length);
  return result;
}

/** Separate UTF-16 changes in old-document coordinates for CodeMirror. Equal
 * lines stay out of the change set; changed lines are refined by character. */
export function textChanges(before, after) {
  const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = lines(before), b = lines(after), oldOffsets = offsets(a), newOffsets = offsets(b);
  const changes = [];
  for (const group of sequenceChanges(a, b)) {
    const from = oldOffsets[group.from], to = oldOffsets[group.to];
    const next = after.slice(newOffsets[group.otherFrom], newOffsets[group.otherTo]);
    const old = before.slice(from, to);
    for (const part of sequenceChanges(old.split(""), next.split(""))) {
      changes.push({ from: from + part.from, to: from + part.to, insert: next.slice(part.otherFrom, part.otherTo) });
    }
  }
  return changes;
}

/** Mutates one ProseMirror transaction through separate end-to-start steps.
 * Equal subtrees and text spans have no replacement map, preserving their undo
 * entries. Selection mapping (including node/range kind) belongs to the editor. */
export function applyDocumentChanges(tr, before, after, position = 0, root = true) {
  if (before.eq(after)) return tr;
  if (before.type !== after.type) return tr.replaceWith(position, position + before.nodeSize, after);
  if (before.isText) {
    for (const change of textChanges(before.text, after.text).reverse()) tr.insertText(change.insert, position + change.from, position + change.to);
    if (!before.sameMarkup(after)) {
      tr.removeMark(position, position + after.nodeSize);
      for (const mark of after.marks) tr.addMark(position, position + after.nodeSize, mark);
    }
    return tr;
  }
  if (!root && !before.sameMarkup(after)) tr.setNodeMarkup(position, after.type, after.attrs, after.marks);
  const children = node => { const result = []; node.forEach((child, offset) => result.push({ node: child, offset })); return result; };
  const a = children(before), b = children(after), start = position + (root ? 0 : 1);
  const offset = (items, index, node) => index === items.length ? node.content.size : items[index].offset;
  for (const group of sequenceChanges(a, b, child => JSON.stringify(child.node.toJSON())).reverse()) {
    if (group.to - group.from === group.otherTo - group.otherFrom) {
      for (let index = group.to - group.from - 1; index >= 0; index--) {
        const old = a[group.from + index];
        applyDocumentChanges(tr, old.node, b[group.otherFrom + index].node, start + old.offset, false);
      }
    } else {
      const insert = after.content.cut(offset(b, group.otherFrom, after), offset(b, group.otherTo, after));
      tr.replaceWith(start + offset(a, group.from, before), start + offset(a, group.to, before), insert);
    }
  }
  return tr;
}
