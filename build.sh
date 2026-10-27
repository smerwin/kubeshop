#!/bin/sh
# builds the two single-file figures: figure/longshore.html (Colorfigures SVG engine) and figure/longshore3d.html (three.js,
# which loads the vendored engine from figure/vendor/). The simulation they share, src/sim.js, is inlined into both.
cd "$(dirname "$0")"
python3 "$HOME/.claude/skills/colorfigures/scripts/build.py" src/longshore.html figure/longshore.html
python3 - <<'PY'
import re
sim = open('src/sim.js', encoding='utf-8').read()
for src, out in [('figure/longshore.html', 'figure/longshore.html'), ('src/longshore3d.html', 'figure/longshore3d.html')]:
    try: page = open(src, encoding='utf-8').read()
    except FileNotFoundError: continue
    page, n = re.subn(r'<script\s+src=["\']sim\.js["\']\s*>\s*</script>', lambda m: '<script>\n' + sim + '\n</script>', page, count=1)
    if not n: raise SystemExit('no <script src="sim.js"></script> in ' + src)
    open(out, 'w', encoding='utf-8').write(page); print('wrote', out)
PY
