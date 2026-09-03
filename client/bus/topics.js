const TOPICS = {
  NOTE_OPEN: "note:open",
  NOTE_CREATE: "note:create",
  NOTE_SAVE: "note:save",
  NOTE_RENAME: "note:rename",
  NOTE_DELETE: "note:delete",
  NOTE_REFS_REWRITTEN: "note:refs-rewritten",
  FILE_UPLOAD: "file:upload",

  SIDEPANEL_OPEN: "sidepanel:open",
  SIDEPANEL_CLOSE: "sidepanel:close",
  SIDEPANEL_SECTION_SHOW: "sidepanel:section-show",
  SIDEPANEL_SECTION_HIDE: "sidepanel:section-hide",

  SETTINGS_MENU_OPEN: "settings-menu:open",
  SETTINGS_MENU_CLOSE: "settings-menu:close",
  SEARCH_MENU_OPEN: "search-menu:open",
  SEARCH_MENU_CLOSE: "search-menu:close",

  MODAL_OPEN: "modal:open",
  MODAL_CLOSE: "modal:close",

  THEME_CHANGE: "theme:change",
  BRAND_CHANGE: "brand:change",

  PLUGIN_TOGGLE: "plugin:toggle",
  PLUGIN_AUTO_ENABLE: "plugin:auto-enable",

  SETTINGS_LINE_NUMBERS: "settings:line-numbers",
  DEBUG_CHANGE: "debug:change",

  SEARCH_PERFORM: "search:perform",
  SEARCH_CHANGE: "search:change",
  SEARCH_INCLUDE_NESTED: "search:include-nested",
  HOME_SEARCH_FOCUS: "search:home-focus",

  EDITOR_MODE_CHANGE: "editor:mode-change",
  NOTE_EDIT_START: "note:edit-start",
  NOTE_EDIT_END: "note:edit-end",

  // Editor action channel — the single integration point for driving the
  // mounted editor. Keybinding layers publish these today; the future
  // command palette, macros, and plugins drive the same topics without
  // touching the editors. Both editors subscribe to the same channel and
  // handle-or-decline: exactly one editor is mounted at a time, so exactly
  // one live subscriber exists per action. Save/exit/toggle-edit are
  // app-level concerns and are handled by Note.vue, not the editors.
  EDITOR_SAVE: "editor:save",
  EDITOR_SAVE_CLOSE: "editor:save-close",
  EDITOR_EXIT_EDIT: "editor:exit-edit",
  EDITOR_TOGGLE_EDIT: "editor:toggle-edit",

  EDITOR_TOGGLE_BOLD: "editor:toggle-bold",
  EDITOR_TOGGLE_ITALIC: "editor:toggle-italic",
  EDITOR_TOGGLE_STRIKETHROUGH: "editor:toggle-strikethrough",
  EDITOR_TOGGLE_INLINE_CODE: "editor:toggle-inline-code",
  EDITOR_INSERT_LINK: "editor:insert-link",
  EDITOR_HEADING_1: "editor:heading-1",
  EDITOR_HEADING_2: "editor:heading-2",
  EDITOR_HEADING_3: "editor:heading-3",
  EDITOR_HEADING_4: "editor:heading-4",
  EDITOR_HEADING_5: "editor:heading-5",
  EDITOR_HEADING_6: "editor:heading-6",
  EDITOR_PARAGRAPH: "editor:paragraph",
  EDITOR_BULLET_LIST: "editor:bullet-list",
  EDITOR_ORDERED_LIST: "editor:ordered-list",
  EDITOR_CHECKLIST_TOGGLE: "editor:checklist-toggle",
  EDITOR_CODE_BLOCK: "editor:code-block",
  EDITOR_BLOCKQUOTE: "editor:blockquote",
  EDITOR_INSERT_TABLE: "editor:insert-table",
  EDITOR_UNDO: "editor:undo",
  EDITOR_REDO: "editor:redo",
  EDITOR_HARD_BREAK: "editor:hard-break",
  EDITOR_LIST_INDENT: "editor:list-indent",
  EDITOR_LIST_OUTDENT: "editor:list-outdent",
  EDITOR_FIND: "editor:find",
  EDITOR_REPLACE: "editor:replace",

  // App-level actions (routed outside the editors).
  APP_NEW_NOTE: "app:new-note",
  APP_GO_HOME: "app:go-home",
  APP_OPEN_SWITCHER: "app:open-switcher",
  APP_OPEN_PALETTE: "app:open-palette",
};

export { TOPICS };
