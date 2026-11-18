#!/usr/bin/env bash
# Builds Relay for Samsung TV and (optionally) installs it.
#   ./build.sh                       -> tizen/Relay.wgt
#   ./build.sh install 192.168.1.50  -> also installs on the TV at that IP (TV must be in Developer Mode)
# Needs: Tizen Studio CLI (tizen, sdb) on PATH and a Samsung certificate profile (default name: "relay").
set -euo pipefail
cd "$(dirname "$0")"
SERVER="${RELAY_SERVER:-http://$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}'):8787}"
PROFILE="${TIZEN_PROFILE:-relay}"
echo "Building TV app (default server: $SERVER)"
(cd ../web && RELAY_SERVER="$SERVER" npx vite build --mode tizen --outDir ../tizen/build)
cp config.xml icon.png build/
rm -f Relay.wgt
tizen package -t wgt -s "$PROFILE" -- build
mv build/Relay.wgt . 2>/dev/null || mv build/*.wgt Relay.wgt
echo "Built $(pwd)/Relay.wgt"
if [[ "${1:-}" == "install" ]]; then
  TV="${2:?usage: ./build.sh install <tv-ip>}"
  sdb connect "$TV"
  DEV=$(sdb devices | awk -v ip="$TV" 'index($1, ip) {print $3; exit}')
  tizen install -n Relay.wgt -t "${DEV:-$TV:26101}"
  echo "Installed. Open 'Relay' from the TV's Apps."
fi
