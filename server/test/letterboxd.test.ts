import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiary, parseWatchlistPage } from '../src/letterboxd.ts';

test('watchlist page items', () => {
  const html = `<li><div data-item-slug="black-bag-2025" data-item-link="/film/black-bag-2025/" data-item-full-display-name="Black Bag (2025)" data-x="1"></div></li>
    <li><div data-item-slug="amelie" data-item-link="/film/amelie/" data-item-full-display-name="Am&#039;elie &amp; Co (2001)"></div></li>
    <li><div data-item-slug="untitled" data-item-full-display-name="Untitled Project"></div></li>`;
  assert.deepEqual(parseWatchlistPage(html), [
    { slug: 'black-bag-2025', name: 'Black Bag', year: 2025 },
    { slug: 'amelie', name: "Am'elie & Co", year: 2001 },
    { slug: 'untitled', name: 'Untitled Project', year: null },
  ]);
});

test('diary rss entries', () => {
  const xml = `<rss><channel><item><title>Heat, 1995 - ★★★★½</title><letterboxd:watchedDate>2026-11-01</letterboxd:watchedDate>
    <letterboxd:filmTitle>Heat</letterboxd:filmTitle><letterboxd:memberRating>4.5</letterboxd:memberRating><tmdb:movieId>949</tmdb:movieId></item>
    <item><title>A list</title></item>
    <item><letterboxd:filmTitle>Alien</letterboxd:filmTitle><tmdb:movieId>348</tmdb:movieId></item></channel></rss>`;
  assert.deepEqual(parseDiary(xml), [
    { tmdb: 949, rating: 4.5, date: '2026-11-01', name: 'Heat' },
    { tmdb: 348, rating: null, date: null, name: 'Alien' },
  ]);
});
