import { useEffect, useState } from 'preact/hooks';
import { token, loadFavorites, myDeviceId } from './api.ts';
import { connect, connected, lease, devices } from './ws.ts';
import { stack, route, go, back, railFocused, TOP, type Route } from './router.ts';
import { toast, current, takeover, mode } from './playback.ts';
import { useKeys } from './ui/hooks.ts';
import { PlayerHost } from './player/host.tsx';
import { Home } from './screens/Home.tsx';
import { Live } from './screens/Live.tsx';
import { Vod } from './screens/Vod.tsx';
import { MovieDetail, SeriesDetail } from './screens/Detail.tsx';
import { Search } from './screens/Search.tsx';
import { Settings } from './screens/Settings.tsx';
import { Remote } from './screens/Remote.tsx';
import { Sports } from './screens/Sports.tsx';
import { Pair } from './screens/Pair.tsx';
import { clean } from './ui/common.tsx';
import { isMobile, isTizen } from './env.ts';

const ICONS: Record<string, string> = {
  home: 'M3 11l9-8 9 8v10h-6v-6H9v6H3z',
  sports: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zm0-13l3.5 2.5-1.3 4h-4.4l-1.3-4zM12 3v5m8.5 3.5l-5 -1M3.5 11.5l5-1M7 19l2.8-4.5M17 19l-2.8-4.5',
  live: 'M3 6h18v12H3zM8 21h8M12 3l-3 3m3-3l3 3',
  movies: 'M4 4h16v16H4zM4 9h16M9 4v5m6-5v5',
  series: 'M3 5h18v11H3zM7 20h10',
  search: 'M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm5-2l6 6',
  remote: 'M8 2h8v20H8zM12 7v.01M10 12h4M12 10v4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8-3l2-1-2-4-2 1-2-1V5h-4v2l-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1v2h4v-2l2-1 2 1 2-4-2-1z',
};
const LABEL: Record<string, string> = { home: 'Home', sports: 'Sports', live: 'Live TV', movies: 'Movies', series: 'Series', search: 'Search', remote: 'Remote', settings: 'Settings' };

function Screen({ r }: { r: Route }) {
  switch (r.name) {
    case 'home': return <Home />;
    case 'sports': return <Sports />;
    case 'live': return <Live />;
    case 'movies': return <Vod key="movie" kind="movie" />;
    case 'series': return <Vod key="series" kind="series" />;
    case 'movie': return <MovieDetail item={r.item} />;
    case 'show': return <SeriesDetail item={r.item} />;
    case 'search': return <Search />;
    case 'remote': return <Remote />;
    case 'settings': return <Settings />;
  }
}

export function App() {
  const [paired, setPaired] = useState(!!token.value);
  useEffect(() => { if (paired) { connect(); loadFavorites().catch(() => {}); } }, [paired]);
  useEffect(() => { if (!token.value) setPaired(false); }, [token.value]);

  const tabs = TOP.filter((t) => !(isTizen && t === 'remote'));
  const top = stack.value[0].name;
  const [ri, setRi] = useState(0);
  useEffect(() => { setRi(Math.max(0, tabs.indexOf(top))); }, [top]);

  // App shell keys (lowest layer): rail navigation; screens hand off 'left' / 'back' by not consuming them.
  useKeys((k) => {
    if (railFocused.value) {
      if (k === 'up') { setRi(Math.max(0, ri - 1)); return true; }
      if (k === 'down') { setRi(Math.min(tabs.length - 1, ri + 1)); return true; }
      if (k === 'ok' || k === 'right') { if (tabs[ri] !== top) go({ name: tabs[ri] } as Route); railFocused.value = false; return true; }
      if (k === 'back') { if (top !== 'home') { go({ name: 'home' }); railFocused.value = false; } else if (isTizen) { try { window.tizen.application.getCurrentApplication().hide(); } catch {} } return true; }
      return false;
    }
    if (k === 'left' || k === 'back') {
      if (k === 'back' && back()) return true;
      railFocused.value = true;
      return true;
    }
    if (k === 'green' && lease.value && lease.value.deviceId !== myDeviceId.value && !current.value) { takeover(); return true; }
    return false;
  }, 0);

  if (!paired) return <Pair onDone={() => setPaired(true)} />;

  const r = route();
  const l = lease.value;
  const elsewhere = l && l.deviceId !== myDeviceId.value && !current.value && r.name !== 'home' && r.name !== 'remote' ? l : null;

  return (
    <div class={`app ${isTizen ? 'tv' : isMobile ? 'phone' : 'desktop'} ${railFocused.value ? 'rail-focus' : ''}`}>
      <nav class="rail">
        {tabs.map((t, i) => (
          <button key={t} class={`${t === top ? 'sel' : ''} ${railFocused.value && i === ri ? 'focus' : ''}`} onClick={() => { go({ name: t } as Route); railFocused.value = false; }}>
            <svg viewBox="0 0 24 24"><path d={ICONS[t]} /></svg><span>{LABEL[t]}</span>
          </button>
        ))}
        <div class={`conn ${connected.value ? 'on' : ''}`} title={connected.value ? 'Connected' : 'Reconnecting…'} />
      </nav>
      <main class="screen"><Screen r={r} /></main>
      {elsewhere && (
        <button class="handoff-banner" onClick={() => takeover()}>
          ▶ <b>{clean(elsewhere.item.name)}</b> is playing on {devices.value.find((d) => d.id === elsewhere.deviceId)?.name ?? 'another device'} — <u>Continue here</u> <span class="key green" />
        </button>
      )}
      <PlayerHost />
      {toast.value && <div class={`toast ${mode.value === 'full' ? 'over' : ''}`}>{toast.value}</div>}
    </div>
  );
}
