import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, markSynced } from '../src/db.ts';
import { Catalog } from '../src/catalog.ts';

test('regions: defaults, saved, change the version; empty means every region', () => {
  const db = openDb(':memory:');
  const c = new Catalog(db);
  assert.deepEqual(c.regions, ['UK', 'US', 'CA', 'AR', '4K']);
  const v0 = c.version;
  c.setRegions(['uk', 'n l', '']);
  assert.deepEqual(c.regions, ['UK', 'NL']);
  assert.notEqual(c.version, v0);
  assert.deepEqual(new Catalog(db).regions, ['UK', 'NL'], 'kept across restarts');
  assert.match(c.regionSql('live', 'i.'), /i\.region IN \('UK','NL'\)/);
  c.setRegions([]);
  assert.equal(c.regionSql('live', 'i.'), '', 'no filter: everything');
});

test('a sync changes the version clients cache against', () => {
  const db = openDb(':memory:');
  const c = new Catalog(db);
  const v0 = c.version;
  markSynced(db, 'epg');
  c.refresh();
  assert.notEqual(c.version, v0);
});
