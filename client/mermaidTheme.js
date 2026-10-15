// SPDX-License-Identifier: LGPL-3.0-only
// Map the applied app palette into Mermaid's base theme. CSS variables are
// space-separated RGB triplets; Mermaid needs hex values instead.
export function mermaidColor(name, fallback) {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--theme-${name}`).trim();
  if (!raw) return fallback;
  if (raw.startsWith("#")) return raw;
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length === 3 && parts.every((n) => n >= 0 && n <= 255)) {
    return `#${parts.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }
  return fallback;
}

export function mermaidThemeVariables() {
  const v = mermaidColor;
  return {
    background: "transparent",
    primaryColor: v("background-elevated", "#ececff"),
    primaryTextColor: v("text", "#333"),
    primaryBorderColor: v("border", "#999"),
    secondaryColor: v("background", "#ffffde"),
    secondaryTextColor: v("text", "#333"),
    secondaryBorderColor: v("border", "#999"),
    tertiaryColor: v("background-elevated", "#ececff"),
    tertiaryTextColor: v("text", "#333"),
    tertiaryBorderColor: v("border", "#999"),
    noteBkgColor: v("background-elevated", "#fff5ad"),
    noteTextColor: v("text", "#333"),
    noteBorderColor: v("brand", "#999"),
    lineColor: v("text-muted", "#333"),
    textColor: v("text", "#333"),
    mainBkg: v("background-elevated", "#ececff"),
    nodeBorder: v("border", "#999"),
    clusterBkg: v("background", "#ffffde"),
    clusterBorder: v("border", "#999"),
    edgeLabelBackground: v("background-elevated", "#e8e8e8"),
    actorBkg: v("background-elevated", "#ececff"),
    actorBorder: v("border", "#999"),
    actorTextColor: v("text", "#333"),
    actorLineColor: v("text-muted", "#999"),
    signalColor: v("text", "#333"),
    signalTextColor: v("text", "#333"),
    labelBoxBkgColor: v("background-elevated", "#ececff"),
    labelBoxBorderColor: v("border", "#999"),
    labelTextColor: v("text", "#333"),
    loopTextColor: v("text", "#333"),
    activationBkgColor: v("background-elevated", "#ececff"),
    activationBorderColor: v("border", "#999"),
    sequenceNumberColor: v("background", "#fff"),
    // Gantt
    sectionBkgColor: v("background-elevated", "#ececff"),
    altSectionBkgColor: v("background", "#ffffde"),
    sectionBkgColor2: v("background-elevated", "#ececff"),
    taskBkgColor: v("brand", "#ccc"),
    taskTextColor: v("background", "#fff"),
    taskBorderColor: v("border", "#999"),
    taskTextDarkColor: v("text", "#333"),
    taskTextOutsideColor: v("text-muted", "#333"),
    taskTextClickableColor: v("brand", "#003163"),
    activeTaskBkgColor: v("brand", "#ccc"),
    activeTaskBorderColor: v("border", "#999"),
    doneTaskBkgColor: v("text-very-muted", "#bbb"),
    doneTaskBorderColor: v("text-muted", "#999"),
    critBkgColor: v("code-keyword", "#ff8888"),
    critBorderColor: v("border", "#999"),
    todayLineColor: v("brand", "#ff0000"),
    // Pie / state / class shared accents
    pie1: v("brand", "#ccc"),
    pie2: v("code-string", "#ccc"),
    pie3: v("code-function", "#ccc"),
    pie4: v("code-keyword", "#ccc"),
    pie5: v("code-number", "#ccc"),
    pie6: v("code-attr", "#ccc"),
    pie7: v("text-muted", "#ccc"),
    pie8: v("border", "#ccc"),
    pie9: v("code-comment", "#ccc"),
    pie10: v("code-tag", "#ccc"),
    pie11: v("background-elevated", "#ccc"),
    pie12: v("background", "#ccc"),
  };
}
