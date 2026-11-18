import { isTizen } from './env.ts';

export type Key =
  | 'up' | 'down' | 'left' | 'right' | 'ok' | 'back'
  | 'playpause' | 'play' | 'pause' | 'stop' | 'ff' | 'rw' | 'chup' | 'chdown'
  | 'red' | 'green' | 'yellow' | 'blue' | 'info' | 'volup' | 'voldown' | 'mute'
  | `digit${number}`;

type Handler = (k: Key) => boolean | void;
/** Layers: 0 = app shell (rail), 1 = screen, 2 = overlays (player, dialogs). */
const stack: { h: Handler; layer: number; seq: number }[] = [];
let seq = 0;

/** Higher layer first, then most recently registered; return true to consume. */
export function pushKeys(h: Handler, layer = 1) {
  const e = { h, layer, seq: seq++ };
  stack.push(e);
  stack.sort((a, b) => a.layer - b.layer || a.seq - b.seq);
  return () => { const i = stack.indexOf(e); if (i >= 0) stack.splice(i, 1); };
}

export function dispatchKey(k: Key) {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].h(k)) return true;
  return false;
}

const CODES: Record<number, Key> = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 10009: 'back', 27: 'back',
  10252: 'playpause', 415: 'play', 19: 'pause', 413: 'stop', 417: 'ff', 412: 'rw',
  427: 'chup', 428: 'chdown', 33: 'chup', 34: 'chdown', 403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 457: 'info',
};

export function installKeys() {
  if (isTizen) {
    try {
      window.tizen.tvinputdevice.registerKeyBatch([
        'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
        'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
      ]);
    } catch {}
  }
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    let k: Key | undefined = CODES[e.keyCode];
    if (!typing) {
      if (e.key === ' ') k = 'playpause';
      else if (e.key === 'Backspace') k = 'back';
      else if (e.key === 'f') k = 'red';
      else if (e.key === 'i') k = 'info';
      else if (e.key >= '0' && e.key <= '9') k = `digit${Number(e.key)}`;
    } else if (k === 'left' || k === 'right' || k === 'ok' && t.tagName === 'TEXTAREA') {
      return; // let the input handle caret movement
    }
    if (k && dispatchKey(k)) e.preventDefault();
  });
}
