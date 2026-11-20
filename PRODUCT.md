# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

Surfaces, one product: desktop browser (this PC), phone (iPhone home-screen web app today, native SwiftUI app planned in `ios/`), and Samsung TV (Tizen web build, stays web). The web client is Preact; one codebase serves desktop, phone and TV via `html.desktop | .phone | .tv`.

## Users

A household. Several people use it on the living-room TV, on their phones and at the PC, including people who are not technical and some who want the interface itself in Arabic. Content is a mix of English and Arabic (Arabic audio, Arabic subtitles, Arabic-region live channels). Typical scenes: someone on the sofa with the TV remote looking for a match that is about to start; someone on a phone picking up a film where they left off; the PC used as the "power" seat (settings, catalog sync).

## Product Purpose

A personal IPTV player over one provider account that allows **one stream at a time**. Relay makes that limit invisible: start something on one device and every other device offers "Continue here"; the old device always stops before the new one starts. Any device can act as a remote for another. Success: anyone in the house finds what they want (a live channel, tonight's match, a film) in a few presses and never hits the one-stream wall by surprise.

## Positioning

Not a generic IPTV client: the household's devices behave like one player. Hand-off between devices, a phone as remote for the TV, and quality-verified sports sources (ranked by measured resolution/bitrate, auto-fallback) are the mechanisms no stock player offers. Films and series are de-duplicated into titles (one card per film, many provider copies behind it) with TMDB metadata and a Letterboxd watchlist.

## Operating Context

- TV: 1920×1080, 10-foot viewing, Samsung remote (D-pad, OK, Back, CH±, colour keys: red favorite, green continue here, blue send to device, digits jump to channel). Hardware video plane behind a transparent page. Older Tizen engines (no `aspect-ratio`, no flex `gap`) must keep working.
- Phone: one-handed, often in landscape while playing; full-screen, PiP, AirPlay.
- Desktop: mouse + keyboard, hover-expanding rail.
- Catalog scale: ~53k live channels, ~180k movies, ~50k series (filtered by region and language settings). Guide (EPG) refreshes every 6 h, catalog every 12 h.

## Capabilities and Constraints

- Sections: Home (continue watching, favorites, watchlist, recent channels, "playing on X" hand-off), Live TV (category → channel list, preview, EPG now/next), Sports (events next 36 h by sport, live pill, ranked sources with verified quality), Movies and Series (browse rows, filterable grid, title page with versions/seasons), Search, Remote, Settings.
- One stream at a time is a hard provider limit; hand-off state (lease) is pushed over WebSocket.
- Pairing by 6-digit code; devices are named and listed.
- TV is the only surface without touch; phone has no D-pad. The same screens must work under both input models.
- Must support RTL layout and Arabic text in the UI (household requirement); not yet implemented.
- Undecided: whether the iPhone web app remains after the native app ships.

## Brand Commitments

- Visual direction: the streaming-category standard, played straight (chosen 2026-11-19 over three distinctive directions). Reference bar, in priority order: **Netflix** first, then the **Apple TV app**. Where they differ, follow Netflix; on iOS, native SwiftUI conventions (Apple TV app) win over web-shaped ones.
- The name "Relay" and the current blue play-button icon are not binding and may be replaced.

## Evidence on Hand

Real content only: provider channel logos, TMDB posters/backdrops, EPG titles, sports fixtures. No marketing surface, no testimonials; none should be invented.

## Product Principles

1. The house has one player: hand-off and "what's playing where" are always visible and one action away.
2. Live first: the match about to start and the channel already on outrank browsing.
3. Same mental map on every device: sections, names and order match across TV, phone and desktop; only the input model and density change.
4. Works for the least technical person on the sofa: plain labels, no hidden gestures required, Back always does the expected thing.
5. Quality is measured, not claimed: show verified resolution/bitrate where it exists, and say "unverified" plainly.

## Accessibility & Inclusion

- Arabic UI and RTL mirroring; mixed-direction titles (Arabic and Latin in one list).
- 10-foot legibility on TV (no text below ~24 px at 1080p), focus always visible on TV.
- iOS: Dynamic Type, 44 pt targets, Reduce Motion.
