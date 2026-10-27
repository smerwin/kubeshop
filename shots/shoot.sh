#!/bin/sh
# usage: shots/shoot.sh NAME "query" [w h budget]
cd "$(dirname "$0")/.."
G="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$G" --headless=new --hide-scrollbars --user-data-dir="$(mktemp -d)" --force-device-scale-factor=2 \
  --window-size=${3:-900},${4:-800} --virtual-time-budget=${5:-3000} --screenshot="shots/$1.png" "file://$PWD/figure/longshore.html?$2" 2>/dev/null
