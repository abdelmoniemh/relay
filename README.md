# Relay

Personal IPTV player for Samsung TV, iPhone and this PC, sharing one provider account that allows **one stream at a time**.
Start something on one device and the others offer **"Continue here"**. The old device always stops *before* the new one starts.
Any device can act as a **remote** for another.

```
server/   Node 26 + SQLite. Syncs the provider catalog/EPG, serves the API, coordinates the single stream (WebSocket hub)
web/      Preact client: desktop browser, iPhone (Add to Home Screen) and the Samsung TV build
tizen/    Samsung TV packaging (config.xml, build.sh)
shared/   protocol types
```

## Run
The server runs as a systemd user service (`systemctl --user status relay`) on port 8787.
Provider credentials live in `server/.env` (not committed). Catalog refreshes every 12h and the guide every 6h, or on demand in Settings.

| Device | How |
|---|---|
| This PC | open http://localhost:8787 (pairs automatically) |
| iPhone | Safari → `http://<pc-lan-ip>:8787` → Share → Add to Home Screen, then enter the pairing code |
| Samsung TV | `tizen/build.sh install <tv-ip>` (one-time Tizen Studio setup below) |

The pairing code is in **Settings** on any paired device.

## Keys
Arrows/OK/Back · CH± zap · **red** (or `F`) favorite · **green** continue here · **blue** send to another device · digits jump to channel #.

## Samsung TV setup (once)
1. Install Tizen Studio (CLI) + the "Samsung TV Extensions", and create a certificate profile named `relay`.
2. On the TV: Apps → press `1 2 3 4 5` → Developer mode **On**, Host PC IP = this PC → reboot the TV.
3. `tizen/build.sh install <tv-ip>`

## Dev
`npm run dev:web` (Vite on :5173 proxying to the server) · `npm test` · `cd web && npx vite build` (the server serves `web/dist`).
