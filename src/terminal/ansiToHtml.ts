/** Graphite palette — matches NEON_NOIR_THEME in BracesTerminal */
const PAL = [
  '#000000','#f0726f','#6fcf97','#e0b07a',
  '#8aa0ff','#b08af0','#7fd6d0','#e6e7ea',
  '#5c5f68','#f58a87','#87dba9','#ecc89a',
  '#a6b6ff','#c4a3f5','#9ee0db','#ffffff',
];

/** Parse '#rrggbb' or 'rgb(r,g,b)' to [r,g,b]; null if unrecognised. */
function parseColor(c: string): [number, number, number] | null {
  if (c[0] === '#' && c.length === 7) {
    return [
      parseInt(c.slice(1, 3), 16),
      parseInt(c.slice(3, 5), 16),
      parseInt(c.slice(5, 7), 16),
    ];
  }
  const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(c);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

/**
 * The block background is pure black (#000). Terminal themes (Terminal-Icons,
 * oh-my-posh, custom $PSStyle…) frequently colour entries with near-black 256 or
 * 24-bit values that vanish against it. Raise any too-dark foreground to a
 * minimum perceived brightness so it stays legible. Only applied when there is
 * no explicit background — dark-on-light combos are intentional and left alone.
 */
function ensureVisible(color: string): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  let [r, g, b] = rgb;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const MIN = 80;
  if (lum >= MIN) return color;
  if (r + g + b < 12) return '#9aa0ad'; // pure/near black → neutral graphite grey
  const f = MIN / Math.max(lum, 1);
  r = Math.min(255, Math.round(r * f));
  g = Math.min(255, Math.round(g * f));
  b = Math.min(255, Math.round(b * f));
  return `rgb(${r},${g},${b})`;
}

function c256(n: number): string {
  if (n < 16) return PAL[n];
  if (n < 232) {
    const v = n - 16;
    const f = (x: number) => x === 0 ? 0 : 55 + x * 40;
    return `rgb(${f(Math.floor(v / 36))},${f(Math.floor(v / 6) % 6)},${f(v % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

export type AnsiState = {
  bold: boolean; dim: boolean; italic: boolean; underline: boolean;
  fg: string | null; bg: string | null;
};

export const mkAnsiState = (): AnsiState =>
  ({ bold: false, dim: false, italic: false, underline: false, fg: null, bg: null });

function toCSS(s: AnsiState): string {
  const r: string[] = [];
  if (s.bold)      r.push('font-weight:700');
  if (s.dim)       r.push('opacity:.5');
  if (s.italic)    r.push('font-style:italic');
  if (s.underline) r.push('text-decoration:underline');
  if (s.fg)        r.push(`color:${s.bg ? s.fg : ensureVisible(s.fg)}`);
  if (s.bg)        r.push(`background-color:${s.bg}`);
  return r.join(';');
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Virtual screen model ─────────────────────────────────────────────────────
// Block output used to be rendered append-only: the ANSI stream was turned into a
// string of HTML that only ever grew. That breaks any program which redraws in
// place — progress bars, spinners, multi-line build status (cargo, vite, pnpm,
// npm…). Those move the cursor up and rewrite lines (\x1b[nA + \x1b[K), which the
// old renderer couldn't represent, so every refresh stacked blank lines instead of
// overwriting the previous frame.
//
// TermScreen is a minimal terminal grid: a list of lines, each a list of styled
// cells, plus a cursor. It applies cursor motion, line/screen erase and SGR just
// like a real terminal, then renders the resulting grid to HTML. In-place redraws
// now overwrite cleanly, exactly as they look in a normal terminal.

type Cell = { ch: string; css: string };
const BLANK: Cell = { ch: ' ', css: '' };

// Cache computed CSS per style signature so identical runs share the same string
// (lets the renderer merge them into a single <span> and avoids recomputing).
const cssCache = new Map<string, string>();
function cssFor(s: AnsiState): string {
  const key = `${s.bold ? 1 : 0}${s.dim ? 1 : 0}${s.italic ? 1 : 0}${s.underline ? 1 : 0}|${s.fg ?? ''}|${s.bg ?? ''}`;
  let css = cssCache.get(key);
  if (css === undefined) { css = toCSS(s); cssCache.set(key, css); }
  return css;
}

export class TermScreen {
  private lines: Cell[][] = [[]];
  private row = 0;
  private col = 0;
  private s: AnsiState = mkAnsiState();
  private carry = ''; // escape sequence split across write() chunks

  private ensureRow(r: number) {
    while (this.lines.length <= r) this.lines.push([]);
  }

  private putChar(ch: string) {
    this.ensureRow(this.row);
    const line = this.lines[this.row];
    while (line.length < this.col) line.push(BLANK);
    line[this.col] = { ch, css: cssFor(this.s) };
    this.col++;
  }

  private applySgr(codes: number[]) {
    const s = this.s;
    for (let k = 0; k < codes.length; k++) {
      const code = codes[k];
      if (code === 0) Object.assign(s, mkAnsiState());
      else if (code === 1) s.bold = true;
      else if (code === 2) s.dim = true;
      else if (code === 3) s.italic = true;
      else if (code === 4) s.underline = true;
      else if (code === 22) { s.bold = false; s.dim = false; }
      else if (code === 23) s.italic = false;
      else if (code === 24) s.underline = false;
      else if (code >= 30 && code <= 37) s.fg = PAL[code - 30];
      else if (code === 38 && codes[k + 1] === 5) { s.fg = c256(codes[k + 2] ?? 0); k += 2; }
      else if (code === 38 && codes[k + 1] === 2) { s.fg = `rgb(${codes[k + 2] ?? 0},${codes[k + 3] ?? 0},${codes[k + 4] ?? 0})`; k += 4; }
      else if (code === 39) s.fg = null;
      else if (code >= 40 && code <= 47) s.bg = PAL[code - 40];
      else if (code === 48 && codes[k + 1] === 5) { s.bg = c256(codes[k + 2] ?? 0); k += 2; }
      else if (code === 48 && codes[k + 1] === 2) { s.bg = `rgb(${codes[k + 2] ?? 0},${codes[k + 3] ?? 0},${codes[k + 4] ?? 0})`; k += 4; }
      else if (code === 49) s.bg = null;
      else if (code >= 90 && code <= 97) s.fg = PAL[code - 82];
      else if (code >= 100 && code <= 107) s.bg = PAL[code - 92];
    }
  }

  private eraseInLine(mode: number) {
    this.ensureRow(this.row);
    const line = this.lines[this.row];
    if (mode === 0) {            // cursor → end of line
      line.length = Math.min(line.length, this.col);
    } else if (mode === 1) {     // start of line → cursor
      for (let c = 0; c <= this.col && c < line.length; c++) line[c] = BLANK;
    } else if (mode === 2) {     // whole line
      line.length = 0;
    }
  }

  private eraseInDisplay(mode: number) {
    if (mode === 0) {            // cursor → end of screen
      this.eraseInLine(0);
      this.lines.length = this.row + 1;
    } else if (mode === 1) {     // start of screen → cursor
      for (let r = 0; r < this.row; r++) this.lines[r] = [];
      this.eraseInLine(1);
    } else {                     // 2 / 3 — whole screen
      for (let r = 0; r < this.lines.length; r++) this.lines[r] = [];
    }
  }

  /** Feed a chunk of raw PTY text into the screen, mutating it in place. */
  write(raw: string) {
    raw = this.carry + raw;
    this.carry = '';
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];

      if (ch === '\x1b') {
        const nx = raw[i + 1];
        if (nx === undefined) { this.carry = raw.slice(i); break; } // sequence split across chunks
        if (nx === '[') {
          // CSI — scan to final byte (0x40–0x7e)
          let j = i + 2;
          while (j < raw.length && (raw.charCodeAt(j) < 0x40 || raw.charCodeAt(j) > 0x7e)) j++;
          if (j >= raw.length) { this.carry = raw.slice(i); break; } // incomplete CSI
          const fin = raw[j];
          let par = raw.slice(i + 2, j);
          const priv = par[0] === '?'; // private mode (e.g. ?25l) — ignore params for motion
          if (priv) par = par.slice(1);
          i = j + 1;
          const n0 = parseInt(par, 10);
          const arg = isNaN(n0) ? 1 : Math.max(1, n0);
          if (priv && fin !== 'm') continue; // private set/reset modes — nothing to render
          switch (fin) {
            case 'm': {
              const codes = par ? par.split(';').map(x => parseInt(x, 10) || 0) : [0];
              this.applySgr(codes);
              break;
            }
            case 'A': this.row = Math.max(0, this.row - arg); break;              // CUU
            case 'B': case 'e': this.row += arg; break;                          // CUD
            case 'C': this.col += arg; break;                                    // CUF
            case 'D': this.col = Math.max(0, this.col - arg); break;             // CUB
            case 'E': this.row += arg; this.col = 0; break;                      // CNL
            case 'F': this.row = Math.max(0, this.row - arg); this.col = 0; break; // CPL
            case 'G': case '`': this.col = arg - 1; break;                       // CHA / HPA
            case 'd': this.row = arg - 1; break;                                 // VPA
            case 'H': case 'f': {                                                // CUP / HVP
              const p = par.split(';');
              this.row = Math.max(0, (parseInt(p[0], 10) || 1) - 1);
              this.col = Math.max(0, (parseInt(p[1], 10) || 1) - 1);
              break;
            }
            case 'J': this.eraseInDisplay(isNaN(n0) ? 0 : n0); break;            // ED
            case 'K': this.eraseInLine(isNaN(n0) ? 0 : n0); break;              // EL
            // everything else (SU/SD/insert/delete/SGR-mouse…) — ignored
          }
        } else if (nx === ']') {
          // OSC — skip to BEL or ST
          let j = i + 2;
          let closed = false;
          while (j < raw.length) {
            if (raw[j] === '\x07') { j++; closed = true; break; }
            if (raw[j] === '\x1b' && raw[j + 1] === '\\') { j += 2; closed = true; break; }
            j++;
          }
          if (!closed) { this.carry = raw.slice(i); break; }
          i = j;
        } else {
          i += 2; // skip unknown 2-byte escape (e.g. ESC( charset select, ESC= …)
        }
      } else if (ch === '\r') {
        this.col = 0; i++;
      } else if (ch === '\n') {
        this.row++; this.col = 0; i++;
      } else if (ch === '\b') {
        this.col = Math.max(0, this.col - 1); i++;
      } else if (ch === '\t') {
        this.col = (Math.floor(this.col / 8) + 1) * 8; i++;
      } else if (ch === '\x07') {
        i++; // bell
      } else if (ch < '\x20') {
        i++; // strip other control chars
      } else {
        this.putChar(ch); i++;
      }
    }
  }

  /**
   * URLs and file paths worth turning into clickable anchors. One combined
   * pattern with the URL alternative first, so a URL's path segment is never
   * re-matched as a file path.
   *
   * File paths match compiler/stack-trace shapes: `src/App.tsx:12:5`,
   * `./x.js:3`, `/abs/main.rs:7`, `C:\proj\a.cs:4` and tsc's `src/a.ts(12,5)`.
   * A bare name needs either a separator or a line suffix (`main.rs:12`) to
   * qualify — a lone `foo.ts` in prose stays plain text.
   */
  private static readonly LINK_RE =
    /(https?:\/\/[^\s<>"']+)|((?:[A-Za-z]:[\\/]|\/)?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\))?)/g;

  /**
   * Find link ranges in a line's PLAIN text. Detection must run on the whole
   * line, not per style run: programs routinely style one token with several
   * colours (vite renders `http://localhost:` cyan and the port bold), which
   * splits the URL across spans and used to cut the link short.
   */
  private static findLinks(text: string): { start: number; end: number; attrs: string }[] {
    const links: { start: number; end: number; attrs: string }[] = [];
    for (const m of text.matchAll(TermScreen.LINK_RE)) {
      const idx = m.index ?? 0;
      if (m[1]) {
        // Trim trailing punctuation that typically isn't part of the URL.
        const display = m[1].replace(/[.,;:!?)"']+$/, '');
        if (!display) continue;
        links.push({
          start: idx,
          end: idx + display.length,
          attrs: `data-url="${esc(display)}" title="Ctrl+Click to open"`,
        });
      } else {
        // File path: split the optional :line:col / (line,col) suffix.
        const s = /^(.*?)(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\))?$/.exec(m[2]);
        if (!s) continue;
        const path = s[1];
        const line = s[2] ?? s[4] ?? '';
        const col  = s[3] ?? s[5] ?? '';
        // Bare `word.ext` with no separator and no line number is too ambiguous.
        if (!line && !/[\\/]/.test(path)) continue;
        links.push({
          start: idx,
          end: idx + m[2].length,
          attrs: `data-file="${esc(path)}" data-line="${line}" data-col="${col}" title="Ctrl+Click to open in editor"`,
        });
      }
    }
    return links;
  }

  /** Render the current grid to HTML. Trailing blank lines/cells are trimmed. */
  toHtml(): string {
    // Find last row that has any content.
    let last = this.lines.length - 1;
    while (last >= 0 && this.lines[last].length === 0) last--;
    if (last < 0) return '';

    const out: string[] = [];
    for (let r = 0; r <= last; r++) {
      const line = this.lines[r];
      // Trim trailing unstyled blanks so blocks don't carry padding width.
      let end = line.length;
      while (end > 0 && line[end - 1].ch === ' ' && line[end - 1].css === '') end--;

      // Link detection runs on the line's plain text so a link split across
      // several style runs is still matched whole.
      let text = '';
      for (let c = 0; c < end; c++) text += (line[c] ?? BLANK).ch;
      const links = TermScreen.findLinks(text);

      let lineHtml = '';
      let runCss = '';
      let runText = '';
      const flushRun = () => {
        if (!runText) return;
        lineHtml += runCss ? `<span style="${runCss}">${esc(runText)}</span>` : esc(runText);
        runText = '';
      };
      let li = 0; // next link to open/close (ranges are sorted, non-overlapping)
      for (let c = 0; c < end; c++) {
        if (li < links.length && c === links[li].start) {
          flushRun();
          lineHtml += `<a class="term-link" ${links[li].attrs}>`;
        }
        const cell = line[c] ?? BLANK;
        if (cell.css !== runCss) { flushRun(); runCss = cell.css; }
        runText += cell.ch;
        if (li < links.length && c === links[li].end - 1) {
          flushRun();
          lineHtml += '</a>';
          li++;
        }
      }
      flushRun();
      out.push(lineHtml);
    }
    return out.join('<br>');
  }
}

export const mkScreen = (): TermScreen => new TermScreen();

/**
 * Legacy one-shot converter kept for any caller that just needs to turn a
 * self-contained ANSI string into HTML (no incremental redraw semantics).
 * Internally backed by TermScreen so behaviour matches the live renderer.
 */
export function ansiChunkToHtml(raw: string, _state?: AnsiState): { html: string; state: AnsiState } {
  const screen = mkScreen();
  screen.write(raw);
  return { html: screen.toHtml(), state: mkAnsiState() };
}
