import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { lowLatencySports, setLowLatency } from '../playback.ts';
import { api, server, setServer, myDeviceId, setCredentials, clearCache } from '../api.ts';
import { devices, connected } from '../ws.ts';
import { navFocused, back, compact, stack } from '../router.ts';
import { useAsync, useKeys } from '../ui/hooks.ts';
import { EditSheet, IconBtn, Sheet, Btn } from '../ui/kit.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { isTizen } from '../env.ts';
import { t, lang, setLang } from '../i18n.ts';

const ago = (ms: number) => {
  if (!ms) return t('never');
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? t('just now') : m < 60 ? t('{n} min ago', { n: m }) : t('{n} h ago', { n: Math.round(m / 60) });
};
const REGION: Record<string, string> = { UK: 'United Kingdom', US: 'United States', CA: 'Canada', AR: 'Arabic', '4K': '4K (mixed, mostly UK sport)', IE: 'Ireland', AU: 'Australia', ES: 'Spain', FR: 'France', DE: 'Germany', NL: 'Netherlands', IT: 'Italy', TR: 'Turkey', IN: 'India', PT: 'Portugal' };
const DEVICE_ICON: Record<string, IconName> = { tv: 'tv', phone: 'phone', desktop: 'desktop' };

/** One row: label at the start, value / switch / chevron at the end. */
interface R { id: string; label: string; sub?: ComponentChildren; value?: ComponentChildren; act?: () => void; toggle?: boolean; icon?: IconName; danger?: boolean }
interface G { title: string; rows: R[]; foot?: string }

type Edit = { title: string; hint?: string; initial: string; save: (v: string) => void } | null;

export function Settings() {
  const [tick, setTick] = useState(0);
  const st = useAsync(() => api.status(), [tick]);
  const regions = useAsync(() => api.regions(), [tick]);
  const [allRegions, setAllRegions] = useState(false);
  const [edit, setEdit] = useState<Edit>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; ok: string; act: () => void } | null>(null);
  const refresh = (ms = 0) => setTimeout(() => setTick((n) => n + 1), ms);
  const s = st.data;
  const me = devices.value.find((d) => d.id === myDeviceId.value);
  // Poll while the server is busy so the status line updates by itself.
  useEffect(() => { if (s?.syncing || s?.letterboxd.syncing) { const x = setTimeout(() => refresh(), 3000); return () => clearTimeout(x); } }, [s]);

  const groups: G[] = [];
  groups.push({ title: t('This device'), rows: [
    { id: 'name', label: t('Name'), value: me?.name ?? '…', act: () => me && setEdit({ title: t('Rename this device'), initial: me.name, save: (n) => n && api.renameDevice(me.id, n) }) },
    { id: 'lang', label: t('Language'), icon: 'globe', value: lang.value === 'ar' ? 'العربية' : 'English', act: () => setLang(lang.value === 'ar' ? 'en' : 'ar') },
    { id: 'server', label: t('Server'), sub: `${server.value || location.origin}`, value: connected.value ? t('Connected') : t('Offline'),
      act: isTizen ? () => setEdit({ title: t('Server address'), initial: server.value, save: (u) => { if (u) { setServer(u); location.reload(); } } }) : undefined },
  ] });
  groups.push({ title: t('Devices'), foot: t('Use this code to pair a new phone, TV or computer.'), rows: [
    { id: 'code', label: t('Pairing code'), value: <b class="code tnum">{s?.pairingCode ?? '…'}</b> },
    ...devices.value.filter((d) => d.id !== myDeviceId.value).map((d): R => ({
      id: `dev${d.id}`, label: d.name, icon: DEVICE_ICON[d.kind] ?? 'desktop', sub: d.online ? t('Online') : t('Offline'), value: t('Remove'),
      act: () => setConfirm({ title: t('Remove {name}?', { name: d.name }), body: t('It will need the pairing code to connect again.'), ok: t('Remove'), act: () => api.removeDevice(d.id) }),
    })),
  ] });
  groups.push({ title: t('Playback'), rows: [
    { id: 'lowlat', label: t('Lowest delay for live sport'), sub: lowLatencySports.value ? t('Jumps to the live edge') : t('Plays the provider’s buffer for smoother video'),
      toggle: lowLatencySports.value, act: () => setLowLatency(!lowLatencySports.value) },
  ] });
  if (s) {
    const on = new Set(s.vodLangs);
    const L: [string, string][] = [['en', 'English'], ['ar', 'Arabic audio'], ['ar-sub', 'Arabic subtitles'], ['other', 'Other languages']];
    groups.push({ title: t('Movies & series languages'), foot: t('Only titles in these languages appear in Movies & TV.'), rows: L.map(([code, name]) => ({
      id: `vl${code}`, label: t(name), toggle: on.has(code),
      act: () => {
        const next = on.has(code) ? s.vodLangs.filter((x) => x !== code) : [...s.vodLangs, code];
        if (next.length) api.settings({ vodLangs: next }).then(() => { clearCache(); refresh(); });
      },
    })) });
  }
  const r = regions.data;
  if (r) {
    const on = new Set(r.enabled);
    const list = [...r.all].sort((a, b) => Number(on.has(b.code)) - Number(on.has(a.code)) || b.channels - a.channels);
    const shown = allRegions ? list : list.slice(0, Math.max(on.size + 3, 8));
    groups.push({ title: t('Live TV regions'), rows: [
      ...shown.map((x): R => ({
        id: `rg${x.code}`, label: t(REGION[x.code] ?? x.code), sub: t('{n} channels', { n: x.channels.toLocaleString() }), toggle: on.has(x.code),
        act: () => { const next = on.has(x.code) ? r.enabled.filter((y) => y !== x.code) : [...r.enabled, x.code]; api.settings({ regions: next }).then(() => { clearCache(); refresh(); }); },
      })),
      ...(!allRegions && list.length > shown.length ? [{ id: 'allrg', label: t('Show all {n} regions', { n: list.length }), act: () => setAllRegions(true) }] : []),
    ] });
  }
  groups.push({ title: t('Library'), rows: [
    { id: 'lib', label: t('Catalogue'), value: s ? t('{a} channels · {b} movies · {c} series', { a: (s.counts.live ?? 0).toLocaleString(), b: (s.counts.movie ?? 0).toLocaleString(), c: (s.counts.series ?? 0).toLocaleString() }) : '…' },
    { id: 'sync', label: s?.syncing ? t('Refreshing…') : t('Refresh catalogue and guide'), icon: 'refresh',
      sub: s ? t('Catalogue {a}, guide {b}', { a: ago(s.catalogSynced), b: ago(s.epgSynced) }) : '',
      act: () => { api.sync().then(() => { clearCache(); refresh(500); }); } },
    { id: 'tmdb', label: t('Movie & series info (TMDB)'),
      sub: !s ? '…' : s.tmdb.enabled ? (s.tmdb.pending ? t('{n} titles to fetch', { n: s.tmdb.pending.toLocaleString() }) : t('Up to date')) + (s.tmdb.lastError ? ` · ${s.tmdb.lastError}` : '') : t('Off. Add a free TMDB key.'),
      value: s?.tmdb.enabled ? t('On') : t('Off'),
      act: () => setEdit({ title: t('TMDB key'), hint: t('API key or read-access token from themoviedb.org › Settings › API. Leave empty to remove.'), initial: '',
        save: (k) => { api.settings({ tmdbKey: k }).then(() => { clearCache(); refresh(); }); } }) },
    { id: 'lb', label: 'Letterboxd',
      sub: !s ? '…' : s.letterboxd.user
        ? `@${s.letterboxd.user} · ${t('{n} on watchlist', { n: s.letterboxd.watchlist })}${s.letterboxd.syncing ? ` · ${t('syncing…')}` : s.letterboxd.syncedAt ? ` · ${t('synced {t}', { t: ago(s.letterboxd.syncedAt) })}` : ''}${s.letterboxd.error ? ` · ${s.letterboxd.error}` : ''}`
        : t('Not linked'),
      value: s?.letterboxd.fromConfig ? t('Set on server') : undefined,
      act: s?.letterboxd.fromConfig ? undefined : () => setEdit({ title: t('Letterboxd username'), hint: t('Your watchlist must be public. Leave empty to unlink.'), initial: s?.letterboxd.user ?? '',
        save: (u) => { api.settings({ letterboxd: u }).then(() => { clearCache(); refresh(1500); }); } }) },
  ] });
  groups.push({ title: '', rows: [
    { id: 'unpair', label: t('Unpair this device'), danger: true,
      act: () => setConfirm({ title: t('Unpair this device?'), body: t('You will need the pairing code to connect it again.'), ok: t('Unpair'), act: () => { setCredentials(null, null); location.reload(); } }) },
  ] });

  const flat = groups.flatMap((g) => g.rows);
  const [fi, setFi] = useState(0);
  useKeys((k) => {
    if (navFocused.value || edit || confirm) return false;
    if (k === 'up') { if (fi === 0) return false; setFi(fi - 1); return true; }
    if (k === 'down') { setFi(Math.min(flat.length - 1, fi + 1)); return true; }
    if (k === 'ok') { flat[fi]?.act?.(); return true; }
    return k === 'left' || k === 'right';
  });
  useEffect(() => { (document.querySelector('.settings .list-row.focus') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' }); }, [fi]);

  const kb = !navFocused.value && !compact.value;
  let n = -1;
  return (
    <div class="settings page">
      <h1 class="screen-title">{compact.value && stack.value.length > 1 && <IconBtn n="back" label={t('Back')} onClick={() => back()} />}{t('Settings')}</h1>
      {groups.map((g) => (
        <section key={g.title || 'end'} class="set-group">
          {g.title && <h2 class="list-head">{g.title}</h2>}
          <div class="list-group">
            {g.rows.map((row) => {
              n++;
              const i = n;
              return (
                <div key={row.id} class={`list-row ${kb && i === fi ? 'focus' : ''} ${row.act ? 'tappable' : ''} ${row.danger ? 'danger' : ''}`}
                  role={row.toggle !== undefined ? 'switch' : row.act ? 'button' : undefined} aria-checked={row.toggle}
                  onClick={() => { setFi(i); row.act?.(); }}>
                  {row.icon && <Icon n={row.icon} class="lr-icon" />}
                  <span class="lr-main"><b>{row.label}</b>{row.sub && <span class="lr-sub">{row.sub}</span>}</span>
                  {row.value != null && <span class="lr-value">{row.value}</span>}
                  {row.toggle !== undefined ? <span class={`switch ${row.toggle ? 'on' : ''}`} aria-hidden="true"><i /></span>
                    : row.act && !row.danger ? <Icon n="chevron" class="lr-chev" /> : null}
                </div>
              );
            })}
          </div>
          {g.foot && <p class="list-foot">{g.foot}</p>}
        </section>
      ))}
      {!compact.value && <p class="help">{t('Remote keys: red = favourite · green = watch here · blue = send to another device · CH± = next/previous channel')}</p>}
      {edit && <EditSheet title={edit.title} hint={edit.hint} initial={edit.initial} onSave={edit.save} onClose={() => setEdit(null)} />}
      {confirm && (
        <Sheet title={confirm.title} onClose={() => setConfirm(null)}>
          <p class="sheet-hint">{confirm.body}</p>
          <div class="sheet-actions">
            <Btn a={{ label: t('Cancel'), act: () => setConfirm(null) }} />
            <Btn a={{ label: confirm.ok, primary: true, act: () => { confirm.act(); setConfirm(null); } }} />
          </div>
        </Sheet>
      )}
    </div>
  );
}
