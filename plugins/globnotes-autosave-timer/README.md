# Autosave timer

This browser-only plugin triggers globnotes' normal Save while a note is open for
editing. It never reads note text or writes files itself. Save keeps you in edit
mode; title and folder changes still apply on Enter or when you leave the field.
New notes are created under their first heading, or as `Untitled` / `Untitled N`.

## Turn it on

Open **Settings → Plugin settings → Autosave timer**, read **Before you turn this on**,
then turn on the **Autosave** switch inside the warning banner. The plugin follows
the vault's normal plugin enablement policy, but this switch is **off by default**.
If the plugin is disabled, enable **Autosave timer** in **Settings → Plugins** too.
Settings belong to the vault and are read when the plugin starts and each time
you enter edit mode. Re-enter edit mode to apply changed timing or toggle settings.

## Before you turn this on

**Changes made elsewhere can create conflict copies.** Autosave uses the normal
base-aware Save: independent line edits merge, while overlapping edits keep your
text in a neighboring conflict copy. Editing then follows that copy; check its
banner to open the original.

**Backups fill up quickly.** With the backup plugin on, every autosave keeps a copy
of the earlier text (2 by default). A few autosaves push out older versions. Raise
Retained versions in the backup settings, or use "Every N seconds" with a longer
interval.

**Mistakes are saved too.** An accidental deletion is written within seconds. Undo
works while the note is open; after that, only backups can bring it back.

Conflict handling belongs to the editor's save owner and the hub, not this timer.
The timer still neither reads note text nor writes files itself.

## Timing

- **After I stop typing** (default): save after **2 seconds** without edits; choose
  a whole number from **1–60 seconds**. Each edit restarts the timer.
- **Every N seconds**: check for unsaved changes every **30 seconds** by default;
  choose a whole number from **5–3600 seconds**. Typing does not postpone a tick.

Clean notes are not saved again. An invalid name or a paused save queue prevents
autosave. A temporarily refused action (for example, while a dialog is open) is
tried again after the selected delay. Closing edit mode clears the timers. Tab
close/hide adds no extra save; the existing drafts and leave-page warning apply.
