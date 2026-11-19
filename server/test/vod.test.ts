import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, cleanTitle, titleKey } from '../src/vod.ts';

const pick = (v: ReturnType<typeof classify>) => [v.lang, v.name, v.year, v.uhd, v.hdr, v.dv, v.src];

test('english copies, streaming sources and quality tags', () => {
  assert.deepEqual(pick(classify('EN - The Fix  (2026)', 'EN - NEW RELEASE')), ['en', 'The Fix', 2026, false, false, false, null]);
  assert.deepEqual(pick(classify('4K-NF - Okja  (2017)', 'NETFLIX MOVIES ⁴ᴷ ³⁸⁴⁰ᴾ')), ['en', 'Okja', 2017, true, false, false, 'NF']);
  assert.deepEqual(pick(classify('4K-EN - The Godfather  (1972)', 'EN - MOVIES ⁴ᴷ ³⁸⁴⁰ᴾ')), ['en', 'The Godfather', 1972, true, false, false, null]);
  assert.deepEqual(pick(classify('NF -The Devil\'s Plan (2023) (KR)', '')), ['en', "The Devil's Plan", 2023, false, false, false, 'NF']);
  const top = classify('EN-TOP - 02. The Godfather (1972)', 'EN - IMDB TOP 250');
  assert.deepEqual([top.lang, top.name, top.top250, top.src], ['en', 'The Godfather', 2, 'TOP']);
  assert.equal(classify('4K-DE-DV - MobLand (2025) (GB)', 'GERMANY DV ⁴ᴷ ᴴᴰᴿ').lang, 'other');
  assert.equal(classify('4K-DE-DV - MobLand (2025) (GB)', 'GERMANY DV ⁴ᴷ ᴴᴰᴿ').dv, true);
});

test('arabic audio vs arabic subtitles', () => {
  assert.equal(classify('AR - أحمد زكي :  ناصر 56', 'أفلام عربية قديمه').lang, 'ar');
  assert.equal(classify('AR-EG - الكلام على ايه؟!', 'أفلام مصرية').lang, 'ar');
  assert.equal(classify('AR-DUB - Apocalypse Z', 'أفلام مدبلجة للعربية').lang, 'ar');
  assert.equal(classify('AR-SUBS - Love in 39 Degrees (2024)', 'أفلام أجنبية قديمه').lang, 'ar-sub');
  assert.equal(classify('AR-DE - Animals (2026)', 'أفلام ألمانيه 2024').lang, 'ar-sub');
  assert.equal(classify('4K-AR - صقر وكناريا', 'أفلام عربية فائقة الوضوح').lang, 'ar');
  assert.equal(classify('4K-AR - Gladiator II (2024)', 'أفلام أجنبيه فائقة الوضوح').lang, 'ar-sub');
  assert.equal(classify('SH - (قــــــريباً ) عروق الملح', 'مسلسلات شاهد الأصلية').lang, 'ar');
});

test('other languages and oddities', () => {
  assert.equal(classify('DE - Der Pate (1972)', '').lang, 'other');
  assert.equal(classify('IN-EN - The Beekeeper (2024)', 'IN - EN HINDI').lang, 'other');
  assert.equal(classify('SOC - Zalgiris Kaunas vs Partizan', 'SOCCER FOOTBALL').lang, 'other');
  assert.deepEqual(cleanTitle('MobLand (2025) (GB)'), { name: 'MobLand', year: 2025, rank: null });
  assert.equal(titleKey('movie', 238, 'x', null), 'movie:t238');
  assert.equal(titleKey('movie', null, 'Spider-Man: No Way Home', 2021), titleKey('movie', null, 'spider man  no way home', 2021));
});
