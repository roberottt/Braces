/** Graphite palette — matches NEON_NOIR_THEME in WarpTerminal */
const PAL = [
  '#000000','#f0726f','#6fcf97','#e0b07a',
  '#8aa0ff','#b08af0','#7fd6d0','#e6e7ea',
  '#5c5f68','#f58a87','#87dba9','#ecc89a',
  '#a6b6ff','#c4a3f5','#9ee0db','#ffffff',
];

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
  if (s.fg)        r.push(`color:${s.fg}`);
  if (s.bg)        r.push(`background-color:${s.bg}`);
  return r.join(';');
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Convert a chunk of ANSI text to HTML, preserving SGR style state across calls.
 *
 * Cursor-movement sequences that ConPTY emits instead of plain newlines are
 * converted to <br> so block-rendered output stays readable:
 *   \x1b[B / \x1b[nB  CUD cursor-down       → n <br>
 *   \x1b[E / \x1b[nE  CNL cursor-next-line   → n <br>
 *   \x1b[H / \x1b[r;cH CUP cursor-position   → <br> × (newRow − currentRow) when row advances
 *
 * A lone \r (without \n) is treated as a carriage-return: it discards the
 * current visual line and lets the next text overwrite from the left, matching
 * real-terminal behaviour (progress lines, etc.).
 */
export function ansiChunkToHtml(raw: string, state: AnsiState): { html: string; state: AnsiState } {
  let html = '';
  let buf  = '';
  let lineStart = 0; // index into html where the current visual line began
  let row = 1;       // current virtual row (1-based), used for CUP tracking
  const s  = { ...state };

  const flush = () => {
    if (!buf) return;
    const c = toCSS(s);
    html += c ? `<span style="${c}">${esc(buf)}</span>` : esc(buf);
    buf = '';
  };

  const emitBr = (n = 1) => {
    flush();
    for (let x = 0; x < n; x++) { html += '<br>'; row++; }
    lineStart = html.length;
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '\x1b') {
      const nx = raw[i + 1];
      if (nx === '[') {
        // CSI — scan to final byte (0x40–0x7e)
        let j = i + 2;
        while (j < raw.length && (raw.charCodeAt(j) < 0x40 || raw.charCodeAt(j) > 0x7e)) j++;
        const fin = raw[j];
        const par = raw.slice(i + 2, j);
        i = j + 1;
        if (fin === 'm') {
          flush();
          const codes = par ? par.split(';').map(Number) : [0];
          for (let k = 0; k < codes.length; k++) {
            const code = codes[k];
            if (code === 0) Object.assign(s, mkAnsiState());
            else if (code === 1) s.bold = true;
            else if (code === 2) s.dim  = true;
            else if (code === 3) s.italic = true;
            else if (code === 4) s.underline = true;
            else if (code === 22) { s.bold = false; s.dim = false; }
            else if (code === 23) s.italic = false;
            else if (code === 24) s.underline = false;
            else if (code >= 30 && code <= 37) s.fg = PAL[code - 30];
            else if (code === 38 && codes[k+1] === 5) { s.fg = c256(codes[k+2] ?? 0); k += 2; }
            else if (code === 38 && codes[k+1] === 2) { s.fg = `rgb(${codes[k+2]??0},${codes[k+3]??0},${codes[k+4]??0})`; k += 4; }
            else if (code === 39) s.fg = null;
            else if (code >= 40 && code <= 47) s.bg = PAL[code - 40];
            else if (code === 48 && codes[k+1] === 5) { s.bg = c256(codes[k+2] ?? 0); k += 2; }
            else if (code === 48 && codes[k+1] === 2) { s.bg = `rgb(${codes[k+2]??0},${codes[k+3]??0},${codes[k+4]??0})`; k += 4; }
            else if (code === 49) s.bg = null;
            else if (code >= 90 && code <= 97)  s.fg = PAL[code - 82];
            else if (code >= 100 && code <= 107) s.bg = PAL[code - 92];
          }
        } else if (fin === 'B' || fin === 'e') {
          // CUD / VPR — cursor down
          emitBr(parseInt(par, 10) || 1);
        } else if (fin === 'E') {
          // CNL — cursor next line (down + col 0)
          emitBr(parseInt(par, 10) || 1);
        } else if (fin === 'H' || fin === 'f') {
          // CUP / HVP — cursor position \x1b[row;colH
          // Emit <br> for each row we advance forward (ConPTY uses this to lay out lines).
          const parts = par.split(';');
          const newRow = parseInt(parts[0], 10) || 1;
          if (newRow > row) emitBr(newRow - row);
          else if (newRow < row) { flush(); lineStart = html.length; }
          row = newRow;
        }
        // All other CSI (erase, cursor left/right/up, etc.) — silently stripped
      } else if (nx === ']') {
        // OSC — skip to BEL or ST
        let j = i + 2;
        while (j < raw.length) {
          if (raw[j] === '\x07') { j++; break; }
          if (raw[j] === '\x1b' && raw[j + 1] === '\\') { j += 2; break; }
          j++;
        }
        i = j;
      } else {
        i += 2; // skip unknown escape
      }
    } else if (ch === '\r' && raw[i + 1] === '\n') {
      emitBr(1); i += 2;
    } else if (ch === '\n') {
      emitBr(1); i++;
    } else if (ch === '\r') {
      // Bare CR: go to column 0 of current line, discarding what was written.
      // This matches real-terminal behaviour for in-place progress updates.
      flush();
      html = html.slice(0, lineStart);
      i++;
    } else if (ch === '\t') {
      buf += '    '; i++;
    } else if (ch < '\x20') {
      i++; // strip other control chars
    } else {
      buf += ch; i++;
    }
  }

  flush();
  return { html, state: s };
}
