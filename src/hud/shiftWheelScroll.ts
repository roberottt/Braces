/** Shift+wheel scrolls the hovered container horizontally instead of vertically. */
export function shiftWheelScroll(e: WheelEvent) {
  if (!e.shiftKey) return;
  const el = e.currentTarget as HTMLElement;
  if (el.scrollWidth <= el.clientWidth) return;
  e.preventDefault();
  el.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
}
