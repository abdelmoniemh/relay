// Tiny shims for older Samsung TVs (Tizen 5.x ≈ Chromium 63–69). No-ops on modern browsers.
const w = window as any;
if (!w.queueMicrotask) w.queueMicrotask = (f: () => void) => Promise.resolve().then(f);
if (!(Array.prototype as any).flatMap) {
  (Array.prototype as any).flatMap = function (this: any[], f: (x: any, i: number, a: any[]) => any) {
    return this.reduce((acc: any[], x, i, a) => acc.concat(f(x, i, a)), []);
  };
}
if (!w.ResizeObserver) {
  // Size changes on a TV only come from window resizes; poll cheaply as a safety net.
  w.ResizeObserver = class {
    private els = new Set<Element>();
    private cb: () => void;
    private t: ReturnType<typeof setInterval>;
    constructor(cb: () => void) { this.cb = () => cb(); window.addEventListener('resize', this.cb); this.t = setInterval(this.cb, 1000); }
    observe(el: Element) { this.els.add(el); setTimeout(this.cb, 0); }
    unobserve(el: Element) { this.els.delete(el); }
    disconnect() { window.removeEventListener('resize', this.cb); clearInterval(this.t); }
  };
}
const html = document.documentElement;
if (!(w.CSS && CSS.supports && CSS.supports('aspect-ratio', '1'))) html.classList.add('legacy');
