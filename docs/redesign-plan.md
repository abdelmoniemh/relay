# Relay redesign plan

Direction: the streaming-category standard (see `DESIGN.md`), Netflix first, Apple TV app second. Product facts in `PRODUCT.md`.
## Status (2026-11-19)

Web rebuild **done** (phases 0–9), verified by screenshots at 390×844 (EN + AR), 844×390, 1440×900 and 1920×1080 with D-pad input, and a Chrome 63 (Tizen) build:
- Phase 0: tokens, `ui/kit.tsx` (Billboard, Row, tiles, Btn, Segmented, Sheet, EditSheet, MiniPlayer, QualityChip), `ui/Icon.tsx`, `i18n.ts` + `i18n.ar.ts`.
- Phase 1: top bar on desktop/TV (Up from a screen's top edge reaches it; Back from a section root focuses it), phone tab bar, mini-player replaces the hand-off banner.
- Phases 2–8: Home, Movies & TV, title page, Live TV, Sports (chips instead of the sport column), Search (grouped), Settings (grouped lists, switches, sheets instead of prompt()), Remote, Pairing, player overlay.
- Phase 9: Arabic UI (Settings › Language), RTL mirroring with physical CSS + `[dir=rtl]` overrides (Chromium 63 has no logical shorthands).

Not done: impeccable's automated detector/finish review (its engine wasn't installed); Sports "Live now" rail and day grouping (the list already leads with LIVE events); iOS app (blocked: no developer account).

---


## Information architecture (all devices)

| Section | Phone | Desktop | TV | iOS app |
|---|---|---|---|---|
| Home | tab 1 | top bar | top bar | Tab |
| Live TV | tab 2 | top bar | top bar | Tab |
| Sports | tab 3 | top bar | top bar | Tab |
| Movies & TV (Movies \| Series toggle) | tab 4 | top bar | top bar | Tab + segmented Picker |
| Search | tab 5 | icon in top bar | top bar | `Tab(role: .search)` |
| Remote | Home header icon | top-bar icon | n/a (TV is the target) | toolbar button → sheet |
| Settings | Home header icon | top-bar icon | top-bar icon | toolbar button → sheet |
| Hand-off | mini-player above tabs | floating card bottom-end | chip top-end, green key | `tabViewBottomAccessory` |

## Web rebuild (desktop + phone + Tizen TV, one Preact codebase)

Each phase ships on its own and is checked with screenshots at 390×844 (phone), 1440×900 (desktop) and 1920×1080 (TV), plus one pass on an older Tizen engine for the legacy fallbacks.

**Phase 0: Foundations**
- `web/src/tokens.css`: the DESIGN.md tokens as CSS custom properties; `styles.css` rewritten against them (it currently hard-codes greys and a second blue).
- Logical properties sweep (`left/right` → `inline-start/end`) so `dir="rtl"` mirrors.
- String table (`web/src/i18n/en.ts`, `ar.ts`) and a language setting; every user-facing string moves out of the screens. Arabic font fallback and line-height rule.
- Shared primitives in `web/src/ui/`: `Button`, `IconButton`, `Tile` (poster/landscape), `Row` (titled horizontal scroller with skeleton), `Chip`, `ListGroup`/`ListRow`, `QualityChip`, `LivePill`, `MiniPlayer`. One focus model for all of them (D-pad focus on TV, hover on desktop, pressed on touch).

**Phase 1: Shell**
- Desktop: replace the hover-expanding left rail with the top bar (transparent over the billboard, frosted once scrolled).
- TV: top bar; key handling changes from "Left opens the rail" to "Up from the first row reaches the top bar". `keys.ts` layers stay as they are.
- Phone: restyle the existing tab bar to the tokens.
- `MiniPlayer` replaces the hand-off banner and the Home hand-off card on every device.

**Phase 2: Home**
- Billboard: the most recent unfinished title (else a watchlist pick), with Resume/Play + More info.
- Rows, in order: Continue watching (landscape + progress) · Live now (favourite channels, landscape with now-playing) · Tonight's football (events) · My list · From your Letterboxd watchlist · Recently watched channels.
- Empty state for a new device: three large entry tiles (Live TV, Sports, Movies & TV) instead of a text paragraph.

**Phase 3: Movies & TV**
- Movies | Series segmented toggle; billboard; rows from `api.browse`; chips (All, 4K, Arabic, Watchlist, Categories) under the toggle.
- Grid screen: sticky filter chips, poster grid with skeleton tiles.

**Phase 4: Title page**
- Netflix-style: backdrop with scrims, title, meta line (year · rating · runtime · 4K), Play/Resume + My list + Trailer, quality chip for the selected version, "Other versions" menu, synopsis, cast line.
- Series: season picker (menu) + episode list (16:9 thumb, number, title, runtime, progress), then "More like this" row.

**Phase 5: Live TV**
- Desktop/TV: categories column · channel list · preview + now/next panel (the current structure, restyled). Channel rows: number, logo tile, name, now-playing + progress, star.
- Phone: category picker as a horizontal chip row above the channel list instead of a separate screen.

**Phase 6: Sports**
- "Live now" landscape row at the top, then the list grouped by day (Today / Tomorrow / weekday). Sport filter as chips. Event detail: teams, competition, Watch best source (white), ranked sources with quality chips.

**Phase 7: Search, Remote, Settings, Pairing**
- Search: big field, recent searches, results grouped by Channels / Movies / Series.
- Remote: device picker as a segmented control, d-pad and transport in the standard iOS-remote layout.
- Settings: grouped lists with real toggles and value rows; text prompts (`prompt()`) replaced by inline edit rows or sheets.

**Phase 8: Player overlay**
- Restyle to the standard chrome (DESIGN.md › Player overlay); sources and versions in a menu instead of a dialog.

**Phase 9: Arabic**
- Arabic strings, `dir="rtl"` switch, mixed-direction titles checked (Arabic film titles in an English UI and vice versa), RTL screenshots for every screen.

**Finish**
- Run `/impeccable audit` and `/impeccable critique` on each surface, then `/impeccable document` to replace the DESIGN.md seed with the shipped tokens and write `.impeccable/design.json`.

## iOS app (SwiftUI, `ios/`)

- `TabView` with 5 `Tab`s; Search uses `role: .search`. One `NavigationStack` per tab, large titles on section roots.
- Remote and Settings: toolbar buttons on Home, presented as sheets (`.presentationDetents([.large])`).
- Hand-off: `tabViewBottomAccessory` hosting the mini-player; tapping it opens the player as a full-screen cover.
- Rows: `ScrollView(.horizontal)` + `LazyHStack` + `.scrollTargetBehavior(.viewAligned)`; tiles with `AsyncImage` and a placeholder.
- Billboard: a full-width image with a gradient overlay, inside the scroll view (not a custom header).
- Settings: `Form` with `Section`s, `Toggle`, `Picker`, `LabeledContent`.
- Playback: `AVPlayerViewController` (PiP, AirPlay, system controls); server HLS for MKV/AVI as today.
- Type: system text styles only (Dynamic Type); tint = Relay Blue; SF Symbols (`house`, `tv`, `sportscourt`, `film.stack`, `magnifyingglass`, `appletvremote.gen4`, `gearshape`).
- Arabic: `Localizable.xcstrings`; layout mirrors automatically; verify with the Arabic scheme language.
- Verification: simulator screenshots (iPhone SE + iPhone 17 Pro, Dark Mode, largest Dynamic Type, Arabic).

## Samsung TV specifics

- 1920×1080 viewport, 80px title-safe gutters, TV type scale ×1.5, minimum 24px text.
- Focus: white ring + scale on every focusable; never rely on colour alone.
- Colour keys keep their meanings and are shown as dots next to the actions they trigger.
- No `backdrop-filter`, `aspect-ratio` or flex `gap` on older engines: keep the `.legacy` fallbacks.

## Open decisions

- Keep the iPhone web app after the native app ships, or redirect phones to the App Store build?
- Rename/new icon: the name and icon are open (PRODUCT.md); decide before the iOS app is submitted.
