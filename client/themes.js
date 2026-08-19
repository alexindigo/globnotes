import { computed, ref } from "vue";

// -- globnotes themes -------------------------------------------------------
// The default pair. All other themes fall back to these for colors they
// don't define themselves.

export const GLOBNOTES_LIGHT = {
  brand: "#0284c7",
  background: "#ffffff",
  "background-elevated": "#f3f4f5",
  text: "#2c3139",
  "text-muted": "#8891a1",
  "text-very-muted": "#c1c7d0",
  shadow: "#eceef0",
  border: "#eceef0",
  "code-keyword": "#2563eb",
  "code-string": "#16a34a",
  "code-function": "#0284c7",
  "code-comment": "#64748b",
  "code-number": "#d97706",
  "code-operator": "#0284c7",
  "code-tag": "#2563eb",
  "code-attr": "#0284c7",
  "code-punctuation": "#475569",
};

export const GLOBNOTES_DARK = {
  brand: "#38bdf8",
  background: "#22262c",
  "background-elevated": "#2c3139",
  text: "#c1c7d0",
  "text-muted": "#8891a1",
  "text-very-muted": "#5e6b80",
  shadow: "#22262c",
  border: "#5e6b80",
  "code-keyword": "#60a5fa",
  "code-string": "#4ade80",
  "code-function": "#38bdf8",
  "code-comment": "#94a0b4",
  "code-number": "#fbbf24",
  "code-operator": "#38bdf8",
  "code-tag": "#60a5fa",
  "code-attr": "#38bdf8",
  "code-punctuation": "#94a0b4",
};

// -- Theme list --------------------------------------------------------------
// colors are hex; #RRGGBB. Unset colors fall back to the globnotes default of
// the theme's mode.

export const THEMES = [
  { id: "system", label: "System (follows OS)" },
  { id: "globnotes-light", label: "Globnotes Light", mode: "light", colors: {} },
  { id: "globnotes-dark", label: "Globnotes Dark", mode: "dark", colors: {} },

  {
    id: "dracula",
    label: "Dracula",
    mode: "dark",
    colors: {
      brand: "#bd93f9",
      background: "#282a36",
      "background-elevated": "#44475a",
      text: "#f8f8f2",
      "text-muted": "#6272a4",
      "text-very-muted": "#44475a",
      border: "#44475a",
      "code-keyword": "#ff79c6",
      "code-string": "#f1fa8c",
      "code-function": "#50fa7b",
      "code-comment": "#6272a4",
      "code-number": "#bd93f9",
      "code-operator": "#ff79c6",
      "code-tag": "#ff79c6",
      "code-attr": "#50fa7b",
      "code-punctuation": "#f8f8f2",
    },
  },
  {
    id: "dracula-alucard",
    label: "Dracula Alucard",
    mode: "light",
    colors: {
      brand: "#644ac9",
      background: "#fffbeb",
      "background-elevated": "#efe9d9",
      text: "#1f1f1f",
      "text-muted": "#6c664b",
      "text-very-muted": "#a9a68e",
      border: "#cfcfde",
      "code-keyword": "#a3144d",
      "code-string": "#14710a",
      "code-function": "#644ac9",
      "code-comment": "#6c664b",
      "code-number": "#a34d14",
      "code-operator": "#a3144d",
      "code-tag": "#cb3a2a",
      "code-attr": "#036a96",
      "code-punctuation": "#1f1f1f",
    },
  },

  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    mode: "light",
    colors: {
      brand: "#1e66f5",
      background: "#eff1f5",
      "background-elevated": "#e6e9ef",
      text: "#4c4f69",
      "text-muted": "#6c6f85",
      "text-very-muted": "#9ca0b0",
      border: "#bcc0cc",
      "code-keyword": "#8839ef",
      "code-string": "#40a02b",
      "code-function": "#1e66f5",
      "code-comment": "#8c8fa1",
      "code-number": "#fe640b",
      "code-operator": "#179299",
      "code-tag": "#1e66f5",
      "code-attr": "#179299",
      "code-punctuation": "#5c5f77",
    },
  },
  {
    id: "catppuccin-frappe",
    label: "Catppuccin Frappé",
    mode: "dark",
    colors: {
      brand: "#8caaee",
      background: "#303446",
      "background-elevated": "#414559",
      text: "#c6d0f5",
      "text-muted": "#a5adce",
      "text-very-muted": "#737994",
      border: "#51576d",
      "code-keyword": "#ca9ee6",
      "code-string": "#a6d189",
      "code-function": "#8caaee",
      "code-comment": "#838ba7",
      "code-number": "#ef9f76",
      "code-operator": "#81c8be",
      "code-tag": "#8caaee",
      "code-attr": "#81c8be",
      "code-punctuation": "#b5bfe2",
    },
  },
  {
    id: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    mode: "dark",
    colors: {
      brand: "#8aadf4",
      background: "#24273a",
      "background-elevated": "#363a4f",
      text: "#cad3f5",
      "text-muted": "#a5adcb",
      "text-very-muted": "#6e738d",
      border: "#494d64",
      "code-keyword": "#c6a0f6",
      "code-string": "#a6da95",
      "code-function": "#8aadf4",
      "code-comment": "#8087a2",
      "code-number": "#f5a97f",
      "code-operator": "#8bd5ca",
      "code-tag": "#8aadf4",
      "code-attr": "#8bd5ca",
      "code-punctuation": "#b8c0e0",
    },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    mode: "dark",
    colors: {
      brand: "#89b4fa",
      background: "#1e1e2e",
      "background-elevated": "#313244",
      text: "#cdd6f4",
      "text-muted": "#a6adc8",
      "text-very-muted": "#6c7086",
      border: "#45475a",
      "code-keyword": "#cba6f7",
      "code-string": "#a6e3a1",
      "code-function": "#89b4fa",
      "code-comment": "#7f849c",
      "code-number": "#fab387",
      "code-operator": "#94e2d5",
      "code-tag": "#89b4fa",
      "code-attr": "#94e2d5",
      "code-punctuation": "#bac2de",
    },
  },

  {
    id: "solarized-light",
    label: "Solarized Light",
    mode: "light",
    colors: {
      brand: "#268bd2",
      background: "#fdf6e3",
      "background-elevated": "#eee8d5",
      text: "#657b83",
      "text-muted": "#93a1a1",
      "text-very-muted": "#b8c0c0",
      border: "#eee8d5",
      "code-keyword": "#859900",
      "code-string": "#2aa198",
      "code-function": "#268bd2",
      "code-comment": "#93a1a1",
      "code-number": "#d33682",
      "code-operator": "#859900",
      "code-tag": "#268bd2",
      "code-attr": "#2aa198",
      "code-punctuation": "#657b83",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    mode: "dark",
    colors: {
      brand: "#268bd2",
      background: "#002b36",
      "background-elevated": "#073642",
      text: "#839496",
      "text-muted": "#657b83",
      "text-very-muted": "#586e75",
      border: "#073642",
      "code-keyword": "#859900",
      "code-string": "#2aa198",
      "code-function": "#268bd2",
      "code-comment": "#586e75",
      "code-number": "#d33682",
      "code-operator": "#859900",
      "code-tag": "#268bd2",
      "code-attr": "#2aa198",
      "code-punctuation": "#839496",
    },
  },

  {
    id: "gruvbox-light",
    label: "Gruvbox Light",
    mode: "light",
    colors: {
      brand: "#af3a03",
      background: "#fbf1c7",
      "background-elevated": "#ebdbb2",
      text: "#3c3836",
      "text-muted": "#928374",
      "text-very-muted": "#bdae93",
      border: "#d5c4a1",
      "code-keyword": "#9d0006",
      "code-string": "#79740e",
      "code-function": "#427b58",
      "code-comment": "#928374",
      "code-number": "#8f3f71",
      "code-operator": "#9d0006",
      "code-tag": "#af3a03",
      "code-attr": "#427b58",
      "code-punctuation": "#3c3836",
    },
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    mode: "dark",
    colors: {
      brand: "#fe8019",
      background: "#282828",
      "background-elevated": "#3c3836",
      text: "#ebdbb2",
      "text-muted": "#928374",
      "text-very-muted": "#665c54",
      border: "#504945",
      "code-keyword": "#fb4934",
      "code-string": "#b8bb26",
      "code-function": "#8ec07c",
      "code-comment": "#928374",
      "code-number": "#d3869b",
      "code-operator": "#fb4934",
      "code-tag": "#fe8019",
      "code-attr": "#8ec07c",
      "code-punctuation": "#ebdbb2",
    },
  },

  {
    id: "nord",
    label: "Nord",
    mode: "dark",
    colors: {
      brand: "#88c0d0",
      background: "#2e3440",
      "background-elevated": "#3b4252",
      text: "#d8dee9",
      "text-muted": "#7b88a1",
      "text-very-muted": "#4c566a",
      border: "#434c5e",
      "code-keyword": "#81a1c1",
      "code-string": "#a3be8c",
      "code-function": "#88c0d0",
      "code-comment": "#616e88",
      "code-number": "#b48ead",
      "code-operator": "#81a1c1",
      "code-tag": "#8fbcbb",
      "code-attr": "#88c0d0",
      "code-punctuation": "#d8dee9",
    },
  },

  {
    id: "tokyo-night",
    label: "Tokyo Night",
    mode: "dark",
    colors: {
      brand: "#7aa2f7",
      background: "#1a1b26",
      "background-elevated": "#24283b",
      text: "#a9b1d6",
      "text-muted": "#565f89",
      "text-very-muted": "#414868",
      border: "#24283b",
      "code-keyword": "#bb9af7",
      "code-string": "#9ece6a",
      "code-function": "#7aa2f7",
      "code-comment": "#565f89",
      "code-number": "#ff9e64",
      "code-operator": "#bb9af7",
      "code-tag": "#f7768e",
      "code-attr": "#73daca",
      "code-punctuation": "#a9b1d6",
    },
  },
  {
    id: "tokyo-night-light",
    label: "Tokyo Night Light",
    mode: "light",
    colors: {
      brand: "#2959aa",
      background: "#e6e7ed",
      "background-elevated": "#d5d6db",
      text: "#343b58",
      "text-muted": "#6c6e75",
      "text-very-muted": "#9699a3",
      border: "#d5d6db",
      "code-keyword": "#5a3e8e",
      "code-string": "#385f0d",
      "code-function": "#2959aa",
      "code-comment": "#6c6e75",
      "code-number": "#965027",
      "code-operator": "#5a3e8e",
      "code-tag": "#8c4351",
      "code-attr": "#33635c",
      "code-punctuation": "#343b58",
    },
  },
];

// -- Engine ------------------------------------------------------------------

const STORAGE_KEY = "globnotes-theme";

export const currentTheme = ref(localStorage.getItem(STORAGE_KEY) || "system");
export const currentThemeLabel = computed(() => {
  if (currentTheme.value === "system") {
    return "System";
  }
  const theme = THEMES.find((t) => t.id === currentTheme.value);
  return theme ? theme.label : "System";
});

function hexToRgbTriplet(hex) {
  const value = hex.replace("#", "");
  const n = parseInt(value, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function resolveThemeId(id) {
  if (id !== "system") {
    return id;
  }
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "globnotes-dark" : "globnotes-light";
}

function applyTheme(id) {
  const resolvedId = resolveThemeId(id);
  const theme = THEMES.find((t) => t.id === resolvedId);
  if (!theme) {
    return;
  }
  const defaults = theme.mode === "dark" ? GLOBNOTES_DARK : GLOBNOTES_LIGHT;
  const colors = { ...defaults, ...theme.colors };
  const root = document.documentElement;
  for (const [name, value] of Object.entries(colors)) {
    root.style.setProperty(
      `--theme-${name}`,
      value.startsWith("#") ? hexToRgbTriplet(value) : value,
    );
  }
  // The .dark class drives the handful of class-based overrides.
  document.body.classList.toggle("dark", theme.mode === "dark");
  // Native widgets + scrollbars follow the mode.
  root.style.colorScheme = theme.mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.content = colors.background;
  }
}

let systemListenerBound = false;

export function setTheme(id) {
  currentTheme.value = id;
  localStorage.setItem(STORAGE_KEY, id);
  applyTheme(id);
}

export function initTheme() {
  applyTheme(currentTheme.value);
  if (!systemListenerBound) {
    systemListenerBound = true;
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (currentTheme.value === "system") {
          applyTheme("system");
        }
      });
  }
}
