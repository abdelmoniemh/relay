---
name: Relay
description: One household player across TV, phone and desktop, in the streaming-category standard (Netflix first, Apple TV app second).
colors:
  canvas: "#141414"
  canvas-ios: "#000000"
  surface-1: "#1f1f1f"
  surface-2: "#2a2a2a"
  surface-3: "#3a3a3a"
  text-primary: "#ffffff"
  text-secondary: "#b3b3b3"
  text-tertiary: "#808080"
  divider: "#ffffff1f"
  accent: "#0a84ff"
  live-red: "#ff3b30"
  verified-green: "#30d158"
  caution-yellow: "#ffd60a"
  key-red: "#ff3b30"
  key-green: "#30d158"
  key-yellow: "#ffd60a"
  key-blue: "#0a84ff"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Arabic', sans-serif"
    fontSize: "2.5rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
  callout:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4
  caption:
    fontFamily: "{typography.display.fontFamily}"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.3
rounded:
  tile: "6px"
  control: "6px"
  sheet: "12px"
  pill: "999px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
  gutter-phone: "16px"
  gutter-desktop: "4vw"
  gutter-tv: "80px"
components:
  button-play:
    backgroundColor: "{colors.text-primary}"
    textColor: "#000000"
    rounded: "{rounded.control}"
    padding: "10px 24px"
    typography: "{typography.title}"
  button-secondary:
    backgroundColor: "#6d6d6eb3"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "10px 24px"
    typography: "{typography.title}"
  tile-poster:
    backgroundColor: "{colors.surface-1}"
    rounded: "{rounded.tile}"
  tile-landscape:
    backgroundColor: "{colors.surface-1}"
    rounded: "{rounded.tile}"
  chip:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
    typography: "{typography.callout}"
  chip-selected:
    backgroundColor: "{colors.text-primary}"
    textColor: "#000000"
    rounded: "{rounded.pill}"
  pill-live:
    backgroundColor: "{colors.live-red}"
    textColor: "{colors.text-primary}"
    rounded: "4px"
    padding: "2px 6px"
    typography: "{typography.caption}"
  list-row:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sheet}"
    padding: "12px 16px"
  input-search:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
---

<!-- Chosen with the user on 2026-11-19 and implemented the same day: tokens live in web/src/styles.css (:root), components in web/src/ui/kit.tsx, icons in web/src/ui/Icon.tsx, strings in web/src/i18n*.ts. Re-run /impeccable document (scan mode) to regenerate this file and .impeccable/design.json from the code. -->

# Design System: Relay

## Overview

**Creative North Star: "The Living-Room Standard"**

Relay looks and behaves like the streaming apps the household already uses, so nobody has to learn it. Netflix sets the bar: artwork carries the colour, the chrome is black and grey, a big billboard opens Home and Movies & TV, and everything else is horizontal rows of tiles. The Apple TV app is the second reference and wins on iPhone, where native SwiftUI controls, Liquid Glass bars and system type replace anything web-shaped.

The interface is quiet so the content can be loud. There is one accent (blue) for selection, progress and links. Primary actions are white buttons ("Play", "Resume", "Watch here"). Red appears only for LIVE. Relay's own ideas (hand-off between devices, verified stream quality, the phone as remote) use the same standard parts: a mini-player bar, a quality chip, a sheet.

The same screens ship at three densities: phone (touch, bottom tab bar), desktop (mouse, top nav), TV (D-pad, top nav, 10-foot type). Sections, names and order never change between them.

**Key Characteristics:**
- Black canvas, grey surfaces, artwork as the only colour field.
- Billboard + rows on Home and Movies & TV; lists on Live TV, Sports, Settings.
- White primary buttons, blue for selection and progress, red only for LIVE.
- System fonts everywhere; Arabic via the platform's Arabic face; full RTL mirroring.
- Flat surfaces; depth comes from scrims on artwork and frosted bars over scrolling content.

## Colors

A restrained neutral palette. Artwork supplies every saturated colour.

### Primary
- **Relay Blue** (#0a84ff): the selected tab, progress bars on tiles, links, toggles, the TV focus ring's inner glow on secondary controls. On iOS it is the app `tint`. Never a fill for large areas.

### Neutral
- **Screen Black** (#141414): page background on web and TV (Netflix's canvas). iOS uses true black (#000000) through `systemBackground` so OLED and Dark Mode behave natively.
- **Tile Grey** (#1f1f1f): tile placeholders, list rows, cards.
- **Raised Grey** (#2a2a2a): inputs, chips, sheets, the hovered/selected list row.
- **Pressed Grey** (#3a3a3a): pressed state, scrollbar thumb.
- **White** (#ffffff): primary text and the primary button.
- **Silver** (#b3b3b3): secondary text (metadata, EPG "now" titles, row counts).
- **Dim Grey** (#808080): tertiary text and disabled labels.
- **Hairline** (#ffffff1f): dividers between list rows and under bars.

### Status
- **Live Red** (#ff3b30): LIVE pill, live dot, recording/error. Nothing else is red.
- **Verified Green** (#30d158): a stream quality measured on the real stream (✓ 1080p50 · 10.0 Mb/s).
- **Caution Yellow** (#ffd60a): favourites star, "claims 4K · unverified", warnings.

### Remote keys (TV only)
The Samsung remote's colour keys keep fixed meanings and are drawn as small dots beside the action they trigger: red = favourite, green = watch here, yellow = sources/guide, blue = send to another device.

### Named Rules
**The Artwork Owns Colour Rule.** Chrome stays black, grey and white; posters, backdrops and channel logos are the only large colour areas. Never tint a surface to "match the brand".

**The One Red Rule.** Red means live (or an error). Never use it for a button, a badge count or decoration.

## Typography

**Font:** the platform system face. Web/TV stack (see `--font` in styles.css): `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Noto Sans", "Noto Sans Arabic", sans-serif`. Tizen falls back to SamsungOne and Samsung's Arabic face. iOS uses SF Pro and SF Arabic through Dynamic Type text styles only.

**Character:** neutral and invisible, like the reference apps. Weight and size carry hierarchy; there is no display face.

### Hierarchy (web base 16px; TV multiplies by 1.5; iOS uses the named text style)
- **Display** (700, 2.5rem, 1.1): billboard title only. iOS: Large Title.
- **Headline** (700, 1.5rem, 1.2): screen titles (Live TV, Sports, Settings). iOS: Title 2 / navigation large title.
- **Title** (600, 1.125rem, 1.3): row titles ("Continue watching"), buttons, list-row primary text. iOS: Headline.
- **Body** (400, 1rem, 1.45): descriptions, EPG programme text. Max 65ch. iOS: Body.
- **Callout** (400, 0.875rem, 1.4): tile captions, metadata lines, chips. iOS: Subheadline / Footnote.
- **Caption** (500, 0.75rem, 1.3): LIVE pill, quality chip, timestamps. Never smaller than 11pt on iOS or 24px on TV.

### Named Rules
**The Tabular Times Rule.** Clock times, channel numbers, durations, scores and bitrates use `font-variant-numeric: tabular-nums` (iOS `.monospacedDigit()`) so columns line up.

**The Arabic Breathing Rule.** When `lang="ar"`, raise line-height by 0.15 and never letter-space Arabic text. Times, channel numbers and quality values stay in Latin digits inside Arabic text.

## Layout

- **Billboard + rows.** Home and Movies & TV open with a 16:9 billboard (backdrop, title, one meta line, Play + More info), then horizontal rows. Rows scroll sideways; the page scrolls vertically. Each row ends in a "See all" tile when there is more.
- **Tiles.** Posters 2:3 for films and series; landscape 16:9 for Continue watching (with progress bar), live channels (logo + now-playing title + progress) and sports events. Desktop: posters about 10.5rem wide; phone 7.25rem; TV 15rem.
- **Lists** for Live TV channels, Sports events, Search results, Settings: full-width rows, 56–76px tall on phone/desktop, 96px on TV.
- **Gutters.** Phone 16px; desktop 4vw (Netflix); TV 80px each side (title-safe on 1080p). Rows bleed to the right edge (left edge in RTL) so the next tile peeks in.
- **Spacing rhythm.** 4px grid: 4, 8, 12, 16, 24, 32, 48. Row-to-row 32px desktop, 24px phone, 48px TV.
- **Navigation by device.**
  - Phone: bottom tab bar, 5 sections (Home · Live TV · Sports · Movies & TV · Search); Remote and Settings as icon buttons in Home's header, opening as sheets/pushed screens.
  - Desktop: top bar (Netflix web): logo, the same 5 sections as text links, search, remote and settings icons at the end. Transparent over the billboard, solid Screen Black once scrolled.
  - TV: top bar (Netflix's 2025 TV layout): the same sections; Up from the first row reaches it; Back from any section returns to Home, then to the top bar.
- **RTL.** All layout uses logical properties (`margin-inline-start`, `inset-inline-end`, `text-align: start`). Rows start at the right; chevrons and back arrows mirror; progress bars fill right-to-left; media transport icons (play, seek) do not mirror.

## Elevation & Depth

Flat by default. Depth comes from two things only:

- **Scrims on artwork:** the billboard and title page backdrop fade to Screen Black at the bottom and toward the text side (`linear-gradient(to top, #141414 0%, transparent 50%)` plus `linear-gradient(to right, #141414cc 0%, transparent 60%)`, mirrored in RTL).
- **Frosted bars** over scrolling content: the scrolled top bar, the phone tab bar, the mini-player (`background: #141414cc; backdrop-filter: blur(20px) saturate(1.4)`). Older Tizen engines without `backdrop-filter` get solid #141414f2. On iOS these are the system materials and Liquid Glass bars; never hand-rolled.

### Shadow Vocabulary
- **Floating** (`0 8px 24px #000a`): only for things that float over content: the mini-player, toasts, menus.

### Named Rules
**The No Card Shadow Rule.** Tiles, rows and panels never cast shadows; hierarchy is grey steps on black.

## Shapes

Gently rounded: tiles and buttons 6px, sheets and grouped lists 12px, chips and the search field on phone fully rounded (999px). Channel logos sit in a 6px rounded square on Tile Grey. No borders on tiles; a 1px Hairline only between list rows and under bars.

## Components

### Buttons
- **Play / primary** (white fill, black text, 6px, 10px 24px, Title type): Play, Resume, Watch here, Continue here. One per screen region.
- **Secondary** (#6d6d6eb3 translucent grey, white text): More info, Trailer, My list, Sources.
- **Icon button** (44×44 hit area, no fill, white icon; pressed: Raised Grey circle): header actions.
- **States:** hover lightens fill by 10% (desktop only); pressed darkens; disabled 40% opacity; TV focus = white 3px ring + scale(1.06), 150ms.

### Tiles
- **Poster** (2:3, 6px, Tile Grey placeholder with the title's first letter): caption below in Callout, metadata (year · rating) in Silver.
- **Landscape** (16:9): Continue watching (backdrop + 4px progress bar in Relay Blue), Live channel (logo centred on Tile Grey, "Now: title" below, thin progress), Sports event (teams, competition, LIVE pill or kick-off time, best verified quality).
- **Badges** sit top-start inside the artwork: 4K, NEW, watchlist ribbon; never more than two.
- **Focus (TV):** white 3px ring + scale(1.08), neighbours unchanged. **Hover (desktop):** scale(1.04) + caption brightens, 200ms after a 150ms delay.

### Chips
- Filter and category chips: Raised Grey pill, white text; selected = white fill, black text. A horizontal scroller on phone; wraps on desktop.

### Lists / Settings
- iOS-style grouped inset lists on every platform: 12px rounded group, rows separated by Hairline, label start, value end in Silver, chevron for drill-in, native-looking toggle for on/off (Relay Blue). Section header in Caption, uppercase, Silver.

### Inputs
- Search field: Raised Grey, 6px (pill on phone), magnifier icon at start, clear button at end; focus = 2px white outline. Results grouped under "Channels", "Movies", "Series" headers instead of per-row type badges.

### Navigation
- See Layout. Selected section: white text with a 2px white underline (desktop/TV top bar); Relay Blue icon + label (phone tab bar, iOS tint). Unselected: Silver.

### Mini-player (hand-off) — signature component
- The one Relay-specific component. When something plays on another device: a frosted bar with artwork thumb, title, "Playing on Living room TV", and a white **Watch here** button. Phone: docked above the tab bar (iOS: `tabViewBottomAccessory`). Desktop: bottom-end floating card, 360px. TV: top-end chip with a green-key dot ("● Watch here"). When this device is playing, the same bar shows transport controls and a "Send to…" action (blue key on TV).

### Quality chip
- Caption type on Raised Grey: "1080p50 · 10.0 Mb/s ✓" in Verified Green when measured, "claims 4K · unverified" in Caution Yellow when not.

### Player overlay
- Standard full-screen video chrome: title top-start, close/back top-start, AirPlay/PiP/sources top-end, scrubber and time at the bottom, big centred play/pause and ±10s. Fade out after 3s. iOS uses AVPlayerViewController.

## Do's and Don'ts

### Do:
- **Do** let artwork carry colour; keep chrome to Screen Black, the three greys and white.
- **Do** use white fill for the single primary action in a region.
- **Do** keep the same 5 sections, same names, same order on TV, phone and desktop.
- **Do** use system controls on iOS (TabView, NavigationStack, Form, Toggle, Menu, sheets, swipe actions) and SF Symbols.
- **Do** use logical CSS properties everywhere so Arabic mirrors with `dir="rtl"`.
- **Do** show a skeleton tile row while a row loads, never a centred spinner in content.
- **Do** keep every TV focus state visible: white ring + scale.

### Don't:
- **Don't** use red for anything but LIVE and errors.
- **Don't** put more than 5 items in any tab bar or top bar.
- **Don't** add shadows to tiles or rows.
- **Don't** use Netflix's red, logo or Netflix Sans; the reference is the quality and structure, not the brand.
- **Don't** hand-roll glass on iOS, or use a custom font for UI text there.
- **Don't** hide actions behind gestures only; every swipe has a visible button too.
