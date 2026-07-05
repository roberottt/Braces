import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Built once from the app's CSS custom properties (see src/styles/global.css).
// Backgrounds stay near-black across all 5 Braces themes — only accents
// change — so a single dark CM6 theme keyed off the CSS vars works for all
// of them without per-theme recomputation.

export const editorTheme = EditorView.theme(
  {
    "&": {
      color: "var(--fg)",
      backgroundColor: "var(--bg-primary)",
      fontFamily: "var(--font-term)",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-term)",
      lineHeight: "1.5",
      overflow: "auto",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
    },
    "&.cm-focused .cm-cursor": {
      borderLeftColor: "var(--accent)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg-secondary)",
      color: "var(--fg-dim)",
      border: "none",
      borderRight: "1px solid var(--border)",
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in srgb, var(--accent) 6%, transparent)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "color-mix(in srgb, var(--accent) 10%, var(--bg-secondary))",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent) !important",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      color: "var(--fg-dim)",
    },
  },
  { dark: true }
);

const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--accent)" },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: "var(--fg)" },
  { tag: [t.function(t.variableName), t.labelName], color: "var(--accent-lime)" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "var(--accent-amber)" },
  { tag: [t.definition(t.name), t.separator], color: "var(--fg)" },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "var(--accent-amber)" },
  { tag: [t.operator, t.operatorKeyword], color: "var(--accent)" },
  { tag: [t.url, t.escape, t.regexp, t.link], color: "var(--accent-lime)" },
  { tag: [t.meta, t.comment], color: "var(--fg-dim)", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.heading, fontWeight: "bold", color: "var(--accent)" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "var(--accent-amber)" },
  { tag: [t.processingInstruction, t.string, t.inserted], color: "var(--accent-lime)" },
  { tag: t.invalid, color: "var(--accent-red)" },
]);

export const editorHighlighting = syntaxHighlighting(highlightStyle);
