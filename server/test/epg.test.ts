import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXmltv, parseXmltvTime } from '../src/epg.ts';

test('xmltv time with offsets', () => {
  assert.equal(parseXmltvTime('20261118120000 +0000'), Date.UTC(2026, 10, 18, 12) / 1000);
  assert.equal(parseXmltvTime('20261118130000 +0100'), Date.UTC(2026, 10, 18, 12) / 1000);
});

test('streams programmes, filters by window and channel, splits across chunks', async () => {
  const xml = `<?xml version="1.0"?><tv><channel id="a"/>
    <programme start="20261118120000 +0000" stop="20261118130000 +0000" channel="a"><title>News &amp; Weather</title><desc>Daily</desc></programme>
    <programme start="20261118120000 +0000" stop="20261118130000 +0000" channel="b"><title>Skip</title></programme>
    <programme start="20201118120000 +0000" stop="20201118130000 +0000" channel="a"><title>Old</title></programme></tv>`;
  const bytes = new TextEncoder().encode(xml);
  async function* chunks() { for (let i = 0; i < bytes.length; i += 7) yield bytes.slice(i, i + 7); }
  const rows: any[] = [];
  const from = Date.UTC(2026, 10, 18) / 1000;
  await parseXmltv(chunks(), (r) => rows.push(r), { from, to: from + 86400, keep: (c) => c === 'a' });
  assert.deepEqual(rows, [{ ch: 'a', start: from + 12 * 3600, stop: from + 13 * 3600, title: 'News & Weather', desc: 'Daily' }]);
});
