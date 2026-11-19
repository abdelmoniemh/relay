# Conversion quality bench

The browser conversion (`src/media.ts`) is tuned with these two tools. Both use the exact production ffmpeg arguments.

| Tool | What it checks |
|---|---|
| `node bench/quality.ts [--clip x] [--cand y] [--real]` | Encodes every candidate setting × clip and scores it: **VMAF** against an ideal CPU-processed reference (with 1%-low), **CAMBI** banding (≥5 is visible), **combing** (`idet`, interlaced clips only), speed (× real time), time to first byte, bitrate, audio layout. |
| `node bench/browser.ts [files]` | Plays each output in headless Chrome through mpegts.js with the app's player config, and fails on errors, no picture, more than 5% dropped frames, or silent audio. |

Clips: synthetic ones are generated into `bench/.clips/`. With `--real`, the bench also uses provider samples that the prober saves to `data/samples/` when the server runs with `RELAY_SAMPLES=1`. They are copied into `bench/.real/` first (the prober rotates its folder), placeholders are skipped, and at most 2 of each kind are kept. The prober only captures while nothing is playing, so capturing never adds a provider connection.

## Results (RTX 3060, 16 cores, ffmpeg 9.0.2, 2026-11-18)

| Source | Before | After |
|---|---|---|
| 1080i25 (interlaced) | 100% combed, VMAF 53 | 1% combed, 50p, VMAF 96 |
| 10-bit gradient | CAMBI 23 (heavy banding) | CAMBI 5.8 |
| 4K HDR10 movie | washed out (VMAF 1.5 vs a correct SDR picture) | tone mapped, VMAF 95.7 at 1.38× real time |
| 5.1 AC3 movie | stereo AAC | 5.1 AAC 448k (decodes in Chrome) |
| AAC sources | re-encoded | copied untouched |

Decisions the numbers made:
- **Interlace detection ignores idet on coded-progressive 50/60 fps streams.** On real channels, idet read a clean 50p MotoGP feed as 75 TFF / 0 progressive (motion blur on tarmac). It was the only interlaced flag among 75 probed channels.
- **Deinterlace with `bwdif_cuda` at field rate** (`send_field`). Frame rate (`send_frame`) scored VMAF 65 against 96: it halves the motion.
- **10-bit→8-bit: swscale dither.** Error diffusion is noisier, costs 3× the bitrate and banded more after encoding (CAMBI 8.6 vs 5.8). Truncation bands heavily (CAMBI 23).
- **AQ on** (spatial + temporal). Without it, gradient CAMBI goes from 8.6 to 16.5.
- **Live: NVENC p4 / hq / 3 B-frames / lookahead 20 / cq 19.** Checked on 6 real HEVC channels (1080p25/50/60, 2026-11-19): every candidate scored VMAF 97–99.9, all within 0.2 of each other, so the source is the limit, not the encoder. p4 matched p5 within 0.03 VMAF at 1.5× the speed (about 6× real time at 1080p50). p6/p7 add nothing and drop to 2.4× real time at 50p. cq 17 adds 0.05 VMAF for 10–30% more bitrate. Turning B-frames off is +0.05–0.15 VMAF but needs 5–10% more bitrate, so they stay on.
- **Movies: p7 + multipass qres / lookahead 32 / cq 18**, paced to real time after a 30 s burst.
- **HDR tone mapping (zscale + hable, ordered dither) runs at 1440p for 4K sources.** On the CPU, 4K manages only 0.6× real time; 1440p (GPU lanczos downscale first) reaches 1.38×. libplacebo (GPU) fails to initialise on this ffmpeg/libplacebo build. Fixing that would allow 4K tone mapping and Dolby Vision profile 5. The TV plays HDR natively and never uses this path.
- **No forced BT.709 tags.** Source tags pass through (SD is BT.601). Forcing them also made ffmpeg insert a CPU scaler that can't take GPU frames.
