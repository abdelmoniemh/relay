import { useEffect, useState } from 'preact/hooks';
import { token, loadFavorites, myDeviceId } from './api.ts';
import { connect, connected, lease } from './ws.ts';
import { stack, route, go, back, navFocused, SECTIONS, UTILITIES, compact, lastVod, tabOf, scrolled, type Route, type Tab } from './router.ts';
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
import { Browse, Grid } from './screens/Browse.tsx';
import { TitleScreen } from './screens/Title.tsx';
import { Pair } from './screens/Pair.tsx';
import { Icon, type IconName } from './ui/Icon.tsx';
import { MiniPlayer } from './ui/kit.tsx';
import { isMobile, isTizen } from './env.ts';
import { t, lang } from './i18n.ts';

const ICON: Record<Tab, IconName> = { home: 'home', live: 'live', sports: 'sports', vod: 'film', search: 'search', remote: 'remote', settings: 'settings' };
const LABEL = (k: Tab) => ({ home: t('Home'), live: t('Live TV'), sports: t('Sports'), vod: t('Movies & TV'), search: t('Search'), remote: t('Remote'), settings: t('Settings') })[k];

/** Screens whose first thing is full-bleed artwork: the desktop/TV top bar floats over them. */
const BILLBOARD: Route['name'][] = ['home', 'movies', 'series', 'title'];

function Screen({ r }: { r: Route }) {
  switch (r.name) {
    case 'home': return <Home />;
    case 'sports': return <Sports />;
    case 'live': return <Live />;
    case 'movies': return <Browse key="movie" kind="movie" />;
    case 'series': return <Browse key="series" kind="series" />;
    case 'grid': return <Grid key={JSON.stringify(r)} kind={r.kind} filters={r.filters} title={r.title} />;
    case 'title': return <TitleScreen key={r.tid} tid={r.tid} />;
    case 'categories': return <Vod key={`c${r.kind}`} kind={r.kind} />;
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
  lang.value; // re-render everything when the language changes

  const phone = compact.value;
  const r = route();
  const top = stack.value[0].name;
  const active = tabOf(top);
  // Phone: Remote/Settings open from Home's header, so the Home tab stays lit.
  const lit: Tab = phone && (active === 'remote' || active === 'settings') ? 'home' : active;
  const navItems: Tab[] = phone ? SECTIONS : [...SECTIONS, ...UTILITIES];
  const [ni, setNi] = useState(0);
  useEffect(() => { setNi(Math.max(0, navItems.indexOf(lit))); }, [lit, phone, navFocused.value]);
  useEffect(() => { if (top === 'movies' || top === 'series') lastVod.value = top; }, [top]);
  useEffect(() => { scrolled.value = false; }, [r]);

  const open = (k: Tab) => {
    navFocused.value = false;
    if (k === active && stack.value.length > 1) { go(stack.value[0]); return; } // re-select a section: back to its root
    if (k === active) return;
    go({ name: k === 'vod' ? lastVod.value : k } as Route);
  };

  // App shell keys (lowest layer). Screens return false for 'up' at their top edge and for unhandled 'back'.
  useKeys((k) => {
    if (navFocused.value) {
      if (k === 'left') { setNi(Math.max(0, ni - 1)); return true; }
      if (k === 'right') { setNi(Math.min(navItems.length - 1, ni + 1)); return true; }
      if (k === 'ok') { open(navItems[ni]); return true; }
      if (k === 'down') { navFocused.value = false; return true; }
      if (k === 'back') {
        if (top !== 'home') go({ name: 'home' });
        else if (isTizen) { try { window.tizen.application.getCurrentApplication().hide(); } catch {} }
        return true;
      }
      return true;
    }
    if (k === 'back') { if (back()) return true; navFocused.value = true; return true; }
    if (k === 'up' && !phone) { navFocused.value = true; return true; }
    if (k === 'green' && lease.value && lease.value.deviceId !== myDeviceId.value && !current.value) { takeover(); return true; }
    return false;
  }, 0);

  if (!paired) return <Pair onDone={() => setPaired(true)} />;

  const rtl = document.documentElement.dir === 'rtl';
  const kind = isTizen ? 'tv' : isMobile ? 'phone' : 'desktop';
  const overArt = BILLBOARD.includes(r.name);

  return (
    <div class={`app ${kind} ${phone ? 'compact' : 'wide'} ${navFocused.value ? 'nav-focus' : ''} ${overArt ? 'over-art' : ''}`} dir={rtl ? 'rtl' : 'ltr'}>
      {phone ? (
        <nav class="tabbar" aria-label={t('Sections')}>
          {SECTIONS.map((k, i) => (
            <button key={k} class={`${k === lit ? 'sel' : ''} ${navFocused.value && i === ni ? 'focus' : ''}`} aria-current={k === lit ? 'page' : undefined} onClick={() => open(k)}>
              <i class="tab-ic"><Icon n={ICON[k]} filled={false} /></i><span>{LABEL(k)}</span>
            </button>
          ))}
        </nav>
      ) : (
        <header class={`topbar ${scrolled.value || !overArt ? 'solid' : ''}`}>
          <button class="brand" onClick={() => open('home')} aria-label="Relay">
            <svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" /><path d="M24 18v28l22-14z" /></svg>
            <span>Relay</span>
          </button>
          <nav class="sections" aria-label={t('Sections')}>
            {navItems.map((k, i) => {
              const util = !SECTIONS.includes(k) || (k === 'search' && !isTizen);
              return (
                <button key={k} class={`${util ? 'util' : 'link'} ${k === lit ? 'sel' : ''} ${navFocused.value && i === ni ? 'focus' : ''}`}
                  aria-current={k === lit ? 'page' : undefined} aria-label={LABEL(k)} title={util ? LABEL(k) : undefined} onClick={() => open(k)}>
                  {util ? <Icon n={ICON[k]} /> : LABEL(k)}
                </button>
              );
            })}
          </nav>
          <span class={`conn ${connected.value ? 'on' : ''}`} title={connected.value ? t('Connected') : t('Reconnecting…')} />
        </header>
      )}
      <main class="screen"><Screen r={r} /></main>
      {r.name !== 'remote' && <MiniPlayer />}
      <PlayerHost />
      {toast.value && <div class={`toast ${mode.value === 'full' ? 'over' : ''}`} role="status">{toast.value}</div>}
      <OfflineBanner />
    </div>
  );
}

/** The server has been unreachable for a few seconds: say so plainly (a stuck spinner says nothing). */
function OfflineBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (connected.value) { setShow(false); return; }
    const x = setTimeout(() => setShow(true), 4000);
    return () => clearTimeout(x);
  }, [connected.value]);
  if (!show) return null;
  return <div class="offline-banner" role="alert">{t("Can't reach the Relay server. Reconnecting… Check this device is on the home network (or Tailscale).")}</div>;
}
