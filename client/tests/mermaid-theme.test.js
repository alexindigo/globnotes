// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mermaidColor, mermaidThemeVariables } from "../mermaidTheme.js";

afterEach(() => document.documentElement.removeAttribute("style"));

describe("Mermaid app palette", () => {
  it.each([
    ["", "fallback"], ["  #AbC  ", "#AbC"], ["0 15 255", "#000fff"],
    ["  12   34  56  ", "#0c2238"], ["256 0 0", "fallback"],
    ["-1 0 0", "fallback"], ["1 2", "fallback"], ["1 2 3 4", "fallback"],
    ["rgb(1, 2, 3)", "fallback"], ["red green blue", "fallback"],
  ])("converts CSS color %j with the existing fallback policy", (raw, expected) => {
    document.documentElement.style.setProperty("--theme-probe", raw);
    expect(mermaidColor("probe", "fallback")).toBe(expected);
  });

  it("keeps distinct fallbacks across diagram families when no app palette is applied", () => {
    expect(mermaidThemeVariables()).toMatchObject({
      background: "transparent", primaryColor: "#ececff", primaryTextColor: "#333",
      primaryBorderColor: "#999", secondaryColor: "#ffffde", noteBkgColor: "#fff5ad",
      edgeLabelBackground: "#e8e8e8", actorLineColor: "#999", sequenceNumberColor: "#fff",
      taskBkgColor: "#ccc", taskTextClickableColor: "#003163", doneTaskBkgColor: "#bbb",
      critBkgColor: "#ff8888", todayLineColor: "#ff0000", pie12: "#ccc",
    });
  });

  it("maps the applied app palette across flow, note, sequence, Gantt and pie diagrams", () => {
    const palette = {
      "background-elevated": "#010101", background: "#020202", text: "#030303",
      border: "#040404", brand: "#050505", "text-muted": "#060606",
      "text-very-muted": "#070707", "code-keyword": "#080808", "code-string": "#090909",
      "code-function": "#101010", "code-number": "#111111", "code-attr": "#121212",
      "code-comment": "#131313", "code-tag": "#141414",
    };
    for (const [key, color] of Object.entries(palette)) {
      document.documentElement.style.setProperty(`--theme-${key}`, color);
    }
    expect(mermaidThemeVariables()).toMatchObject({
      background: "transparent", primaryColor: "#010101", primaryTextColor: "#030303",
      primaryBorderColor: "#040404", secondaryColor: "#020202", tertiaryColor: "#010101",
      noteBkgColor: "#010101", noteBorderColor: "#050505", lineColor: "#060606",
      actorBkg: "#010101", actorLineColor: "#060606", signalColor: "#030303",
      sequenceNumberColor: "#020202", taskBkgColor: "#050505", taskTextColor: "#020202",
      taskTextOutsideColor: "#060606", doneTaskBkgColor: "#070707", critBkgColor: "#080808",
      todayLineColor: "#050505", pie1: "#050505", pie2: "#090909", pie3: "#101010",
      pie4: "#080808", pie5: "#111111", pie6: "#121212", pie7: "#060606", pie8: "#040404",
      pie9: "#131313", pie10: "#141414", pie11: "#010101", pie12: "#020202",
    });
  });

  it("reads the live applied theme again for each render", () => {
    document.documentElement.style.setProperty("--theme-text", "255 255 255");
    expect(mermaidThemeVariables().primaryTextColor).toBe("#ffffff");
    document.documentElement.style.setProperty("--theme-text", "0 0 0");
    expect(mermaidThemeVariables().primaryTextColor).toBe("#000000");
  });
});
