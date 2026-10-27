#!/bin/sh
# builds the single-file figures: figure/shopfloor.html (the job shop, three.js with real light), figure/longshore.html (Colorfigures SVG engine) and figure/longshore3d.html (three.js,
# which loads the vendored engine from figure/vendor/). The simulation they share, src/sim.js, is inlined into both.
cd "$(dirname "$0")"
python3 "$HOME/.claude/skills/colorfigures/scripts/build.py" src/longshore.html figure/longshore.html
python3 - <<'PY'
import re, os
def inline(page):
    # every <script src="NAME.js"> that names a file in src/ is inlined (a type="module" tag stays a module)
    def rep(m):
        attrs, name = m.group(1), m.group(2)
        body = open(os.path.join('src', name), encoding='utf-8').read()
        return '<script' + (' type="module"' if 'module' in attrs else '') + '>\n' + body + '\n</script>'
    return re.sub(r'<script((?:\s+type="module")?)\s+src="((?:sim|room|chrome|view3d|yard3d|shop3d)\.js)"\s*>\s*</script>', rep, page)
for src, out in [('figure/longshore.html', 'figure/longshore.html'), ('src/longshore3d.html', 'figure/longshore3d.html'), ('src/shopfloor.html', 'figure/shopfloor.html')]:
    page = inline(open(src, encoding='utf-8').read())
    if 'src="sim.js"' in page: raise SystemExit('sim.js not inlined in ' + src)
    open(out, 'w', encoding='utf-8').write(page); print('wrote', out)
# the root index.html is the shop floor itself, so the site opens on the figure: same page, paths one level up
root = open('figure/shopfloor.html', encoding='utf-8').read()
for a, b in [('"./vendor/three.module.js"', '"./figure/vendor/three.module.js"'), ('"./vendor/addons/"', '"./figure/vendor/addons/"'),
             ('href="longshore3d.html"', 'href="figure/longshore3d.html"'), ('href="longshore.html"', 'href="figure/longshore.html"')]:
    assert a in root, a; root = root.replace(a, b)
open('index.html', 'w', encoding='utf-8').write(root); print('wrote index.html (the shop floor at the root)')
PY
