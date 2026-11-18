import sax from 'sax';
import type { Programme } from '../../shared/protocol.ts';

/** "20261118120000 +0100" -> unix seconds */
export function parseXmltvTime(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(s.trim());
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se = '00', tz = '+0000'] = m;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) / 1000;
  const sign = tz[0] === '-' ? -1 : 1;
  const off = sign * (parseInt(tz.slice(1, 3)) * 3600 + parseInt(tz.slice(3, 5)) * 60);
  return utc - off;
}

export interface EpgRow extends Programme { ch: string }

/**
 * Streams XMLTV and calls onRow for each programme in [from, to] whose channel passes `keep`.
 * Never holds the whole document in memory.
 */
export async function parseXmltv(
  body: AsyncIterable<Uint8Array>,
  onRow: (r: EpgRow) => void,
  opts: { from: number; to: number; keep?: (ch: string) => boolean },
): Promise<number> {
  const parser = sax.parser(true, { trim: false, normalize: false });
  let cur: EpgRow | null = null;
  let field: 'title' | 'desc' | null = null;
  let text = '';
  let count = 0;
  parser.onopentag = (node) => {
    if (node.name === 'programme') {
      const a = node.attributes as Record<string, string>;
      const ch = a.channel;
      const start = parseXmltvTime(a.start ?? '');
      const stop = parseXmltvTime(a.stop ?? '');
      cur = ch && start < opts.to && stop > opts.from && (!opts.keep || opts.keep(ch))
        ? { ch, start, stop, title: '', desc: undefined } : null;
    } else if (cur && (node.name === 'title' || node.name === 'desc')) {
      field = node.name; text = '';
    }
  };
  parser.ontext = parser.oncdata = (t) => { if (field) text += t; };
  parser.onclosetag = (name) => {
    if (field && name === field && cur) {
      if (field === 'title' && !cur.title) cur.title = text.trim();
      else if (field === 'desc' && !cur.desc) cur.desc = text.trim() || undefined;
      field = null;
    } else if (name === 'programme' && cur) {
      if (cur.title) { onRow(cur); count++; }
      cur = null;
    }
  };
  let err: Error | null = null;
  parser.onerror = (e) => { err = e; parser.resume(); };
  const dec = new TextDecoder();
  for await (const chunk of body) parser.write(dec.decode(chunk, { stream: true }));
  parser.close();
  if (count === 0 && err) throw err;
  return count;
}
