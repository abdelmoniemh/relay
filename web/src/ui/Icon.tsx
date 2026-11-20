/** One stroke icon set (24px grid, 1.8 stroke) so nothing relies on Unicode glyphs. */
const P: Record<string, string> = {
  home: 'M3 11l9-8 9 8v10h-6v-6H9v6H3z',
  live: 'M3 6h18v12H3zM8 21h8M12 3l-3 3m3-3l3 3',
  sports: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zm0-13l3.5 2.5-1.3 4h-4.4l-1.3-4zM12 3v5m8.5 3.5l-5-1M3.5 11.5l5-1M7 19l2.8-4.5M17 19l-2.8-4.5',
  film: 'M4 4h16v16H4zM4 9h16M9 4v5m6-5v5',
  search: 'M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm5-2l6 6',
  remote: 'M8 2h8v20H8zM12 7v.01M10 12h4M12 10v4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8-3l2-1-2-4-2 1-2-1V5h-4v2l-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1v2h4v-2l2-1 2 1 2-4-2-1z',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  down: 'M6 9l6 6 6-6',
  up: 'M6 15l6-6 6 6',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  info: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 11v6M12 7.5v.01',
  play: 'M7 4.5v15l12.5-7.5z',
  pause: 'M7 4h3.5v16H7zM13.5 4H17v16h-3.5z',
  stop: 'M6 6h12v12H6z',
  restart: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4.5h4.5',
  rw: 'M11 6.5L4.5 12l6.5 5.5zM19.5 6.5L13 12l6.5 5.5z',
  ff: 'M13 6.5l6.5 5.5-6.5 5.5zM4.5 6.5L11 12l-6.5 5.5z',
  back10: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4.5h4.5M10 10v5M13 10h2v5h-2z',
  fwd10: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4.5h-4.5M10 10v5M13 10h2v5h-2z',
  next: 'M5 5l10 7-10 7zM18 5v14',
  trailer: 'M3 5h18v14H3zM10 9v6l5-3z',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
  airplay: 'M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1M12 15l5 6H7z',
  pip: 'M3 5h18v14H3zM12 12h7v5h-7z',
  expand: 'M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6',
  shrink: 'M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6',
  volup: 'M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11',
  voldown: 'M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 0 1 0 6',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6',
  tv: 'M3 6h18v12H3zM8 21h8',
  phone: 'M7 2h10v20H7zM11 18h2',
  desktop: 'M3 4h18v12H3zM9 20h6M12 16v4',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4.5h-4.5',
  globe: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
};

export type IconName = keyof typeof P;

/** Directional icons flip in RTL (CSS: [dir=rtl] .ic.flip). Media transport never flips. */
const FLIP = new Set(['back', 'chevron', 'send']);
const FILL = new Set(['play', 'pause', 'stop', 'rw', 'ff', 'next']);

export function Icon({ n, filled, size, class: cls }: { n: IconName; filled?: boolean; size?: number; class?: string }) {
  const f = filled || FILL.has(n);
  return (
    <svg class={`ic ${FLIP.has(n) ? 'flip' : ''} ${f ? 'fill' : ''} ${cls ?? ''}`} viewBox="0 0 24 24" aria-hidden="true"
      style={size ? { width: size, height: size } : undefined}>
      <path d={P[n]} />
    </svg>
  );
}

/** Icon for a kind of device. */
export const deviceIcon = (kind: string): IconName => (kind === 'tv' ? 'tv' : kind === 'phone' ? 'phone' : 'desktop');
