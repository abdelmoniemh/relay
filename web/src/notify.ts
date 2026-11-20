// Reminders and notifications (Web Push). Push needs a secure origin (https, or localhost) and, on iPhone,
// Relay added to the Home Screen (iOS 16.4+). In-app reminders work everywhere regardless.
import { signal } from '@preact/signals';
import type { Item, ReminderInfo } from '@shared/protocol.ts';
import { api } from './api.ts';
import { t } from './i18n.ts';

export const reminders = signal<ReminderInfo[]>([]);

export async function loadReminders() { try { reminders.value = await api.reminders(); } catch {} return reminders.value; }

/** Remind me about a programme / event on `channel` (optionally start it on `autoplay` device at the start). */
export async function remind(channel: Item, prog: { start: number; stop?: number | null; title: string }, opts: { eventId?: string | null; autoplay?: string | null } = {}) {
  const r = await api.addReminder({ itemId: channel.id, title: prog.title, start: prog.start, stop: prog.stop ?? null, eventId: opts.eventId ?? null, autoplay: opts.autoplay ?? null });
  await loadReminders();
  return r;
}
export async function unremind(id: string) { await api.removeReminder(id); await loadReminders(); }
export const isReminded = (channelId: string, start: number) => reminders.value.some((r) => r.item.id === channelId && r.start === start);

/** Can this browser get notifications here (secure page + push support)? */
export function notificationsSupported() {
  return typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
/** Why not, in words (for Settings). */
export function notificationsBlocker(): string | null {
  if (typeof window === 'undefined') return t('Not available');
  if (!window.isSecureContext) return t('Notifications need Relay opened over https (e.g. through Tailscale), not a plain http address.');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return /iPhone|iPad/.test(navigator.userAgent) ? t('On iPhone, add Relay to the Home Screen first (Share → Add to Home Screen) and open it from there.') : t('This browser does not support notifications.');
  }
  if (Notification.permission === 'denied') return t('Notifications are blocked for Relay in this browser\'s settings.');
  return null;
}
export const notificationsOn = signal(typeof Notification !== 'undefined' && Notification.permission === 'granted');

const b64ToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

/** Turn notifications on (call from a tap: browsers only ask for permission then). */
export async function enableNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if ((await Notification.requestPermission()) !== 'granted') return false;
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const { key } = await api.pushKey();
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }));
  const { secret } = await api.pushSubscribe(sub.endpoint);
  await (await caches.open('relay-push')).put('/__push_secret', new Response(secret));
  notificationsOn.value = true;
  return true;
}
export async function disableNotifications() {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) { await api.pushUnsubscribe(sub.endpoint).catch(() => {}); await sub.unsubscribe(); }
  } catch {}
  notificationsOn.value = false;
}
