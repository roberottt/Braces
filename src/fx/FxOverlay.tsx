import { Component, createEffect, onCleanup, onMount } from "solid-js";

type Props = { enabled: boolean };

const FxOverlay: Component<Props> = (props) => {
  let canvasRef!: HTMLCanvasElement;
  let rafId: number;
  let running = false;
  let frameCount = 0;
  // Reused across frames — createImageData(1920×1080) allocates ~8 MB; doing it
  // at 20 fps floods V8's heap and triggers constant GC cycles.
  let cachedImageData: ImageData | null = null;

  const drawGrain = () => {
    if (!props.enabled) { running = false; return; }
    const ctx = canvasRef?.getContext("2d");
    if (!ctx) return;

    // Only update grain every 3 frames (~20fps) to save CPU
    if (frameCount++ % 3 !== 0) {
      rafId = requestAnimationFrame(drawGrain);
      return;
    }

    const { width: w, height: h } = canvasRef;
    if (!cachedImageData || cachedImageData.width !== w || cachedImageData.height !== h) {
      cachedImageData = ctx.createImageData(w, h);
    }
    const imageData = cachedImageData;
    const d = imageData.data;
    const seed = Math.random() * 10000 | 0;

    for (let i = 0; i < d.length; i += 4) {
      // Fast LCG noise
      const n = ((i * 1664525 + seed * 22695477 + 1013904223) >>> 0) / 0xffffffff;
      const v = ((n - 0.5) * 255) | 0;
      d[i] = d[i + 1] = d[i + 2] = 128 + v;
      d[i + 3] = Math.abs(v) * 0.15; // very low alpha
    }
    ctx.putImageData(imageData, 0, 0);
    rafId = requestAnimationFrame(drawGrain);
  };

  const syncSize = () => {
    if (!canvasRef) return;
    canvasRef.width = window.innerWidth;
    canvasRef.height = window.innerHeight;
    cachedImageData = null; // canvas reset clears any cached buffer
  };

  onMount(() => {
    syncSize();
    window.addEventListener("resize", syncSize);
  });

  // Single rAF loop, started/stopped reactively. `running` guards against
  // launching a second parallel loop when `enabled` flips quickly.
  createEffect(() => {
    if (props.enabled) {
      if (!running) {
        running = true;
        rafId = requestAnimationFrame(drawGrain);
      }
    } else {
      cancelAnimationFrame(rafId);
      running = false;
      const ctx = canvasRef?.getContext("2d");
      ctx?.clearRect(0, 0, canvasRef.width, canvasRef.height);
    }
  });

  onCleanup(() => {
    cancelAnimationFrame(rafId);
    running = false;
    window.removeEventListener("resize", syncSize);
  });

  return (
    <div class="fx-overlay" style={{ display: props.enabled ? undefined : "none" }}>
      <div class="fx-scanlines" />
      <div class="fx-vignette" />
      <canvas ref={canvasRef} class="fx-grain" />
    </div>
  );
};

export default FxOverlay;
