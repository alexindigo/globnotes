#!/usr/bin/env python3
"""Outline the brand SVGs — convert <text> to <path> so they render without
any font dependency (self-contained SVG, like the original flatnotes logo)."""
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

DANCING_TTF = "/home/user/.local/share/fonts/DancingScript.ttf"
POPPINS_OTF = "/usr/share/fonts/OTF/Poppins-Regular.otf"


def glyph_parts(font, glyph_name, upem, font_size, *, hslug=""):
    """Return a list of SVG path `d` strings (one per contour group) for a
    single glyph, scaled to *font_size* px and flipped Y (font→SVG)."""
    pen = SVGPathPen(font.getGlyphSet())
    s = font_size / upem
    t = Transform(s, 0, 0, -s, 0, 0)
    tpen = TransformPen(pen, t)
    g = font.getGlyphSet()[glyph_name]
    g.draw(tpen)
    raw = pen.getCommands()
    if not raw:
        return []
    # Split multi-contour commands produced by SVGPathPen into separate <path>
    # elements so we can position each one with a dedicated transform.
    parts = raw.split(" M")
    if parts[0].startswith("M"):
        parts[0] = "M" + parts[0]
    return [p.strip() for p in parts]


def glyph_advance(font, glyph_name, upem, font_size):
    return font["hmtx"][glyph_name][0] * font_size / upem


# ── icon.svg ──────────────────────────────────────────────────────────────

dancing = TTFont(DANCING_TTF)
d_upem = dancing["head"].unitsPerEm
STAR_SIZE = 37.7
star_adv = glyph_advance(dancing, "asterisk", d_upem, STAR_SIZE)

# Two asterisks, centred at x=15, baseline y=40.5
# text-anchor="middle" → the string centre is at x=15 → first glyph origin at
# 15 − star_adv.
x1 = 15 - star_adv
y = 40.5

asterisk_parts = glyph_parts(dancing, "asterisk", d_upem, STAR_SIZE, hslug="a")
star_paths = ""
for p in asterisk_parts:
    star_paths += f'      <path transform="translate({x1},{y})" d="{p}" fill="#ffffff"/>\n'
for p in asterisk_parts:
    star_paths += f'      <path transform="translate({x1 + star_adv},{y})" d="{p}" fill="#ffffff"/>\n'

ICON_SVG = f"""<svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
  <rect width="36" height="36" rx="4" fill="#38BDF8"/>
{star_paths.rstrip()}
</svg>
"""

with open("client/assets/brand/icon.svg", "w") as fh:
    fh.write(ICON_SVG)

# ── logo.svg ──────────────────────────────────────────────────────────────

poppins = TTFont(POPPINS_OTF)
p_upem = poppins["head"].unitsPerEm
WORDMARK_SIZE = 38

star_adv_46 = glyph_advance(dancing, "asterisk", d_upem, STAR_SIZE)
x1l = 15 - star_adv_46
yl = 44.5

logo_star_paths = ""
for p in asterisk_parts:
    logo_star_paths += f'      <path transform="translate({x1l},{yl})" d="{p}" fill="#ffffff"/>\n'
for p in asterisk_parts:
    logo_star_paths += f'      <path transform="translate({x1l + star_adv_46},{yl})" d="{p}" fill="#ffffff"/>\n'

# Wordmark "globnotes" — placed as if at text x=0, y=35, then the group
# applies translate(46,0) scale(0.85,1). The horizontal scale is 0.85; we'll
# apply it as a group transform and leave glyph advances in unscaled px.
wordmark_paths = ""
cursor = 0
for ch in "globnotes":
    gname = poppins.getBestCmap()[ord(ch)]
    parts = glyph_parts(poppins, gname, p_upem, WORDMARK_SIZE)
    adv = glyph_advance(poppins, gname, p_upem, WORDMARK_SIZE)
    for p in parts:
        wordmark_paths += (
            f'      <path transform="translate({cursor},{35})" d="{p}" '
            f'fill="#9CAFBF"/>\n'
        )
    cursor += adv

LOGO_SVG = f"""<svg width="208" height="46" viewBox="0 0 208 46" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect y="4" width="36" height="36" rx="4" fill="#38BDF8"/>
{logo_star_paths.rstrip()}
  <g transform="translate(46,0) scale(0.85,1)">
{wordmark_paths.rstrip()}
  </g>
</svg>
"""

with open("client/assets/brand/logo.svg", "w") as fh:
    fh.write(LOGO_SVG)

print("icon.svg  :", len(ICON_SVG), "bytes")
print("logo.svg  :", len(LOGO_SVG), "bytes")
