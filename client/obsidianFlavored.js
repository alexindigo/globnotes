// Preprocessing for Obsidian-flavored markdown. Applied to the viewer's
// source only; the editor continues to show raw syntax. Transforms are
// fence-aware: nothing inside ``` code fences is touched. (Inline code
// spans are not special-cased - an ![[embed]] inside backticks would be
// transformed; rare enough to accept for now.)

const IMAGE_EXTENSIONS = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

function processOutsideCodeFences(source, transform) {
  const lines = source.split("\n");
  const out = [];
  let buffer = [];
  let inFence = false;

  const flush = () => {
    if (buffer.length > 0) {
      out.push(transform(buffer.join("\n")));
      buffer = [];
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!inFence) {
        flush();
        inFence = true;
      } else {
        inFence = false;
      }
      out.push(line);
    } else if (inFence) {
      out.push(line);
    } else {
      buffer.push(line);
    }
  }
  flush();
  return out.join("\n");
}

// ![[image.png]] -> ![](image.png); ![[doc.pdf]] / ![[Note.md]] -> links.
// Note transclusion (![[Note]]) is not supported yet (see
// FutureDevelopment.md), so note embeds render as plain links.
function transformEmbeds(segment) {
  return segment.replace(
    /!\[\[\s*([^\[\]|]+?)(?:\|([^\[\]]*?))?\s*\]\]/g,
    (_, target, alias) => {
      const trimmedTarget = target.trim();
      const text = (alias || trimmedTarget).trim();
      if (IMAGE_EXTENSIONS.test(trimmedTarget)) {
        return `![${text}](${encodeURI(trimmedTarget)})`;
      }
      return `[${text}](${encodeURI(trimmedTarget)})`;
    },
  );
}

// %%comments%% are hidden
function transformComments(segment) {
  return segment.replace(/%%[\s\S]*?%%/g, "");
}

export function preprocessObsidianFlavored(source) {
  if (!source) {
    return source;
  }
  return processOutsideCodeFences(source, (segment) =>
    transformComments(transformEmbeds(segment)),
  );
}
