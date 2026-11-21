import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Item, TitleCard } from '@shared/protocol.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Logo, NowLine, stars, diaryStars } from './common.tsx';
import { displayName } from '@shared/domain.ts';
import { img } from '../env.ts';
import { t } from '../i18n.ts';
import { nowNext } from './hooks.ts';
import { useKeys } from './hooks.ts';

export interface Action { label: string; icon?: IconName; act: () => void; primary?: boolean }

export function Btn({ a, focused }: { a: Action; focused?: boolean }) {
  return (
    <button class={`btn ${a.primary ? 'primary' : 'secondary'} ${focused ? 'focus' : ''}`} onClick={a.act}>
      {a.icon && <Icon n={a.icon} />}<span>{a.label}</span>
    </button>
  );
}

export function IconBtn({ n, label, onClick, class: cls }: { n: IconName; label: string; onClick: () => void; class?: string }) {
  return <button class={`icon-btn ${cls ?? ''}`} aria-label={label} title={label} onClick={onClick}><Icon n={n} /></button>;
}

export function Billboard({ backdrop, poster, title, meta, plot, actions, focus, eyebrow }: {
  backdrop?: string | null; poster?: string | null; title: string; meta?: string; plot?: string | null;
  actions: Action[]; focus: number; eyebrow?: string;
}) {
  return (
    <section class={`billboard ${backdrop ? '' : 'no-art'}`}>
      {backdrop ? <img class="bb-art" src={img(backdrop, 1280)} alt="" />
        : poster ? <img class="bb-art blur" src={img(poster, 342)} alt="" /> : null}
      <div class="bb-scrim" />
      <div class="bb-body">
        {eyebrow && <div class="bb-context">{eyebrow}</div>}
        <h1 class="bb-title">{title}</h1>
        {meta && <div class="bb-meta">{meta}</div>}
        {plot && <p class="bb-plot">{plot}</p>}
        <div class="bb-actions">{actions.map((a, i) => <Btn key={a.label} a={a} focused={i === focus} />)}</div>
      </div>
    </section>
  );
}

/** A titled horizontal row. `focus` is the focused tile index (-1 = none); keeps it scrolled into view. */
export function Row({ title, count, focus, children, wide, onMore }: {
  title: string; count?: number; focus: number; children: ComponentChildren; wide?: boolean; onMore?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sec = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || focus < 0) return;
    const child = el.children[focus] as HTMLElement | undefined;
    if (!child) return;
    // Screen-space deltas work the same in LTR and RTL scrollers.
    const cr = child.getBoundingClientRect(), er = el.getBoundingClientRect();
    const pad = 48;
    if (cr.left < er.left + pad) el.scrollLeft += cr.left - er.left - pad;
    else if (cr.right > er.right - pad) el.scrollLeft += cr.right - er.right + pad;
    sec.current?.scrollIntoView({ block: 'nearest' });
  }, [focus]);
  return (
    <section class={`row-sec ${wide ? 'wide' : ''}`} ref={sec}>
      <h2 class="row-title">
        {onMore ? <button class="row-link" onClick={onMore}>{title}<Icon n="chevron" /></button> : title}
        {count != null && <small>{count.toLocaleString()}</small>}
      </h2>
      <div class="row-scroll" ref={ref}>{children}</div>
    </section>
  );
}

export function SkeletonRow({ wide }: { wide?: boolean }) {
  return (
    <section class={`row-sec ${wide ? 'wide' : ''}`} aria-hidden="true">
      <div class="row-title"><span class="skel-text" /></div>
      <div class="row-scroll">{Array.from({ length: 8 }, (_, i) => <div key={i} class={`tile skel ${wide ? 'landscape' : 'poster'}`} />)}</div>
    </section>
  );
}

export function PosterTile({ src, title, sub, progress, focused, onClick, badges }: {
  src?: string | null; title: string; sub?: string; progress?: number; focused?: boolean; onClick?: () => void; badges?: ComponentChildren;
}) {
  const u = img(src, 342);
  return (
    <div class={`tile poster ${focused ? 'focus' : ''}`} onClick={onClick} role="button" tabIndex={-1}>
      <div class="art">
        {u ? <img src={u} loading="lazy" decoding="async" alt="" onError={(e) => ((e.currentTarget as HTMLImageElement).style.opacity = '0')} />
          : <span class="ph">{title.slice(0, 1)}</span>}
        {badges}
        {progress != null && progress > 0 && <div class="tile-bar"><i style={{ width: `${Math.min(100, progress * 100)}%` }} /></div>}
      </div>
      <div class="cap">{title}</div>
      {sub && <div class="sub">{sub}</div>}
    </div>
  );
}

export function ChannelTile({ it, focused, onClick, playing }: { it: Item; focused?: boolean; onClick?: () => void; playing?: boolean }) {
  return (
    <div class={`tile landscape chan ${focused ? 'focus' : ''} ${playing ? 'playing' : ''}`} onClick={onClick} role="button" tabIndex={-1}>
      <div class="art"><Logo src={it.icon} name={it.name} size={72} /></div>
      <div class="cap">{displayName(it.name)}</div>
      <NowLine list={nowNext(it.epg)} />
    </div>
  );
}

export function LivePill() { return <span class="live-pill">{t('LIVE')}</span>; }

export function QualityChip({ label, verified, dead }: { label: string; verified?: boolean; dead?: boolean }) {
  const txt = label.replace(' · unverified', '');
  return <span class={`qchip ${dead ? 'bad' : verified ? 'ok' : 'unverified'}`}>{txt}{verified && !dead ? <Icon n="check" /> : null}</span>;
}

export function Segmented<T extends string>({ value, options, onChange, focus }: {
  value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; focus?: number;
}) {
  return (
    <div class="segmented" role="tablist">
      {options.map((o, i) => (
        <button key={o.v} role="tab" aria-selected={o.v === value} class={`${o.v === value ? 'sel' : ''} ${focus === i ? 'focus' : ''}`}
          onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  // Modal: D-pad moves real DOM focus between the sheet's controls, OK activates the focused one.
  useKeys((k) => {
    if (k === 'back') { onClose(); return true; }
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('button, input, [role=button]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (k === 'up' || k === 'left' || k === 'down' || k === 'right') {
      const d = k === 'up' || k === 'left' ? -1 : 1;
      els[Math.max(0, Math.min(els.length - 1, i < 0 ? (d > 0 ? 0 : els.length - 1) : i + d))]?.focus();
      return true;
    }
    if (k === 'ok' && i >= 0 && els[i].tagName !== 'INPUT') { els[i].click(); return true; }
    return true;
  }, 2);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('input, .btn.primary');
    first?.focus();
  }, []);
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="sheet" ref={ref} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head"><h2>{title}</h2><IconBtn n="close" label={t('Close')} onClick={onClose} /></div>
        {children}
      </div>
    </div>
  );
}

/** Replaces window.prompt(): a text field in a sheet. */
export function EditSheet({ title, hint, initial, onSave, onClose }: {
  title: string; hint?: string; initial: string; onSave: (v: string) => void; onClose: () => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <Sheet title={title} onClose={onClose}>
      {hint && <p class="sheet-hint">{hint}</p>}
      <input id="edit-sheet-input" class="field" value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { onSave(v.trim()); onClose(); } }} />
      <div class="sheet-actions">
        <Btn a={{ label: t('Cancel'), act: onClose }} />
        <Btn a={{ label: t('Save'), primary: true, act: () => { onSave(v.trim()); onClose(); } }} />
      </div>
    </Sheet>
  );
}

/** A film / show as a poster: rating, progress, Letterboxd marks. */
export function Card({ c, focused, onClick }: { c: TitleCard; focused: boolean; onClick?: () => void }) {
  const sub = [c.progress?.label, c.year, stars(c.rating)].filter(Boolean).join(' · ');
  return (
    <PosterTile src={c.poster} title={c.name} sub={sub} focused={focused} onClick={onClick}
      progress={c.progress && c.progress.duration > 0 ? c.progress.position / c.progress.duration : undefined}
      badges={<>
        {c.uhd && <span class="badge-4k">4K</span>}
        {c.fresh && c.wl && <span class="badge-new">{t('NEW')}</span>}
        {c.wl && !c.watched && <span class="badge-wl" title={t('On your Letterboxd watchlist')} />}
        {c.watched ? <span class="badge-seen"><Icon n="check" />{typeof c.watched === 'number' ? ` ${diaryStars(c.watched)}` : ''}</span> : null}
      </>} />
  );
}
