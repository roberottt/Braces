import { Component, createSignal, onMount, onCleanup } from "solid-js";

type Props = { onDismiss: () => void };

// ── Procedural eye renderer ────────────────────────────────────────────────

function drawEye(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const CX = W / 2, CY = H / 2;
  const R = Math.min(W, H) * 0.42;
  const CYAN = "#00d4ff";
  const DIM  = "#003d4d";

  ctx.clearRect(0, 0, W, H);

  // Outer glow burst — very faint ring
  const outerGlow = ctx.createRadialGradient(CX, CY, R * 0.5, CX, CY, R * 1.1);
  outerGlow.addColorStop(0, "rgba(0,212,255,0.10)");
  outerGlow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = outerGlow;
  ctx.fillRect(0, 0, W, H);

  // ── Radiating speed lines ────────────────────────────────────────────────
  // Use deterministic "pseudo-random" so the eye looks the same every time
  const det = (i: number, offset = 0) =>
    ((Math.sin(i * 127.1 + offset) * 43758.5453) % 1 + 1) % 1;

  const TOTAL_SPIKES = 72;

  for (let i = 0; i < TOTAL_SPIKES; i++) {
    const baseAngle  = (i / TOTAL_SPIKES) * Math.PI * 2;
    const jitter     = (det(i, 1) - 0.5) * 0.18;
    const angle      = baseAngle + jitter;
    const len        = R * (0.45 + det(i, 2) * 0.70);
    const lineW      = 0.4 + det(i, 3) * 1.4;
    const alpha      = 0.35 + det(i, 4) * 0.60;

    ctx.save();
    ctx.strokeStyle = CYAN;
    ctx.lineWidth   = lineW;
    ctx.globalAlpha = alpha;
    ctx.shadowBlur  = det(i, 5) > 0.7 ? 4 : 0;
    ctx.shadowColor = CYAN;
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(CX + Math.cos(angle) * len, CY + Math.sin(angle) * len);
    ctx.stroke();
    ctx.restore();
  }

  // ── Dramatic thick spikes (the manga "speed lines") ──────────────────────
  const thickAngles = [
    -0.95, -0.35, 0.1, 0.55, 1.1,       // upper-right cluster
    Math.PI * 0.9, Math.PI * 1.1,        // left
    -Math.PI * 0.5, -Math.PI * 0.4,      // up
    Math.PI * 0.3, Math.PI * 0.45,       // lower-right
  ];

  thickAngles.forEach((ang, idx) => {
    const len = R * (0.75 + det(idx, 7) * 0.35);
    const w   = 1.8 + det(idx, 8) * 2.2;

    ctx.save();
    ctx.strokeStyle = CYAN;
    ctx.lineWidth   = w;
    ctx.globalAlpha = 0.85;
    ctx.shadowBlur  = 6;
    ctx.shadowColor = CYAN;
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(CX + Math.cos(ang) * len, CY + Math.sin(ang) * len);
    ctx.stroke();

    // Parallel ghost line
    const perp = ang + Math.PI / 2;
    const off  = 4 + det(idx, 9) * 5;
    ctx.lineWidth   = w * 0.35;
    ctx.globalAlpha = 0.3;
    ctx.shadowBlur  = 0;
    ctx.beginPath();
    ctx.moveTo(CX + Math.cos(perp) * off, CY + Math.sin(perp) * off);
    ctx.lineTo(
      CX + Math.cos(perp) * off + Math.cos(ang) * len * 0.85,
      CY + Math.sin(perp) * off + Math.sin(ang) * len * 0.85,
    );
    ctx.stroke();
    ctx.restore();
  });

  // ── Broken horizontal slash lines (right side) ────────────────────────────
  for (let i = 0; i < 7; i++) {
    const y   = CY + (i - 3) * 9 + (det(i, 10) - 0.5) * 5;
    const x0  = CX + R * 0.30 + det(i, 11) * R * 0.15;
    const len = R * (0.18 + det(i, 12) * 0.25);
    ctx.save();
    ctx.strokeStyle = DIM;
    ctx.lineWidth   = 0.8 + det(i, 13);
    ctx.globalAlpha = 0.5 + det(i, 14) * 0.4;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + len, y + (det(i, 15) - 0.5) * 3);
    ctx.stroke();
    ctx.restore();
  }

  // ── Dark iris mass ─────────────────────────────────────────────────────────
  const irisGrad = ctx.createRadialGradient(CX, CY - 4, 2, CX, CY, R * 0.36);
  irisGrad.addColorStop(0, "#000000");
  irisGrad.addColorStop(0.6, "#000d14");
  irisGrad.addColorStop(1, "rgba(0,0,0,0.85)");

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle   = irisGrad;
  ctx.beginPath();
  ctx.arc(CX, CY, R * 0.36, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ── Bright crescent (the light reflection arc) ─────────────────────────────
  ctx.save();
  ctx.shadowBlur  = 12;
  ctx.shadowColor = CYAN;
  ctx.fillStyle   = CYAN;
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.arc(CX + 2, CY + 6, R * 0.20, Math.PI * 0.55, Math.PI * 1.45);
  ctx.fill();

  // Hollow the crescent — cut out inner arc
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(CX + 2, CY + 14, R * 0.17, Math.PI * 0.4, Math.PI * 1.6);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();

  // ── Pupil catchlight (white hot center) ───────────────────────────────────
  ctx.save();
  ctx.shadowBlur  = 10;
  ctx.shadowColor = "#ffffff";
  ctx.fillStyle   = "#ffffff";
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.arc(CX - 10, CY + 2, R * 0.045, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ── Central glow point ────────────────────────────────────────────────────
  const centerGlow = ctx.createRadialGradient(CX, CY, 0, CX, CY, R * 0.12);
  centerGlow.addColorStop(0, "rgba(0,212,255,0.5)");
  centerGlow.addColorStop(1, "rgba(0,212,255,0)");
  ctx.save();
  ctx.fillStyle = centerGlow;
  ctx.beginPath();
  ctx.arc(CX, CY, R * 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ── Apply pixelation post-process ─────────────────────────────────────────

function pixelate(
  src: HTMLCanvasElement,
  dst: HTMLCanvasElement,
  blockSize: number,
) {
  const sw = src.width, sh = src.height;
  const dw = dst.width, dh = dst.height;
  const sCtx = src.getContext("2d")!;
  const dCtx = dst.getContext("2d")!;

  const imgData = sCtx.getImageData(0, 0, sw, sh);
  const data    = imgData.data;

  dCtx.fillStyle = "#000";
  dCtx.fillRect(0, 0, dw, dh);

  const scaleX = sw / dw;
  const scaleY = sh / dh;

  for (let py = 0; py < dh; py += blockSize) {
    for (let px = 0; px < dw; px += blockSize) {
      // Sample center of block from source
      const sx = Math.floor((px + blockSize / 2) * scaleX);
      const sy = Math.floor((py + blockSize / 2) * scaleY);
      const idx = (sy * sw + sx) * 4;

      const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
      if (a < 8) continue;

      // Leave a 1px gap around each "pixel" for the grid look
      const gap = blockSize > 3 ? 1 : 0;
      dCtx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
      dCtx.fillRect(px + gap, py + gap, blockSize - gap * 2, blockSize - gap * 2);
    }
  }
}

// ── HUD boot lines ─────────────────────────────────────────────────────────

const BOOT_LINES = [
  "// BRACES v0.1 — AI-NATIVE TERMINAL",
  "> SPAWNING SHELL PROCESS............. OK",
  "> NEURAL LINK ESTABLISHED............ OK",
  "> LOADING COMMAND HISTORY............ OK",
  "> AI CONTEXT ENGINE.................. READY",
  "─────────────────────────────────────",
  "[ PRESS ANY KEY TO CONTINUE ]",
];

// ── Component ─────────────────────────────────────────────────────────────

const NewSessionSplash: Component<Props> = (props) => {
  let offscreenCanvas!: HTMLCanvasElement;
  let displayCanvas!: HTMLCanvasElement;
  const [bootLine, setBootLine] = createSignal(0);
  const [fading, setFading] = createSignal(false);

  const dismiss = () => {
    if (fading()) return;
    setFading(true);
    setTimeout(() => props.onDismiss(), 400);
  };

  onMount(() => {
    // Draw hi-res eye on offscreen canvas then pixelate onto display canvas
    const OFF_SIZE = 480;
    const DISP_SIZE = 240;
    const BLOCK = 4; // 4px blocks → pixelated grid

    offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width  = OFF_SIZE;
    offscreenCanvas.height = OFF_SIZE;
    const offCtx = offscreenCanvas.getContext("2d")!;
    drawEye(offCtx, OFF_SIZE, OFF_SIZE);

    displayCanvas.width  = DISP_SIZE;
    displayCanvas.height = DISP_SIZE;
    pixelate(offscreenCanvas, displayCanvas, BLOCK);

    // Boot text typewriter effect
    let lineIdx = 0;
    const bootInterval = setInterval(() => {
      lineIdx++;
      setBootLine(lineIdx);
      if (lineIdx >= BOOT_LINES.length) clearInterval(bootInterval);
    }, 220);

    // Auto-dismiss after lines finish + pause
    const autoDismiss = setTimeout(() => dismiss(), BOOT_LINES.length * 220 + 1800);

    const onKey = () => dismiss();
    window.addEventListener("keydown", onKey, { once: true });
    window.addEventListener("click", onKey, { once: true });

    onCleanup(() => {
      clearInterval(bootInterval);
      clearTimeout(autoDismiss);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onKey);
    });
  });

  return (
    <div class={`session-splash${fading() ? " fading" : ""}`}>
      {/* Corner brackets */}
      <div class="ss-corner ss-tl" />
      <div class="ss-corner ss-tr" />
      <div class="ss-corner ss-bl" />
      <div class="ss-corner ss-br" />

      {/* Scanline overlay */}
      <div class="ss-scanlines" />

      {/* Eye canvas */}
      <div class="ss-eye-wrap">
        <canvas ref={displayCanvas!} class="ss-canvas" />
      </div>

      {/* Boot text */}
      <div class="ss-boot-log">
        {BOOT_LINES.slice(0, bootLine()).map((line, i) => (
          <div
            class={`ss-boot-line${i === bootLine() - 1 ? " ss-boot-line-new" : ""}`}
          >
            {line}
          </div>
        ))}
        <span class="ss-cursor">█</span>
      </div>
    </div>
  );
};

export default NewSessionSplash;
