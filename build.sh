#!/bin/sh
# builds the single-file figure into figure/longshore.html
cd "$(dirname "$0")"
python3 "$HOME/.claude/skills/colorfigures/scripts/build.py" src/longshore.html figure/longshore.html
