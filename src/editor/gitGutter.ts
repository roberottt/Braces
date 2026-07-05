import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

export type GutterMarkKind = "added" | "removed" | "modified";

type DiffLine = { origin: string; content: string; oldNo: number | null; newNo: number | null };
type DiffHunk = { header: string; lines: DiffLine[] };
export type FileDiff = { path: string; hunks: DiffHunk[]; isBinary: boolean; rawUnified: string };

/**
 * Turn a parsed unified diff (worktree vs HEAD) into a map of
 * new-file line number -> gutter marker kind, mirroring VSCode's git
 * decorations: a run of pure insertions is "added", a run of deletions
 * immediately replaced by insertions is "modified", and a pure deletion with
 * no replacement gets a thin "removed" notch on the line after it.
 */
export function computeGutterMarks(diff: FileDiff | null): Map<number, GutterMarkKind> {
  const marks = new Map<number, GutterMarkKind>();
  if (!diff || diff.isBinary) return marks;

  for (const hunk of diff.hunks) {
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      const origin = lines[i].origin;

      if (origin === "-") {
        const runStart = i;
        while (i < lines.length && lines[i].origin === "-") i++;

        if (i < lines.length && lines[i].origin === "+") {
          // Deletion immediately replaced by insertion(s) at this position → modified.
          const plusStart = i;
          while (i < lines.length && lines[i].origin === "+") i++;
          for (const l of lines.slice(plusStart, i)) {
            if (l.newNo != null) marks.set(l.newNo, "modified");
          }
        } else {
          // Pure deletion — anchor a "removed" notch to the line now sitting
          // at this position, or one past the last known line at EOF.
          let anchor: number | null = null;
          for (let j = i; j < lines.length; j++) {
            if (lines[j].newNo != null) { anchor = lines[j].newNo; break; }
          }
          if (anchor == null) {
            let lastNew: number | null = null;
            for (let j = runStart - 1; j >= 0; j--) {
              if (lines[j].newNo != null) { lastNew = lines[j].newNo; break; }
            }
            anchor = (lastNew ?? 0) + 1;
          }
          if (!marks.has(anchor)) marks.set(anchor, "removed");
        }
        continue;
      }

      if (origin === "+") {
        const runStart = i;
        while (i < lines.length && lines[i].origin === "+") i++;
        for (const l of lines.slice(runStart, i)) {
          if (l.newNo != null && !marks.has(l.newNo)) marks.set(l.newNo, "added");
        }
        continue;
      }

      i++;
    }
  }

  return marks;
}

// ── CodeMirror gutter extension ──────────────────────────────────────────────

class GitGutterMarker extends GutterMarker {
  constructor(readonly kind: GutterMarkKind) { super(); }
  eq(other: GitGutterMarker) { return other.kind === this.kind; }
  toDOM() {
    const span = document.createElement("span");
    span.className = `editor-cm-gutter-mark editor-cm-gutter-${this.kind}`;
    return span;
  }
}

export const setGutterMarks = StateEffect.define<Map<number, GutterMarkKind>>();

const gutterMarksField = StateField.define<Map<number, GutterMarkKind>>({
  create() { return new Map(); },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGutterMarks)) value = e.value;
    return value;
  },
});

export function gitGutterExtension() {
  return [
    gutterMarksField,
    gutter({
      class: "editor-cm-git-gutter",
      lineMarker(view, line) {
        const marks = view.state.field(gutterMarksField);
        const lineNo = view.state.doc.lineAt(line.from).number;
        const kind = marks.get(lineNo);
        return kind ? new GitGutterMarker(kind) : null;
      },
      lineMarkerChange(update) {
        return update.transactions.some(tr => tr.effects.some(e => e.is(setGutterMarks)));
      },
    }),
  ];
}

export function applyGutterMarks(view: EditorView, diff: FileDiff | null) {
  const marks = computeGutterMarks(diff);
  view.dispatch({ effects: setGutterMarks.of(marks) });
}
