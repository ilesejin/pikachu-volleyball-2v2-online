"""Restore original tail pixels without regenerating or changing other skin edits."""
from pathlib import Path
import json
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parents[2]
IMAGES = ROOT / 'src/resources/assets/images'
meta = json.loads((IMAGES / 'costumes/frames.json').read_text())
regions = json.loads((Path(__file__).parent / 'tail_regions.json').read_text())['frames']
source = Image.open(IMAGES / 'sprite_sheet.png').convert('RGBA')
path = IMAGES / 'skins/cyborg.png'
sheet = Image.open(path).convert('RGBA')
changed = 0
for name, info in meta['frames'].items():
    f = info['frame']
    mask = Image.new('L', (64, 64))
    if regions[name]:
        ImageDraw.Draw(mask).polygon(regions[name], fill=255)
    for y in range(64):
        for x in range(64):
            if mask.getpixel((x, y)):
                original = source.getpixel((f['x'] + x, f['y'] + y))
                point = (f['x'] + x - meta['offset']['x'], f['y'] + y - meta['offset']['y'])
                if sheet.getpixel(point) != original:
                    sheet.putpixel(point, original)
                    changed += 1
sheet.save(path, optimize=True)
print(f'Restored {changed} tail pixels; other skin artwork preserved.')
