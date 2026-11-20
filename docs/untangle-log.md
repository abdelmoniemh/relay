# Untangle log

Decision log for the whole-codebase refactor (2026-11-20). Additions chosen: **Comments**, **Tests**.
Phase 2 lists problems (no changes); phase 3 groups them under fixes; phase 4 applies them.

## Redesign (fixes, each above the problems it solves; applied in this order)

1. **`shared/` holds what both sides know**: ids (`l/m/s/e/t` + parse), display-name cleaning, language codes,
   watched/resume thresholds, the stream request contract (paths + query fields), and the API response types.
   Solves: name regex copies (client 4x, server, Logo), language tables 5x, id scheme re-implemented ~12x,
   `t<tid>` undocumented, thresholds 5x, URL/query format built in one place and parsed in another, web
   hand-copied response types, `Sort`/`Sport`/vodLang duplicates, SW name regex (server sends display names).
2. **A `Provider` object owns everything about the provider**: base/credentials, User-Agent, every URL format
   (live, movie, episode, timeshift, player_api), its timezone (instance state, not a module global).
   Solves: UA 7x (one drifted), prober's inline live URL, `providerTz` global + call order, `streamUrls(Item)` faked items.
3. **One `ProviderSlot` arbitrates the single provider connection**: foreground users (conversions, probes before
   playback, a device's direct stream via the hub lease) take it; background workers (prober, prefetcher) run
   only when told it's free and are stopped through it. Solves: idle rule copied 3x with mutual `busy` refs and
   forward refs, `transcoder.owner` read by others, "call stop() before probe/keyframe", prefetcher never aborted
   by handlers, un-awaited abort, the 400ms sleep only after probes, polling for idleness.
4. **An HLS session describes itself**: one `HlsLayout` names every file (entry playlist, variants, segments,
   subtitles) and the server returns the session's own URLs (incl. its delete URL). Solves: names re-matched in
   6 places, the client's DELETE missing `master.m3u8` (bug), prune list vs var_stream_map, `VodLayout` living in
   the process module while api builds it, subs.ts importing transcode.ts.
5. **One ffmpeg argument builder** (media.ts) for both outputs: input options, video plan (copy / encode with
   filters + profile), audio; transcode.ts only runs processes. Option objects instead of 9 positional params.
   Solves: two `hlsVideoPlan`s, duplicated fragments (aresample, reconnect, fflags, hwaccel, burst 45/30), HLS
   encode path's own x264 args and fps 24, `maxHeight` meaning "mobile" implicitly, `low` as {info} vs boolean,
   `Transcoder.args` wrapper, unused TxOpts fields.
6. **One media facts store per title**: what we know about a file's video codec / tracks / chapters lives in
   `MediaInfo` (TrackStore grown up); "browsers need help" is derived from facts, never from which route was hit.
   Solves: codec knowledge in 4 stores, `hls_vcodecs` local map, HevcRegistry poisoned by interlaced/data-saver
   requests (bug), `hevc` + `tx` repeating one fact, two header reads of the same file.
7. **Routes live with their feature** (streams, catalog, library, reminders, devices) and each feature owns its
   tables; registerApi only mounts them. Shared `resolveSource(id, query)` for the stream routes.
   Solves: api.ts god module (547 lines, 21 imports, 18-field ctx), duplicated stream-route preambles and catch-up
   try/catch, raw SQL on other modules' tables (favorites, progress, title-of, TMDB pending), series feature in a
   handler, `/api/stream` and `/api/capabilities` dead routes, auth prefix list.
8. **Catalog state has one owner**: one `refreshCatalog()` used by both manual and scheduled sync (same version,
   same invalidations), regions owned by Catalog (events use its SQL), kv keys behind a typed accessor.
   Solves: manual vs scheduled sync drift (bug), version built 2 ways, empty-regions meaning 2 things (bug),
   region SQL 3x, registerApi side effect loading regions, bare kv keys across files, runSync ignoring kinds.
   Plus the upsert that clobbers TMDB data (bug) by making the sync write only provider-owned columns.
9. **Web: playback split by concern**: `session` (lease/WS/failover), `prefs` (one storage module for every
   persisted setting), `media-session`, `catalogue actions` (open/play an item, one routine); players build their
   own stream URLs from the shared contract via a `streams` client; players emit typed error codes and support
   many listeners. Solves: playback.ts god module, loadOpts knowing both players, localStorage in 4 modules,
   friendlyError matching texts, single-callback `on`, four open/play routines, LoadOpts mutated as language store.
10. **Web: stable UI depends on nothing volatile**: kit.tsx without playback/ws (MiniPlayer → player/), preview box
    in a neutral module, formatting helpers (time, date, device name/icon) in one place, typed icon names.
11. **Remove surplus and the special cases the above makes unnecessary**; keep the ones that encode real
    provider/platform facts (documented where they live).

## Evidence

- Change frequency (git): server/src/api.ts 17, web/src/playback.ts 15, web/src/player/html5.ts 11,
  server/src/transcode.ts 10, server/src/main.ts 10, web/src/api.ts 9.
- Import graph: api.ts imports 21 modules; ui/kit.tsx (design system) imports playback.ts and ws.ts;
  screens/Live.tsx imports player/host.tsx.

## Problems (cross-cutting, found before the area surveys)

- `web/src/ui/common.tsx:41`, `web/src/playback.ts:394`, `web/src/playback.ts:423`, `web/public/sw.js:16`: the same
  channel-name prefix regex, four copies.
- `server/src/tracks.ts` and `web/src/player/lang.ts`: the same language alias table.
- `server/src/xtream.ts:4`, `media.ts:82`, `vodproxy.ts:15`, `tracks.ts:59`, `tracks.ts:145`, `transcode.ts:112`,
  `prober.ts:135`: the provider User-Agent string, seven copies.
- `server/src/api.ts:217` and `server/src/transcode.ts:22`: two `hlsVideoPlan` functions with different return values.

## Problems: server catalog side (survey)

Bugs found along the way:
- `sync-worker.ts:127-128` titles upsert overwrites TMDB rating/poster (written by `tmdb.ts:123-124`); `meta_at` then blocks re-enrich for 30 days.
- `sync-worker.ts:130` + `library.ts:262-265` while `meta_at IS NULL` each sync nulls the provider-info fallback (plot/genres/cast/director).
- `api.ts:37,82` vs `main.ts:122-127` manual sync refreshes version+events only; scheduled sync invalidates library/tmdb but builds `catalog.version` in another format.
- `catalog.ts:44` vs `events.ts:54` empty regions = everything vs nothing.

Hidden links:
- `sync.ts:10` runSync returns any in-flight run regardless of requested kinds.
- `api.ts:39` `catalog.regions` loaded from kv (default list) as a side effect of registerApi; `main.ts:69` depends on it.
- kv keys `catalog_synced`/`live_synced`/`epg_synced` written by worker, read as bare strings in `sync.ts:33-35`, `api.ts:37,74,78`; `tmdb_key` written in api.ts:93, read in main.ts:55.
- Region sanitise regex + `IN (...)` built 3x (`catalog.ts:45`, `events.ts:54`, `api.ts:97`); regions folded into version and again into the events cache key (`events.ts:152`).
- Category-prefix regex `^\s*[A-Z0-9]{2,5}\s*[|:]` 4x (`normalize.ts:5,15-16`, `quality.ts:35`, `events.ts:164`).
- Quality-tag lists 5x, disagreeing (`normalize.ts:9`, `events.ts:164`, `quality.ts:36`, `vod.ts:20,77`, `api.ts:300`).
- Provider source codes (NF/AMZ/TOP/PRMT) 3x (`vod.ts:17`, `library.ts:231,240`).
- Two label→timezone tables (`normalize.ts:89`, `events.ts:33-42`).
- LANG_BIT table 2x (`sync-worker.ts:93`, `library.ts:8`), `library.ts:166` hard-codes `lmask & 2`; `sync-worker.ts:119` uhd only for en/ar = tied to default langs.
- Genre `,a,b,` encoding + split 3x (`sync-worker.ts:140`, `library.ts:261`, `tmdb.ts:117`), Sci-Fi mapping in 2 → GENRE_ROWS lists both; `LIKE '%,x,%'` repeated (`library.ts:168,176,184`).
- Item id prefix scheme (`catalog.ts:4-8`) re-implemented: `library.ts:127,219,242`, `sync-worker.ts:154-155`, `main.ts:72,96`, `events.ts:156`, `quality.ts:46`, `api.ts:407,412,464`; "no family → -sid" 2x (`catalog.ts:115`, `events.ts:62,141`).
- Watched/started thresholds (95%, 30s) in `main.ts:85`, `library.ts:119`, `api.ts:515`, web Detail/Title; `/api/continue` re-implements `Library.continueRow`.
- FTS tokenising 2x (`catalog.ts:82-84`, `library.ts:207-209`).
- Two `get_vod_info` callers with different timeouts/mappings/caches (`api.ts:152`, `main.ts:57`).
- Events window ±36h depends on EPG retention (`events.ts:82` / `sync-worker.ts:196`); EPG channel ids case-sensitive in worker (`sync-worker.ts:188`), lowercased in events (`events.ts:71,84`).
- `events.ts:26,55` re-declares catalog Row/columns; `events.ts:12`, `quality.ts:10`, `normalize.ts:28` re-declare SportEvent/RankedSource/Sport; `sourceCount` patched on in `api.ts:397,403`; `web/src/api.ts:59-83` hand-copies Sort/TitleCard/LbStatus/VersionInfo/Status.
- `main.ts:57,60` `library.providerInfo` / `library.lb` injected after construction.
- `sync-worker.ts:73-75` worker rebuilds FTS tables owned by catalog/library.

Needless links:
- api.ts raw SQL on others' tables: TMDB pending count (`api.ts:77` vs `tmdb.ts:142`), `/api/title-of` (`api.ts:486`), favorites CRUD storing client body (`api.ts:501-508`), progress read (`api.ts:514-525`; writer `main.ts:40-42`, purge `sync-worker.ts:152`), whole series feature in a handler (`api.ts:165-196`).
- `api.ts:38` show_adult migration on every start in route registration.
- `events.ts:150` list(regions, version, probes, opts): every caller passes catalog's; `main.ts:69` passes fake probes + hevcOk; `events.ts:141,155` `as any` casts.
- `letterboxd.ts:53-57` creates own tables (others in db.ts; db.ts:70-80 holds prober tables); `letterboxd.ts:61-62` reads env directly.
- `library.ts:61-65` watchlist lookup ignores `lb_films.kind`, name match movies only.
- `api.ts:390,470` hevc param parsed 2x; `api.ts:477` hand-rolled clamp; `catalog.ts:43` regionSql public but internal.

Surplus:
- `tmdb.ts:169` tmdbImg unused; `tmdb.ts:75` top_rated/on_the_air/pages unused; `tmdb.ts:37,61` get/cached public; `tmdb.ts:41,53` verify duplicates get's auth.
- adult column always 0 → dead filters (`sync-worker.ts:56,60-62`, `catalog.ts:41`, `events.ts:57`, `db.ts:30` index).
- `sync-worker.ts:49,53` category id computed twice; `sync-worker.ts:177-180` keys array of one.
- `devices.last_seen` never read (`db.ts:44`, `auth.ts:36`); `lb_films.kind`/`lb_watched.name` never read; `letterboxd.ts:93-94` date unused.
- `library.ts:8,11,20-25` exports LANG_BITS/TitleCard/Row/VersionInfo/Device unused; `epg.ts:15`, `normalize.ts:67,69` needless exports.
- `/api/capabilities` (`api.ts:497`) no client; status fields probing/probeQueue/liveSynced unread.
- `api.ts:88` redundant invalidate; `config.ts:33-34` refresh hours as config + `sync.ts:34` magic 0.5h.

Special cases:
- Swallowed: `library.ts:156` safe(), `library.ts:253,268`, `sync-worker.ts:122`, `sync-worker.ts:33`, `letterboxd.ts:158,163`, `main.ts:48`, `epg.ts:55,59`, `sync.ts:37` (retries every 5 min).
- Races: `library.ts:259,274` Promise.race timeouts leave requests running.
- `tmdb.ts:47` unbounded 429 retry; `tmdb.ts:153` error detected by regex on message.
- `main.ts:93` 400ms sleep for provider slot release.
- `sync-worker.ts:152-157` purgeLibrary inside each kind's import: one truncated response deletes favorites/progress.
- `events.ts:35` redundant EPL/UEFA test; `events.ts:29` football duration for all sports.
- `catalog.ts:70-79` neighbor ignores regions; `catalog.ts:108,127` regionList/counts skip filters.
- `library.ts:166` Arabic row special case; `library.ts:62` byName movie-only.
- `api.ts:45` public routes as startsWith list (`/api/pair*`), `/ws` re-implements auth (`api.ts:536`).
- No tests for catalog, sync-worker, library, events, tmdb.

## Problems: server streaming side (survey)

Bugs found along the way:
- `web/src/player/html5.ts:300` DELETE only strips `/index.m3u8?`; movie sessions use `master.m3u8` → never deleted, connection held until the 45s idle timeout.
- `api.ts:255` `hevc.add(id, mode)` on every /api/transcode; the client also uses transcode for interlaced and data saver → those ids become "HEVC" for every device (`hub.ts:125`).
- `transcode.ts:307` log reads `opts.mode` but `low` forces 'full'.
- `main.ts:37` exit handler calls async stop(); HLS dirs only removed by next start's wipe.

Hidden links:
- HLS file names (`seg_%v_%05d.m4s`, `idx_%v.m3u8`, `sub_<n>.vtt`, `seg%05d.m4s`, `index.m3u8`, `master.m3u8`) built at `transcode.ts:137-156` and re-matched at `transcode.ts:168-169,201,229,234-238`, `api.ts:345,359,362,377`, `subs.ts:23,74`, `html5.ts:300`; prune list `transcode.ts:235` must match var_stream_map names `transcode.ts:131`.
- `hlsVideoPlan` 2x (`api.ts:217`, `transcode.ts:22`), different return values.
- Provider UA 7x; `prober.ts:189` drifted to 'Relay/1.0'.
- `TxMode` declared 2x (`media.ts:56`, `transcode.ts:51`) + inline `hub.ts:13`, `protocol.ts:80`.
- ffmpeg arg fragments duplicated between `transcode.ts` HLS and `media.ts` mpegts: aresample (3x), reconnect, fflags, CUDA hwaccel, readrate burst 45 vs 30; HLS encode path hard-codes x264 args and fps 24 instead of media.ts filters; 4s segment length in 5 places (`transcode.ts:19,106,135,151`, `subs.ts:15`).
- `media.ts:162,176` maxHeight silently means MOBILE profile + 128k audio.
- `/api/transcode` and `/api/hls` copy the validation preamble, live-source pick, catch-up try/catch, proxy wrapping (`api.ts:251-260` vs `306-316`); `kind !== 'episode' && !catalog.playable` 3x (`api.ts:201,251,306`).
- Track suffix rule 2x (`api.ts:348`, `subs.ts:73`); prefetchable id regex 2x (`api.ts:426`, `prefetch.ts:53`); live URL built inline `prober.ts:129` vs `xtream.ts:54`.
- Two HDR vocabularies (`vod_probes` dv/hdr10/hlg/sdr vs `probes` pq/hlg), translated by hand `api.ts:211`; probe-row→SourceInfo split (`prober.ts:220` vs inline `api.ts:207-213`, guessing bitDepth/interlaced).
- Per-title codec knowledge in 4 stores (`hls_vcodecs` kv, `HevcRegistry`, `vod_probes.vcodec`, `TrackStore.vcodec`), plus two ffprobe header reads of the same movie (`tracks.ts:57`, `prober.ts:187`).
- Name-based quality guessing 4x (`api.ts:300`, `quality.ts:35`, `vod.ts:77`, `web playback.ts:180`).
- Call order callers must know: `transcoder.stop()` before probe/keyframe, `prober.abort()` before HLS; /api/transcode relies on hub leaseMoved; nobody aborts the prefetcher from handlers (`api.ts:221,269,317,331`).
- "Idle" rule copied in 3 places (`main.ts:66,77,88-94`) with mutual `busy` refs and mutable forward refs (`main.ts:63-64,105`); workers read `transcoder.owner` (a mutable public field).
- `xtream.ts:24` providerTz module-global set by main; two catch-up paths, only `?cs/ce` validated (`xtream.ts:51` vs `api.ts:229-236`).
- HLS URL token comes from `q.token` (`api.ts:343`): works only because auth also accepts ?token=.
- `hub.ts:156` leaseMoved not awaited / outside exclusive(); `hub.ts:12-15` optional deps production must always wire.
- Module env reads outside config (`transcode.ts:18` XDG_CACHE_HOME, `prober.ts:228` DATA_DIR, `vodproxy.ts:24`, `prober.ts:158`).
- `shared/protocol.ts:1` mentions ios/Relay/Protocol.swift; ios/ is empty.

Needless links:
- `startHls` 9 positional params, order differs from `start` (`transcode.ts:167,284`); `hlsArgs` 9 params; data saver is `{info}` in one, boolean in the other.
- `subs.ts:5` pure playlist module imports from process-managing transcode.ts; `VodLayout`/`vodLayout`/MAX_* live in transcode.ts but api.ts builds the layout.
- `streamUrls` takes a full Item, callers fake `name: ''` (`api.ts:202,226,256,312`).
- `registerApi` 18-field ctx mixing everything (`api.ts:35`).
- `prober.ts:30,64` public mutable `active`, pass-through `pending()` only for /api/status.
- `HevcRegistry` also stores audio-only mode; `hevc` + `tx` in granted repeat one fact (`hub.ts:125`, `protocol.ts:80`).

Surplus:
- `Transcoder.args()` wrapper; `GET /api/stream/:id` no caller; `HevcRegistry.has()` unused; `VodLayout.defAudio` unread; `hlsInfo().dir` test-only.
- TxOpts `userAgent`/`output` never set; `profile`/`bench`/`dither`/`deintFrame`/`LEGACY` bench-only.
- `abr` defaults never used, unused `n`; `live ? 0 : startAt` redundant; `this.owner` set twice; double `transcoder.stop()`; unused `timeoutMs` params.
- Needless exports: `probeVodUrl`/`VodProbeResult`, `Cue`.
- Legacy compat: old hevc_ids format, old tmp relay-hls cleanup, chapterless track entries.
- `reminders.ts:32` timer unused; test-only surface `hub.getLease`, `Prefetcher.idle`/`paceMs`, `VodProxy.stats`.

Special cases:
- Provider-slot retries/sleeps: `transcode.ts:174,292` retry loops (GPU fallback duplicated), `transcode.ts:215` 300ms, `transcode.ts:268` 1000ms stop timeout, `main.ts:93` 400ms after probe only, `hub.ts:96` 2500ms ack.
- `main.ts:90` prefetcher.abort() not awaited; prober/prefetcher poll for idleness (1.5s/20s) instead of being told.
- `prober.ts:133,161,166` magic timeouts + error-text matching; `prober.ts:243` spawn error → "no video"; `prober.ts:234` catch {}.
- `vodproxy.ts:121` catch {} hides provider failures; `vodproxy.ts:132` swallows abort and refetches; `prefetch.ts:77` probe failure dropped silently; `main.ts:48` tz failure hidden; `api.ts:448` any error = "bad subscription"; `reminders.ts:80` pushAll catch.
- `transcode.ts:194` `!low` in codec detection; `api.ts:298` avi/flv; `api.ts:315-316` live guess 'hevc'; `hub.ts:116,123` catchup/live special cases in lease logic; `prober.ts:87` empty IN() patch; `hub.ts:125` txMode twice.
- ffmpeg-dependent tests skip silently when ffmpeg is missing.

## Problems: web client (survey)

Bugs found along the way:
- `html5.ts:300` (same as above) HLS DELETE misses `master.m3u8`.
- `host.tsx:26` Tizen without webapis falls back to Html5Player, but the Tizen build stubs hls.js/mpegts.js (`vite.config.ts:27`) → `mpegts.isSupported()` throws.
- `ws.ts:40` close 4001 (unpaired) clears token in memory only; localStorage keeps it, reload restores it.
- `playback.ts:346` a `granted` before `attachPlayer` is dropped (lease held, nothing plays).
- `ws.ts:33` unguarded JSON.parse; `ws.ts:20` stale queued `play` replayed on reconnect.
- `notify.reminders` not refreshed when a `reminder` WS message arrives.

Hidden links:
- Name-prefix regex 4x client (`common.tsx:41`, `playback.ts:394,423`, `sw.js:16`), different `{2,5}` on server, a third in `Logo` (`common.tsx:9`).
- Language tables 5x (`player/lang.ts:2`, `server tracks.ts:92`, `Title.tsx:16`, `Settings.tsx:31`, `Browse.tsx:121`).
- Stream URL/query format built in `playback.ts:176-186`, appended to by players (`html5.ts:226,235-236`, `avplay.ts:31`), parsed in `server api.ts:229-345`; thumbs URL `.jpg` (`playback.ts:48` / `api.ts:419`).
- `friendlyError` (`playback.ts:159-170`) regex-matches literal error texts produced in `html5.ts:134,240,260,352` and `server api.ts:234,271,349`.
- Push cache name/key in page and SW (`notify.ts:48`, `sw.js:6`); SW depends on untyped `/api/push/due` shape.
- Response types client-side (`web api.ts:55-84`), `Sort` dup of `catalog.ts:21`, vodLang codes dup of `vod.ts:3`, `Sport` dup + `Sports.tsx:16` LABEL list.
- Client-invented `t<tid>` id scheme (`Home.tsx:22`, `Search.tsx:19,33`, `Remote.tsx:118`, `Title.tsx:80-81`), not in protocol.
- Watched/resume thresholds repeated (`Detail.tsx:24,77,82,131`, `Title.tsx:41-42,59,77,217`).
- Rating scale inconsistent: `rating*2` in Browse/Home/Title/Search vs raw in Vod/Detail.
- "Play movie version with duration runtime*60" 4x (`Home.tsx:54`, `Browse.tsx:52`, `Title.tsx:72`, `Remote.tsx:122`); four "open/play an item" routines (`Home.tsx:21-25`, `Vod.tsx:50-54`, `Search.tsx:18-24`, `Remote.tsx:117-126`).
- Episode-name regex 2x (`Detail.tsx:130`, `Title.tsx:226`); Letterboxd stars 2x; time/date formatting re-implemented (`Home.tsx:18`, `Remote.tsx:109`, `Sports.tsx:25-34`, `programmes.tsx:15`, `Settings.tsx:86`); device-name lookup 4x; device icon map 3x.
- Two HEVC capability probes with different codec strings (`web api.ts:49-50` vs `html5.ts:8`); `isTizen` re-implemented (`web api.ts:10,49,126`); deviceKind re-derived (`App.tsx:96`, `main.tsx:9`); phone breakpoint copied (`router.ts:23`, `host.tsx:124`, CSS).
- localStorage keys/wrappers in 4 modules (`api.ts:4-8`, `playback.ts:73-93`, `i18n.ts:6-18`, `html5.ts:5-9`).
- `types.ts:52,60` single-callback `on`/`onLangs`; `playback.ts:380-386` RemoteCmd→Key `as` cast.
- Channel number = index in category; digit entry re-fetches category (`Live.tsx:105`, `host.tsx:230-240`), wrong for fav/recent.
- "36 hours" copy mirrors server window (`Home.tsx:162`, `Sports.tsx:131`); UHD-from-name regex `playback.ts:180`.
- Reminders split over notify.ts, `programmes.tsx:26`, `Sports.tsx:168`, `playback.ts:392`, sw.js.
- Dead `' · unverified'` strip (`kit.tsx:125`, `host.tsx:328`); `html5.ts:292,296` mutates LoadOpts as language store; `host.tsx:59` own toast timer.

Needless links:
- `kit.tsx:8,10` design kit imports ws.ts + playback.ts for MiniPlayer; `programmes.tsx` does device/autoplay logic; `Live.tsx:12` imports from player/host.tsx; screens import from `Browse.tsx`; `Remote.tsx` embeds Search (`Search.tsx:26` params only for it).
- `playback.ts` god module (lease/WS, failover, episodes, extras, prefs, data saver, catch-up, zapping, remote dispatch, reminders, errors, visibility, Media Session, toast).
- `loadOpts` (`playback.ts:173-190`) knows both players' internals; `LoadOpts` is the union of two private APIs.
- `host.tsx` overlay + navigation + casting (`ws.send` bypassing playback) + digit zapping via api.
- Engines call `api.clientLog` directly; `usePaged` hard-typed to Item → casts; `notify.ts:30` re-implements isIOS; `Icon.tsx` names typed as string.

Surplus:
- `common.tsx:12,19` Poster/Star unused; `notify.ts:19` isReminded unused, `notificationsSupported` internal; `HttpError.status` unread; `api.ping/item/devices` unused; internal-only exports (MovieInfo, SeriesInfo, LbStatus, preconnect, friendlyError, showToast); `Browse.tsx:15` size prop unread; unused imports (Title, Sports), double isTizen import (Settings); redundant clearCache after api.settings; `Pair.tsx:21` redundant connect; `html5.ts:94-97` toLiveHls pass-through; playback one-line pass-throughs.

Special cases:
- Tizen checks across 14 files; iOS/native-HLS branches throughout html5.ts and host.tsx; isMobile layout branches.
- `host.tsx:143` 1920 scale; `host.tsx:138` TV auto-stop; optional per-platform Player methods → `?.` everywhere.
- Timers papering over ordering: `playback.ts:144` 1200ms retry, `playback.ts:128` 5s, `host.tsx:93` 300ms, `html5.ts:243` 4s langsSettled, `html5.ts:203` 3.5s audio check, watchdogs, `Settings.tsx:119,131` refresh(500/1500), `Title.tsx:30` 9s refetch, `Sports.tsx:77` polling.
- Swallowed exceptions: every AvPlay call, keys, App, host, many playback/notify/sw/api catches; `programmes.tsx:95` remind failure invisible.
- Data saver Tizen-disabled in 2 places; Tailscale regex; untranslated toasts (`playback.ts:201,202,279,371,377`, `host.tsx:59`, sw.js).
- `Live.tsx:39` setCi(2) magic; `Browse.tsx:65` magic -2/-1.
- No web tests at all.
