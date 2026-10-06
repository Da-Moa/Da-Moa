"""Regenerate UI font subsets with installed fontTools: python3 scripts/subset-fonts.py."""
from io import BytesIO
from pathlib import Path
from urllib.request import urlopen

from fontTools import subset
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parents[1]
target = root / "src/assets/fonts"
target.mkdir(parents=True, exist_ok=True)
characters = set(range(0x20, 0x7F))
for path in (root / "src").rglob("*"):
    if path.suffix in {".ts", ".tsx", ".mjs", ".css"} and ".test." not in path.name:
        characters.update(map(ord, path.read_text()))

styles = ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"]
for index, style in enumerate(styles, 1):
    url = f"https://cdn.jsdelivr.net/gh/projectnoonnu/2404@1.0/Freesentation-{index}{style}.woff2"
    with urlopen(url, timeout=30) as response:
        font = TTFont(BytesIO(response.read()), recalcTimestamp=False)
    original = font.getBestCmap()
    widths = {code: font["hmtx"].metrics[glyph] for code, glyph in original.items() if code in characters}
    options = subset.Options()
    options.flavor = "woff2"
    options.recalc_timestamp = False
    options.name_IDs = ["*"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=characters)
    subsetter.subset(font)
    path = target / f"presentation-ui-{index}00.woff2"
    font.save(path)
    result = TTFont(path)
    actual = result.getBestCmap()
    assert set(actual) == set(widths), "Subset must retain every supported UI character"
    assert all(result["hmtx"].metrics[actual[code]] == width for code, width in widths.items()), "Keep original glyph metrics"
    print(f"{path.name}: {path.stat().st_size:,} bytes, {len(actual)} characters")
