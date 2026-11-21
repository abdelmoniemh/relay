import { parseId, isVodId, itemId } from '../../../shared/domain.ts';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pickAudio, pickSub, trackName, keyframeAt, type Tracks } from '../tracks.ts';
import { vodLayout, sessionFiles, parseSubName, subName, subtitlePlaylist, subtitleSegment, servePlaylist } from '../hls.ts';
import { videoPlan } from '../media.ts';
import type { FastifyInstance } from 'fastify';
import { readStreamQuery, type StreamQuery, type HlsStarted } from '../../../shared/streams.ts';
import { type ApiCtx } from './http.ts';

export function registerStreamsRoutes(app: FastifyInstance, ctx: ApiCtx) {
  const { catalog, provider, transcoder, facts, vodProxy, trackStore, prefetcher } = ctx;
  /** Seconds of picture kept before a seek point, so going back a little after a seek needs no restart. */
  const SEEK_PREROLL = 20;
  const tracksOf = async (id: string, src: string): Promise<Tracks | null> => {
    const known = trackStore.get(id);
    if (known) return known;
    try { return await transcoder.withConnection(() => trackStore.probe(id, src)); }
    catch (e) { app.log.warn(`tracks ${id}: ${(e as Error).message.split('\n')[0]}`); return null; }
  };
  /** A movie/episode's file through the proxy, for the background prefetcher. */
  const vodSrc = (id: string, ext?: string) => () => { const { kind } = parseId(id); return vodProxy.url(provider.source({ id, kind: kind ?? 'movie', ext })); };
  // Catch-up: a programme from a channel's archive (?cs=<start>&ce=<stop>, unix seconds; ?start= seconds into it).
  const catchupOf = (sid: number, q: StreamQuery) => {
    const { cs, ce } = q;
    if (!cs || !ce) return null;
    const days = catalog.get(itemId('live', sid))?.archive ?? 0;
    const now = Date.now() / 1000;
    if (!days || ce <= cs || cs > now || cs < now - days * 86400 - 600) throw new Error(days ? 'That programme is outside this channel\'s archive' : 'This channel has no catch-up');
    return provider.catchup(sid, { start: cs, stop: ce }, q.start ?? 0, now);
  };
  // For the TV, which plays the archive stream itself (whole minutes).
  app.get('/api/catchup/:id', async (req, reply) => {
    const id = String((req.params as any).id).replace(/\.ts$/, '');
    const { kind, sid } = parseId(id);
    if (kind !== 'live') return reply.code(400).send({ error: 'bad id' });
    try { const c = catchupOf(sid, readStreamQuery(req.query as Record<string, string>)); return c ? reply.redirect(c.url) : reply.code(400).send({ error: 'cs/ce required' }); }
    catch (e) { return reply.code(404).send({ error: (e as Error).message }); }
  });

  // HEVC -> H.264 stream for browsers without an HEVC decoder. Raw MPEG-TS, consumed by mpegts.js.
  /** A stream request, checked, and the source the server reads (catch-up from the archive, files via the proxy). */
  async function resolveSource(id: string, q: StreamQuery) {
    const { kind, sid } = parseId(id);
    if (!kind || kind === 'series') return { fail: [400, 'bad id'] as const };
    if (kind !== 'episode' && !catalog.playable({ id, kind })) return { fail: [404, 'not found'] as const };
    if (!transcoder.available) return { fail: [501, 'ffmpeg is not installed on the server'] as const };
    let catchup: ReturnType<typeof catchupOf> = null;
    try { catchup = kind === 'live' ? catchupOf(sid, q) : null; } catch (e) { return { fail: [404, (e as Error).message] as const }; }
    const live = kind === 'live' && !catchup; // a catch-up programme plays like a movie: from the start, seekable
    // Movies go through the local range proxy: seeks restart ffmpeg, and it makes them ~1 provider request.
    const src = catchup ? catchup.url : live ? provider.source({ id, kind }) : await vodProxy.url(provider.source({ id, kind, ext: q.ext }));
    return { kind, sid, live, catchup, src };
  }

  app.get('/api/transcode/:id', async (req, reply) => {
    const id = String((req.params as any).id).replace(/\.ts$/, '');
    const q = readStreamQuery(req.query as Record<string, string>);
    const r = await resolveSource(id, q);
    if (r.fail) return reply.code(r.fail[0]).send({ error: r.fail[1] });
    const { kind, live, catchup: cu, src } = r;
    const mode = q.mode === 'audio' ? 'audio' : 'full';
    if (q.failed) facts.learn(id, mode); // this browser couldn't play the original
    let started;
    // The player gave up on this request (seeked, switched, closed): don't keep starting ffmpeg for it.
    const ac = new AbortController();
    req.raw.socket?.once('close', () => ac.abort());
    // Movies: the preferred audio language when the file's track list is known (from an earlier play).
    const known = kind !== 'live' ? trackStore.get(id) : undefined;
    if (kind !== 'live') prefetcher.want(id, vodSrc(id, q.ext ?? undefined)); // markers & thumbnails, once it's idle
    const audio = known && q.alang ? pickAudio(known, q.alang) : undefined;
    try { started = await transcoder.start(src, cu ? 0 : q.start ?? 0, (m) => app.log.warn(m), req.deviceId, { vod: !live, mode, info: facts.source(id), signal: ac.signal, audio, skip: cu?.skip, low: q.q === 'low' }); }
    catch (e) {
      if ((e as Error).message === 'superseded') return reply.code(409).send({ error: 'superseded by a newer request' });
      return reply.code(502).send({ error: `Transcode failed: ${(e as Error).message}` });
    }
    const { proc, first } = started;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.write(first);
    proc.stdout.pipe(res);
    const end = () => { if (transcoder.owns(proc)) transcoder.stop(); else if (proc.exitCode === null) proc.kill('SIGKILL'); };
    res.on('close', end);
    req.raw.socket?.once('close', end);
    proc.on('exit', () => res.end());
  });

  // ---- HLS for iPhone/iPad Safari (movies, episodes, and HEVC channels) ----
  // Safari plays neither MKV/AVI, a raw MPEG-TS stream, nor HEVC inside the provider's TS-based HLS (Apple only
  // takes HEVC in fMP4), but plays fMP4 HLS natively: repackage (or convert) on the fly.
  // Video codec per title, learned from earlier plays/probes; decides copy (instant, lossless) vs conversion.
  app.post('/api/hls/:id', async (req, reply) => {
    const id = String((req.params as any).id);
    const q = readStreamQuery(req.query as Record<string, string>);
    const r = await resolveSource(id, q);
    if (r.fail) return reply.code(r.fail[0]).send({ error: r.fail[1] });
    const { kind, live, catchup: cu, src } = r;
    // Live: the iPhone only asks for channels that didn't play directly, which are almost always HEVC.
    const guess = cu ? (facts.source(id)?.vcodec ?? 'h264') : facts.videoCodec(id, q.ext);
    // Movies: every audio language (iOS lists them in its menu), subtitles, the preferred ones selected.
    const tracks = kind === 'live' ? null : await tracksOf(id, src);
    if (kind !== 'live') prefetcher.want(id, vodSrc(id, q.ext ?? undefined));
    const defAudio = tracks ? pickAudio(tracks, q.alang || null) : -1;
    const layout = tracks?.vcodec ? vodLayout(tracks, defAudio) : null;
    const defSub = tracks ? pickSub(tracks, q.slang || null, tracks.audio.find((a) => a.n === defAudio)?.lang ?? null) : -1;
    // Movies seeking: start at the keyframe ~20s before (exactly on it, so picture and subtitles share one clock),
    // and tell the player where that is; it jumps to the second asked for, and short rewinds are already there.
    // Data saver: always re-encoded (720p ~3 Mbps), which also makes seeks exact without the keyframe step.
    const low = q.q === 'low';
    const info = facts.source(id) ?? (tracks ? { vcodec: tracks.vcodec } : null);
    const want = !live && !cu ? Math.max(0, q.start ?? 0) : 0;
    let from = want;
    if (want > 0 && videoPlan(tracks?.vcodec ?? guess, low) === 'copy') {
      try { from = await transcoder.withConnection(() => keyframeAt(src, Math.max(0, want - SEEK_PREROLL))); } catch (e) { app.log.warn(`keyframe ${id} @${want}: ${(e as Error).message.split('\n')[0]}`); }
    }
    try {
      const r = await transcoder.startHls({ src, startAt: from > 0 ? from + 0.01 : 0, guess: tracks?.vcodec ?? guess, owner: req.deviceId, live, layout, skip: cu?.skip, low, info, log: (m) => app.log.warn(m) });
      // Really HEVC: every device now skips the failing direct attempt. (Not on a mere failure: the first try
      // often fails only because the provider still counts the previous connection.)
      if (live && r.vcodec === 'hevc') facts.learn(id, 'full');
      const tok = encodeURIComponent(String(q.token ?? ''));
      const started: HlsStarted = {
        url: `/api/hls/${r.sid}/${r.entry}?token=${tok}${layout && defSub >= 0 && layout.subs.includes(defSub) ? `&ds=${defSub}` : ''}`,
        /** DELETE this to end the session (frees the provider connection right away). */
        stop: `/api/hls/${r.sid}?token=${tok}`,
        // What's in the stream, for the player's own menus.
        audio: layout ? layout.audio.map((n) => { const a = tracks!.audio.find((x) => x.n === n)!; return { n, lang: a.lang, name: trackName(a) }; }) : [],
        subs: layout ? layout.subs.map((n) => { const t = tracks!.subs.find((x) => x.n === n)!; return { n, lang: t.lang, name: subName(t), forced: t.forced }; }) : [],
        defSub: layout && layout.subs.includes(defSub) ? defSub : -1,
        // Movie position at the stream's 0:00 (a keyframe at or before what was asked for).
        offset: from,
      };
      return started;
    } catch (e) {
      if ((e as Error).message === 'superseded') return reply.code(409).send({ error: 'superseded by a newer request' });
      return reply.code(502).send({ error: `Conversion failed: ${(e as Error).message}` });
    }
  });
  app.get('/api/hls/:sid/:file', async (req, reply) => {
    const { sid, file } = req.params as { sid: string; file: string };
    const tok = `?token=${encodeURIComponent(String((req.query as any).token ?? ''))}`;
    // Subtitle playlists and segments: built from the session's growing .vtt files, cut to the video's segments.
    const sub = parseSubName(file);
    if (sub) {
      const layout = transcoder.hlsInfo(sid)?.layout;
      const files = sessionFiles(layout ?? null);
      const vpl = transcoder.hlsFile(sid, files.video);
      if (!layout || !vpl || !layout.subs.includes(sub.n)) return reply.code(404).send({ error: 'gone' });
      reply.header('cache-control', 'no-store').header('access-control-allow-origin', '*');
      const video = await readFile(vpl, 'utf8');
      if (sub.k == null) return reply.type('application/vnd.apple.mpegurl').send(subtitlePlaylist(video, sub.n, tok));
      const vtt = transcoder.hlsFile(sid, files.subVtt(sub.n));
      return reply.type('text/vtt').send(subtitleSegment(video, vtt ? await readFile(vtt, 'utf8') : '', sub.k));
    }
    const p = transcoder.hlsFile(sid, file);
    if (!p) return reply.code(404).send({ error: 'gone' });
    reply.header('cache-control', 'no-store').header('access-control-allow-origin', '*');
    if (file.endsWith('.m3u8')) {
      const pl = servePlaylist(await readFile(p, 'utf8'), file, transcoder.hlsInfo(sid)?.layout ?? null, Number((req.query as any).ds ?? -1), tok);
      return reply.type('application/vnd.apple.mpegurl').send(pl);
    }
    return reply.type(file.endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment').send(await readFile(p));
  });

  app.delete('/api/hls/:sid', async (req) => { await transcoder.stopHls((req.params as any).sid); return { ok: true }; });

  // ---- skip intro / credits markers and seek-bar thumbnails (made in the background) ----
  app.get('/api/extras/:id', async (req) => prefetcher.extras(String((req.params as any).id)) ?? { markers: {}, duration: null, thumbs: null });
  app.get('/api/thumbs/:id', async (req, reply) => {
    const p = prefetcher.sprite(String((req.params as any).id).replace(/\.jpg$/, ''));
    if (!existsSync(p)) return reply.code(404).send({ error: 'not ready' });
    return reply.type('image/jpeg').header('cache-control', 'private, max-age=86400').send(await readFile(p));
  });
  /** Prepare these titles while idle (the next episode, a title about to be played). */
  app.post('/api/prefetch', async (req) => {
    const list = (((req.body ?? {}) as any).items ?? []) as { id: string; ext?: string }[];
    for (const it of list.slice(0, 5)) if (isVodId(String(it.id))) prefetcher.want(String(it.id), vodSrc(String(it.id), it.ext));
    return { ok: true };
  });

  /** Player problems seen on a device (iPhone Safari has no console we can read): logged for debugging. */
  app.post('/api/clientlog', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    app.log.warn(`client ${req.deviceId ?? '?'}: ${String(b.msg ?? '').slice(0, 300)}`);
    return { ok: true };
  });
}
