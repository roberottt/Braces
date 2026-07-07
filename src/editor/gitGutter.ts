import { Decoration, DecorationSet, EditorView, WidgetType, gutter, GutterMarker } from "@codemirror/view";
import { StateEffect, StateField, type Text } from "@codemirror/state";
import { store } from "../store/terminalStore";
import { t } from "../i18n";

export type GutterMarkKind = "added" | "removed" | "modified";

type DiffLine = { origin: string; content: string; oldNo: number | null; newNo: number | null };
type DiffHunk = { header: string; lines: DiffLine[] };
export type FileDiff = { path: string; hunks: DiffHunk[]; isBinary: boolean; rawUnified: string };

/**
 * One contiguous change: the range of new-file lines it covers plus the
 * HEAD content it replaced (empty for pure insertions). Clicking the gutter
 * bar on any line in [from, to] peeks `oldLines` inline.
 */
export type ChangeRun = {
  kind: GutterMarkKind;
  from: number;
  to: number;
  oldLines: string[];
};

export type GutterChanges = { marks: Map<number, GutterMarkKind>; runs: ChangeRun[] };

/**
 * Turn a parsed unified diff (worktree vs HEAD) into a map of
 * new-file line number -> gutter marker kind, mirroring VSCode's git
 * decorations: a run of pure insertions is "added", a run of deletions
 * immediately replaced by insertions is "modified", and a pure deletion with
 * no replacement gets a thin "removed" notch on the line after it.
 * Also returns the change runs backing the click-to-peek widget.
 */
export function computeGutterMarks(diff: FileDiff | null): GutterChanges {
  const marks = new Map<number, GutterMarkKind>();
  const runs: ChangeRun[] = [];
  if (!diff || diff.isBinary) return { marks, runs };

  for (const hunk of diff.hunks) {
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      const origin = lines[i].origin;

      if (origin === "-") {
        const runStart = i;
        while (i < lines.length && lines[i].origin === "-") i++;
        const oldLines = lines.slice(runStart, i).map((l) => l.content.replace(/\r?\n$/, ""));

        if (i < lines.length && lines[i].origin === "+") {
          // Deletion immediately replaced by insertion(s) at this position → modified.
          const plusStart = i;
          while (i < lines.length && lines[i].origin === "+") i++;
          const newNos = lines.slice(plusStart, i).map((l) => l.newNo).filter((n): n is number => n != null);
          for (const n of newNos) marks.set(n, "modified");
          if (newNos.length) {
            runs.push({ kind: "modified", from: newNos[0], to: newNos[newNos.length - 1], oldLines });
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
          runs.push({ kind: "removed", from: anchor, to: anchor, oldLines });
        }
        continue;
      }

      if (origin === "+") {
        const runStart = i;
        while (i < lines.length && lines[i].origin === "+") i++;
        const newNos: number[] = [];
        for (const l of lines.slice(runStart, i)) {
          if (l.newNo != null) {
            newNos.push(l.newNo);
            if (!marks.has(l.newNo)) marks.set(l.newNo, "added");
          }
        }
        if (newNos.length) {
          runs.push({ kind: "added", from: newNos[0], to: newNos[newNos.length - 1], oldLines: [] });
        }
        continue;
      }

      i++;
    }
  }

  return { marks, runs };
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

export const setGutterMarks = StateEffect.define<GutterChanges>();
export const togglePeek = StateEffect.define<number>();

const gutterMarksField = StateField.define<GutterChanges>({
  create() { return { marks: new Map(), runs: [] }; },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGutterMarks)) value = e.value;
    return value;
  },
});

// ── Inline "previous content" peek ───────────────────────────────────────────

class PeekWidget extends WidgetType {
  constructor(readonly run: ChangeRun) { super(); }

  eq(other: PeekWidget) {
    return other.run.kind === this.run.kind
      && other.run.from === this.run.from
      && other.run.oldLines.length === this.run.oldLines.length
      && other.run.oldLines.every((l, i) => l === this.run.oldLines[i]);
  }

  toDOM(view: EditorView) {
    const lang = store.language;
    const box = document.createElement("div");
    box.className = "editor-peek";

    const header = document.createElement("div");
    header.className = "editor-peek-header";
    const title = document.createElement("span");
    title.className = "editor-peek-title";
    title.textContent = t(lang, "editor_peek_title");
    const close = document.createElement("button");
    close.className = "editor-peek-close";
    close.textContent = "✕";
    close.title = t(lang, "close");
    close.onmousedown = (e) => e.preventDefault();
    close.onclick = () => view.dispatch({ effects: togglePeek.of(this.run.from) });
    header.append(title, close);
    box.appendChild(header);

    const body = document.createElement("div");
    body.className = "editor-peek-body";
    if (this.run.oldLines.length === 0) {
      const empty = document.createElement("div");
      empty.className = "editor-peek-empty";
      empty.textContent = t(lang, "editor_peek_no_previous");
      body.appendChild(empty);
    } else {
      for (const text of this.run.oldLines) {
        const line = document.createElement("div");
        line.className = "editor-peek-line";
        line.textContent = text || " ";
        body.appendChild(line);
      }
    }
    box.appendChild(body);
    return box;
  }

  ignoreEvent() { return true; }
}

type PeekState = { open: number[]; deco: DecorationSet };

function buildPeekDecorations(doc: Text, runs: ChangeRun[], open: number[]): DecorationSet {
  const widgets = [];
  for (const key of open) {
    const run = runs.find((r) => r.from === key);
    if (!run) continue;
    const lineNo = Math.min(run.to, doc.lines);
    widgets.push(
      Decoration.widget({ widget: new PeekWidget(run), block: true, side: 1 }).range(doc.line(lineNo).to)
    );
  }
  return Decoration.set(widgets, true);
}

const peekField = StateField.define<PeekState>({
  create() { return { open: [], deco: Decoration.none }; },
  update(value, tr) {
    let open = value.open;
    let deco = value.deco.map(tr.changes);
    let rebuild = false;

    for (const e of tr.effects) {
      if (e.is(togglePeek)) {
        const runs = tr.state.field(gutterMarksField).runs;
        const run = runs.find((r) => e.value >= r.from && e.value <= r.to);
        if (!run) continue;
        open = open.includes(run.from) ? open.filter((k) => k !== run.from) : [...open, run.from];
        rebuild = true;
      } else if (e.is(setGutterMarks)) {
        // Refresh open peeks against the new diff; drop ones whose run is gone.
        open = open.filter((k) => e.value.runs.some((r) => r.from === k));
        rebuild = true;
      }
    }

    if (rebuild) deco = buildPeekDecorations(tr.state.doc, tr.state.field(gutterMarksField).runs, open);
    return { open, deco };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export function gitGutterExtension() {
  return [
    gutterMarksField,
    peekField,
    gutter({
      class: "editor-cm-git-gutter",
      lineMarker(view, line) {
        const marks = view.state.field(gutterMarksField).marks;
        const lineNo = view.state.doc.lineAt(line.from).number;
        const kind = marks.get(lineNo);
        return kind ? new GitGutterMarker(kind) : null;
      },
      lineMarkerChange(update) {
        return update.transactions.some(tr => tr.effects.some(e => e.is(setGutterMarks)));
      },
      domEventHandlers: {
        mousedown(view, line) {
          const lineNo = view.state.doc.lineAt(line.from).number;
          const runs = view.state.field(gutterMarksField).runs;
          if (!runs.some((r) => lineNo >= r.from && lineNo <= r.to)) return false;
          view.dispatch({ effects: togglePeek.of(lineNo) });
          return true;
        },
      },
    }),
  ];
}

export function applyGutterMarks(view: EditorView, diff: FileDiff | null) {
  view.dispatch({ effects: setGutterMarks.of(computeGutterMarks(diff)) });
}
