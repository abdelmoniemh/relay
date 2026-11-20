// A channel's programmes: earlier ones to watch from the start (catch-up channels), the one on air (start over),
// and later ones to be reminded of. Opened from the Live screen and from the player.
import { useEffect, useState } from 'preact/hooks';
import type { Item, Programme } from '@shared/protocol.ts';
import { api, myDeviceId } from '../api.ts';
import { canCatchup, playCatchup } from '../playback.ts';
import { reminders, loadReminders, remind, unremind } from '../notify.ts';
import { devices } from '../ws.ts';
import { clock, isTizen } from '../env.ts';
import { t } from '../i18n.ts';
import { Sheet, Btn } from './kit.tsx';
import { Icon } from './Icon.tsx';

import { displayName } from '@shared/domain.ts';

const day = (unix: number) => {
  const d = new Date(unix * 1000), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const tm = new Date(); tm.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return t('Today');
  if (d.toDateString() === y.toDateString()) return t('Yesterday');
  if (d.toDateString() === tm.toDateString()) return t('Tomorrow');
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

/** The reminder (if any) for this programme on this channel. */
export const reminderFor = (channelId: string, start: number) => reminders.value.find((r) => r.item.id === channelId && r.start === start);

export function ProgrammesSheet({ channel, onClose }: { channel: Item; onClose: () => void }) {
  const [list, setList] = useState<Programme[] | null>(null);
  const [ask, setAsk] = useState<Programme | null>(null);
  const now = Date.now() / 1000;
  useEffect(() => {
    if (!channel.epg) { setList([]); return; }
    const back = channel.archive ? Math.min(channel.archive, 3) * 86400 : 3600;
    api.guide([channel.epg], now - back, now + 18 * 3600).then((g) => setList(g[channel.epg!] ?? [])).catch(() => setList([]));
    loadReminders();
  }, [channel.id]);

  const past = (list ?? []).filter((p) => p.stop <= now && canCatchup(channel, p)).reverse();
  const onNow = (list ?? []).find((p) => p.start <= now && p.stop > now);
  const later = (list ?? []).filter((p) => p.start > now).slice(0, 40);
  const watch = (p: Programme) => { onClose(); playCatchup(channel, p); };

  return (
    <Sheet title={displayName(channel.name)} onClose={onClose}>
      {!list && <div class="spinner inline" />}
      {list && !list.length && <p class="sheet-hint">{t('No programme guide for this channel')}</p>}
      {onNow && (
        <section class="set-group">
          <h2 class="list-head">{t('On now')}</h2>
          <div class="list-group">
            <div class="list-row">
              <span class="lr-main"><b>{onNow.title}</b><span class="lr-sub tnum">{clock(onNow.start)}–{clock(onNow.stop)}</span></span>
              {canCatchup(channel, onNow) && <button class="pill-btn" onClick={() => watch(onNow)}><Icon n="restart" />{t('Start over')}</button>}
            </div>
          </div>
        </section>
      )}
      {later.length > 0 && (
        <section class="set-group">
          <h2 class="list-head">{t('Later')}</h2>
          <div class="list-group">
            {later.map((p) => {
              const r = reminderFor(channel.id, p.start);
              return (
                <button key={p.start} class="list-row tappable" aria-pressed={!!r} onClick={() => (r ? unremind(r.id) : setAsk(p))}>
                  <span class="lr-main"><b>{p.title}</b><span class="lr-sub tnum">{day(p.start)} · {clock(p.start)}–{clock(p.stop)}</span></span>
                  <span class="lr-value">{r ? <><Icon n="check" />{r.autoplay ? t('Starts on {name}', { name: devices.value.find((d) => d.id === r.autoplay)?.name ?? '…' }) : t('Reminder set')}</> : <><Icon n="plus" />{t('Remind me')}</>}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      {past.length > 0 && (
        <section class="set-group">
          <h2 class="list-head">{t('Earlier (catch-up)')}</h2>
          <div class="list-group">
            {past.map((p) => (
              <button key={p.start} class="list-row tappable" onClick={() => watch(p)}>
                <span class="lr-main"><b>{p.title}</b><span class="lr-sub tnum">{day(p.start)} · {clock(p.start)}–{clock(p.stop)}</span></span>
                <Icon n="play" class="lr-chev" />
              </button>
            ))}
          </div>
        </section>
      )}
      {ask && <RemindSheet channel={channel} prog={ask} onClose={() => setAsk(null)} />}
    </Sheet>
  );
}

/** "Remind me" or "start it on <device>" for a programme or sports event. */
export function RemindSheet({ channel, prog, eventId, onClose }: { channel: Item; prog: { start: number; stop?: number | null; title: string }; eventId?: string | null; onClose: () => void }) {
  const set = (autoplay: string | null) => { remind(channel, prog, { eventId, autoplay }).catch(() => {}); onClose(); };
  // Auto-start makes most sense on the TV; list every device, the TV(s) first.
  const targets = [...devices.value].sort((a, b) => Number(b.kind === 'tv') - Number(a.kind === 'tv'));
  return (
    <Sheet title={prog.title} onClose={onClose}>
      <p class="sheet-hint tnum">{day(prog.start)} · {clock(prog.start)}{prog.stop ? `–${clock(prog.stop)}` : ''} · {displayName(channel.name)}</p>
      <div class="list-group">
        <button class="list-row tappable" onClick={() => set(isTizen ? myDeviceId.value : null)}>
          <span class="lr-main"><b>{isTizen ? t('Start it here when it begins') : t('Just remind me')}</b><span class="lr-sub">{t('Every open Relay app shows it a minute before')}</span></span>
        </button>
        {targets.filter((d) => !(isTizen && d.id === myDeviceId.value)).map((d) => (
          <button key={d.id} class="list-row tappable" onClick={() => set(d.id)}>
            <Icon n={d.kind === 'tv' ? 'tv' : d.kind === 'phone' ? 'phone' : 'desktop'} class="lr-icon" />
            <span class="lr-main"><b>{t('Start on {name}', { name: d.name })}</b><span class="lr-sub">{d.online ? t('Online') : t('Must be open at the time')}</span></span>
          </button>
        ))}
      </div>
      <div class="sheet-actions"><Btn a={{ label: t('Cancel'), act: onClose }} /></div>
    </Sheet>
  );
}
