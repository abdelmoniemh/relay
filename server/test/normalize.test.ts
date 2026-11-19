import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelKey, implausibleKickoff, matchKey, parseMatch, regionOf, sportOf, teamKey, zonedToUnix } from '../src/normalize.ts';

test('regions', () => {
  assert.equal(regionOf('UK| SPORT ᴴᴰ'), 'UK');
  assert.equal(regionOf('AR| BEIN SPORTS ⁸ᴷ & ᴴᴰ ⚽'), 'AR');
  assert.equal(regionOf('4K| ᵁᴴᴰ ³⁸⁴⁰ᴾ'), '4K');
  assert.equal(regionOf('##### HEADER #####'), null);
});

test('duplicate channels collapse to one key', () => {
  const k = channelKey('UK: SKY SPORTS MAIN EVENTS ᴴᴰ ◉');
  assert.equal(k, 'SKY SPORT MAIN EVENT');
  assert.equal(channelKey('VIP: SKY SPORTS MAIN EVENT ⁴ᵏ & ³⁸⁴⁰ᴾ'), k);
  assert.equal(channelKey('NOW: SKY SPORTS MAIN EVENT ᴿᴬᵂ'), k);
  assert.equal(channelKey('UK: SKY SPORTS MAIN EVENTS ᵁᴴᴰ ³⁸⁴⁰ᴾ'), k);
  assert.equal(channelKey('UK: BEIN SP⚽RTS 1 ENGLISH ᴿᴬᵂ'), 'BEIN SPORT 1 ENGLISH');
  assert.equal(channelKey('UK: TNT SPORTS BOX OFFICE HEVC'), channelKey('UK: TNT SPORTS BOX OFFICE 4K'));
  assert.notEqual(channelKey('UK: TNT SPORTS 1 ᴴᴰ ◉'), channelKey('UK: TNT SPORTS 2 ᴴᴰ ◉'));
});

test('parse EPG and event-channel match titles', () => {
  const v = parseMatch('Valencia vs Real Madrid - Spanish LaLiga 2026/2027 - Week 12')!;
  assert.deepEqual([v.home, v.away, v.competition, v.live, v.replay, v.time], ['Valencia', 'Real Madrid', 'Spanish LaLiga - Week 12', false, false, null]);
  const efl = parseMatch('EFL 26/27:Bristol City v Sheff Utd')!;
  assert.equal(efl.home, 'Bristol City'); assert.equal(efl.away, 'Sheff Utd'); assert.equal(efl.competition, 'EFL 26/27');
  const ev = parseMatch('Live Football 04 : Portugal vs Denmark 19:45 pm')!;
  assert.deepEqual([ev.home, ev.away, ev.time, ev.competition], ['Portugal', 'Denmark', '19:45', null]);
  const ev2 = parseMatch('Live Football 01 : Kosovo v Israel 14:00 pm')!;
  assert.equal(ev2.time, '14:00');
  assert.equal(parseMatch('Live WBBL Hobart.H v Perth.S')!.live, true);
  assert.equal(parseMatch('Van Gerwen v Van Barneveld 2016')!.replay, true);
  assert.equal(parseMatch('Premier League Highlights: Arsenal v Chelsea')!.replay, true);
  assert.equal(parseMatch('UK: SKY SPORTS MAIN EVENT'), null);
});

test('team identity', () => {
  assert.equal(teamKey('Sheff Utd'), teamKey('Sheffield United'));
  assert.equal(teamKey('Man City'), teamKey('Manchester City FC'));
  assert.equal(teamKey('Côte d\'Ivoire'), teamKey('Cote dIvoire'));
  assert.equal(matchKey({ home: 'Chelsea', away: 'PSG' }), matchKey({ home: 'PSG', away: 'Chelsea FC' }));
  assert.notEqual(teamKey('Chelsea Women'), teamKey('Chelsea'));
});

test('sport detection', () => {
  assert.equal(sportOf('Spanish LaLiga 2026/2027'), 'football');
  assert.equal(sportOf('NBA Season - 2026'), 'basketball');
  assert.equal(sportOf('WBBL'), 'cricket');
  assert.equal(sportOf(null, 'UK| LIVE FOOTBALL PPV'), 'football');
  assert.equal(sportOf('Darts Gold'), 'darts');
  assert.equal(sportOf('Raphael - Daikin StarLigue'), 'other');
  assert.equal(sportOf('Nations Cup Round 6'), 'rugby');
  assert.equal(sportOf('Africa Cup of Nations ( AFCON ) Qualification'), 'football');
});

test('event-channel formats with dates, times and service prefixes', () => {
  const stan = parseMatch('AU (STAN 96) | Arsenal v Manchester City  Premier League Matchweek 12 2026/2027 (2026-11-30 03:20:50)')!;
  assert.deepEqual([stan.home, stan.away, stan.competition], ['Arsenal', 'Manchester City', 'Premier League Matchweek 12']);
  assert.deepEqual(stan.when, { year: 2026, month: 11, day: 30, hour: 3, minute: 20 });
  const flo = parseMatch("flohoops: 2026 Hiram College vs Case Western Reserve - Men's (Hiram vs CWRU) (2026-11-18 19:00:00)")!;
  assert.deepEqual([flo.home, flo.away], ['Hiram College', 'Case Western Reserve']);
  assert.equal(sportOf(flo.competition, "flohoops: 2026 Hiram"), 'basketball');
  const nba = parseMatch('Denver Nuggets vs Boston Celtics @ Nov 18 9:30 PM :NBA  10')!;
  assert.deepEqual([nba.home, nba.away, nba.competition, nba.time], ['Denver Nuggets', 'Boston Celtics', 'NBA', '21:30']);
  const cup = parseMatch('Scottish Cup 5: Spartans vs Ross County 15.00')!;
  assert.deepEqual([cup.home, cup.away, cup.competition, cup.time], ['Spartans', 'Ross County', 'Scottish Cup 5', '15:00']);
  const old = parseMatch('Flo (FLSP) 261: 2025 Carnegie Mellon vs NYU - Mens - 24/10 12:30')!;
  assert.deepEqual([old.home, old.away, old.when?.day, old.when?.month], ['Carnegie Mellon', 'NYU', 24, 10]);
  const ko = parseMatch('Cruzeiro v Palmeiras (Kick-off 11')!;
  assert.deepEqual([ko.home, ko.away], ['Cruzeiro', 'Palmeiras']);
  assert.equal(sportOf('Nations Championship Round 6'), 'rugby');
  const nl = parseMatch('National League 1 | Gateshead vs Barrow // UK Sat 14 Nov 3:00pm // ET Sat 14 Nov 10:00am')!;
  assert.deepEqual([nl.home, nl.away, nl.competition], ['Gateshead', 'Barrow', 'National League 1']);
  assert.deepEqual(nl.when, { day: 14, month: 11, hour: 15, minute: 0, tz: 'Europe/London' });
});

test('time zones and replay plausibility', () => {
  const now = Date.UTC(2026, 10, 18, 23, 0) / 1000;
  // 03:20 Sydney (AEDT, UTC+11) on Nov 30 = 16:20 UTC Nov 29
  assert.equal(zonedToUnix({ year: 2026, month: 11, day: 30, hour: 3, minute: 20 }, 'Australia/Sydney', now), Date.UTC(2026, 10, 29, 16, 20) / 1000);
  // 19:45 London in November = 19:45 UTC
  assert.equal(zonedToUnix({ hour: 19, minute: 45 }, 'Europe/London', Date.UTC(2026, 10, 18, 12) / 1000), Date.UTC(2026, 10, 18, 19, 45) / 1000);
  assert.equal(implausibleKickoff('UEFA Nations League - MD6', 'Spain vs England', Date.UTC(2026, 10, 19, 0, 0) / 1000), true);
  assert.equal(implausibleKickoff('UEFA Nations League - MD6', 'Spain vs England', Date.UTC(2026, 10, 18, 19, 45) / 1000), false);
  assert.equal(implausibleKickoff('NBA Season', 'Milwaukee vs Miami', Date.UTC(2026, 10, 19, 3, 0) / 1000), false);
});
