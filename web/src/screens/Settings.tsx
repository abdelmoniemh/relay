import { useState } from 'preact/hooks';
import { lowLatencySports, setLowLatency } from '../playback.ts';
import { api, server, setServer, myDeviceId, setCredentials, clearCache } from '../api.ts';
import { devices, connected } from '../ws.ts';
import { railFocused } from '../router.ts';
import { useAsync, useKeys } from '../ui/hooks.ts';
import { isTizen } from '../env.ts';

const ago = (ms: number) => { if (!ms) return 'never'; const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

export function Settings() {
  const [tick, setTick] = useState(0);
  const st = useAsync(() => api.status(), [tick]);
  const regions = useAsync(() => api.regions(), [tick]);
  const [allRegions, setAllRegions] = useState(false);
  const s = st.data;
  const me = devices.value.find((d) => d.id === myDeviceId.value);
  const rows: { label: string; value?: any; act?: () => void }[] = [
    { label: 'Pairing code for a new device', value: <b class="code">{s?.pairingCode ?? '…'}</b> },
    { label: 'This device', value: me?.name ?? '…', act: () => { const n = prompt('Device name', me?.name); if (n && me) api.renameDevice(me.id, n); } },
    { label: 'Server', value: `${server.value || location.origin} · ${connected.value ? 'connected' : 'offline'}`, act: isTizen ? () => { const u = prompt('Server URL', server.value); if (u) { setServer(u); location.reload(); } } : undefined },
    { label: 'Library', value: s ? `${(s.counts.live ?? 0).toLocaleString()} channels · ${(s.counts.movie ?? 0).toLocaleString()} movies · ${(s.counts.series ?? 0).toLocaleString()} series` : '…' },
    { label: s?.syncing ? 'Syncing…' : 'Refresh catalog & guide now', value: s ? `catalog ${ago(s.catalogSynced)}, guide ${ago(s.epgSynced)}` : '', act: () => { api.sync().then(() => { clearCache(); setTimeout(() => setTick((t) => t + 1), 500); }); } },
    ...vodLangRows(),
    { label: 'Movie & series info (TMDB)', value: !s ? '…' : s.tmdb.enabled ? `on · ${s.tmdb.pending ? `${s.tmdb.pending.toLocaleString()} titles to fetch` : 'up to date'}${s.tmdb.lastError ? ` · ${s.tmdb.lastError}` : ''}` : 'off — add a free TMDB key',
      act: () => {
        const k = prompt('TMDB API key or read-access token (themoviedb.org → Settings → API). Leave empty to remove.', '');
        if (k === null) return;
        api.settings({ tmdbKey: k }).then(() => { clearCache(); setTick((t) => t + 1); }).catch((e) => alert(e.message));
      } },
    { label: 'Letterboxd', value: !s ? '…' : s.letterboxd.user
        ? `@${s.letterboxd.user} · ${s.letterboxd.watchlist} on watchlist${s.letterboxd.syncing ? ' · syncing…' : s.letterboxd.syncedAt ? ` · synced ${ago(s.letterboxd.syncedAt)}` : ''}${s.letterboxd.error ? ` · ${s.letterboxd.error}` : ''}`
        : 'not linked — add your username',
      act: () => {
        const u = prompt('Your Letterboxd username (your watchlist must be public). Leave empty to unlink.', s?.letterboxd.user ?? '');
        if (u === null) return;
        api.settings({ letterboxd: u }).then(() => { clearCache(); setTimeout(() => setTick((t) => t + 1), 1500); });
      } },
    { label: 'Live sports delay', value: lowLatencySports.value ? 'Lowest (jump to live edge)' : 'Smooth (play provider backlog)', act: () => setLowLatency(!lowLatencySports.value) },
    ...regionRows(),
    ...devices.value.filter((d) => d.id !== myDeviceId.value).map((d) => ({
      label: `${d.online ? '● ' : '○ '}${d.name}`, value: `${d.kind} · remove`, act: () => { if (confirm(`Unpair ${d.name}?`)) api.removeDevice(d.id); },
    })),
    { label: 'Unpair this device', act: () => { setCredentials(null, null); location.reload(); } },
  ];
  function vodLangRows() {
    if (!s) return [];
    const on = new Set(s.vodLangs);
    const L: [string, string][] = [['en', 'English'], ['ar', 'Arabic audio'], ['ar-sub', 'Arabic subtitles'], ['other', 'Other languages']];
    return L.map(([code, name]) => ({
      label: `${on.has(code) ? '☑' : '☐'} Movies & series: ${name}`, value: '',
      act: () => {
        const next = on.has(code) ? s.vodLangs.filter((x) => x !== code) : [...s.vodLangs, code];
        if (!next.length) return;
        api.settings({ vodLangs: next }).then(() => { clearCache(); setTick((t) => t + 1); });
      },
    }));
  }
  function regionRows() {
    const r = regions.data;
    if (!r) return [];
    const on = new Set(r.enabled);
    const NAMES: Record<string, string> = { UK: 'United Kingdom', US: 'United States', CA: 'Canada', AR: 'Arabic', '4K': '4K (mixed, mostly UK sport)', IE: 'Ireland', AU: 'Australia', ES: 'Spain', FR: 'France', DE: 'Germany', NL: 'Netherlands', IT: 'Italy', TR: 'Turkey', IN: 'India', PT: 'Portugal' };
    const list = [...r.all].sort((a, b) => Number(on.has(b.code)) - Number(on.has(a.code)) || b.channels - a.channels);
    const shown = allRegions ? list : list.slice(0, Math.max(on.size + 3, 8));
    const toggle = (code: string) => {
      const next = on.has(code) ? r.enabled.filter((x) => x !== code) : [...r.enabled, code];
      api.settings({ regions: next }).then(() => { clearCache(); setTick((t) => t + 1); });
    };
    return [
      ...shown.map((x) => ({ label: `${on.has(x.code) ? '☑' : '☐'} Live TV: ${NAMES[x.code] ?? x.code}`, value: `${x.channels.toLocaleString()} channels`, act: () => toggle(x.code) })),
      ...(!allRegions && list.length > shown.length ? [{ label: `Show all ${list.length} regions…`, act: () => setAllRegions(true) }] : []),
    ];
  }
  const [fi, setFi] = useState(0);
  useKeys((k) => {
    if (railFocused.value) return false;
    if (k === 'up') { setFi(Math.max(0, fi - 1)); return true; }
    if (k === 'down') { setFi(Math.min(rows.length - 1, fi + 1)); return true; }
    if (k === 'ok') { rows[fi]?.act?.(); return true; }
    return false;
  });
  return (
    <div class="settings">
      <h1>Settings</h1>
      {rows.map((r, i) => (
        <div key={r.label} class={`row setting ${i === fi && !railFocused.value ? 'focus' : ''} ${r.act ? 'clickable' : ''}`} onClick={() => { setFi(i); r.act?.(); }}>
          <span>{r.label}</span><span class="muted">{r.value}</span>
        </div>
      ))}
      <p class="muted small help">Keys: arrows to move · OK to select · Back · <b class="red">●</b> red = favorite · <b class="blue">●</b> blue = send to another device · CH± to zap</p>
    </div>
  );
}
