// Shared fixture management for the e2e harnesses — one source of truth for
// the rename-me/moving-note fixture. The rename features move the note and
// rewrite links that point at it; these helpers reset and restore so every
// run starts clean and leaves no trace.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const VAULT = join(homedir(), "globnotes-test-vault");
export const FIXTURE_TITLE = "rename-me/moving-note";

const FIXTURE_NOTE = `# Moving note

This note references an image in its own folder:

![pic](assets/pic.png)
`;

// Reset the fixture: the note back in place, the target folder gone, and
// any links rewritten by earlier runs pointed back at the fixture.
export function resetMovingNoteFixture(target) {
  if (target) {
    rmSync(join(VAULT, target), { recursive: true, force: true });
  }
  rmSync(join(VAULT, "rename-me"), { recursive: true, force: true });
  mkdirSync(join(VAULT, "rename-me", "assets"), { recursive: true });
  writeFileSync(join(VAULT, "rename-me", "moving-note.md"), FIXTURE_NOTE);
  cpSync(
    join(VAULT, "links", "assets", "glob-icon.png"),
    join(VAULT, "rename-me", "assets", "pic.png"),
  );
  restoreMovingNoteLinks();
}

// Restore after a run: move the note + asset back if they moved, drop the
// target folder, and point rewritten links back at the fixture.
export function restoreMovingNoteFixture(target) {
  mkdirSync(join(VAULT, "rename-me", "assets"), { recursive: true });
  if (target) {
    try {
      cpSync(join(VAULT, target, "moving-note.md"), join(VAULT, "rename-me", "moving-note.md"));
    } catch {}
    try {
      cpSync(join(VAULT, target, "assets", "pic.png"), join(VAULT, "rename-me", "assets", "pic.png"));
    } catch {}
    rmSync(join(VAULT, target), { recursive: true, force: true });
  }
  restoreMovingNoteLinks();
}

function restoreMovingNoteLinks() {
  let files = [];
  try {
    files = execSync(`find ${VAULT} -name '*.md' -type f`, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {}
  for (const f of files) {
    const content = readFileSync(f, "utf8");
    const fixed = content.replaceAll(
      /\[\[archive[^/\]]*\/moving-note/g,
      `[[${FIXTURE_TITLE}`,
    );
    if (fixed !== content) {
      writeFileSync(f, fixed);
    }
  }
}
