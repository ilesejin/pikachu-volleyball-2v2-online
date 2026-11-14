"""Optional cap exporter with pose-specific forehead placement (Pillow required)."""
from pathlib import Path
import json
import math
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parents[2]
IMAGES = ROOT / 'src/resources/assets/images'
layout = json.loads((IMAGES / 'costumes/frames.json').read_text())
landmarks = json.loads((Path(__file__).parent / 'fit_landmarks.json').read_text())['frames']
sheet = Image.new('RGBA', (layout['size']['w'], layout['size']['h']))
placements = {}
source = Image.open(IMAGES / 'sprite_sheet.png').convert('RGBA')
eyes = json.loads((ROOT / 'art/sunglasses/eye_landmarks.json').read_text())['frames']
for index, (name, info) in enumerate(layout['frames'].items()):
    fit = landmarks[name]
    hx, top = fit['crownBase']
    # Fit on the skull rather than centering over the eye. Tilt with the head.
    path = fit['headbandPath']
    angle = math.atan2(path[-1][1] - path[0][1], path[-1][0] - path[0][0])
    base = top + (2 if index < 18 else 6 if index < 25 else 3)
    # These raised/tilted poses have less clearance above the eyes.
    base -= {9: 1, 23: 3, 24: 1}.get(index, 0)
    half = 11 if index < 18 else 16
    height = min(9, base - math.ceil(half * abs(math.sin(angle))) - 1)
    layer = Image.new('RGBA', (64, 64))
    draw = ImageDraw.Draw(layer)
    def points(coords):
        return [(round(hx + x * math.cos(angle) - y * math.sin(angle)),
                 round(base + x * math.sin(angle) + y * math.cos(angle))) for x, y in coords]
    def polygon(coords, color):
        draw.polygon(points(coords), fill=color)
    polygon([(-half+3,-height),(half-3,-height),(half-3,-2),(half,-2),(half,1),(-half,1),(-half,-2),(-half+3,-2)], '#41263c')
    polygon([(-half+4,-height+1),(half-4,-height+1),(half-4,-2),(-half+4,-2)], '#e62c50')
    draw.line(points([(-half+5,-height+2),(half-5,-height+2)]),fill='#ff6d7d',width=1)
    polygon([(-half+1,-1),(half-1,-1),(half-1,0),(-half+1,0)], '#bd2449')
    polygon([(-1,-height+3),(1,-height+3),(1,-height+5),(-1,-height+5)], '#fff6d4')
    f = info['frame']
    # Fail a manual export rather than save a cap that hides an eye.
    for left, upper, right, lower in eyes[name]:
        for yy in range(upper, lower + 1):
            for xx in range(left, right + 1):
                pixel = source.getpixel((f['x'] + xx, f['y'] + yy))
                if pixel[3] > 200 and (max(pixel[:3]) < 80 or min(pixel[:3]) > 200):
                    assert not layer.getpixel((xx, yy))[3], (name, xx, yy)
    sheet.paste(layer,(f['x']-layout['offset']['x'],f['y']-layout['offset']['y']))
    placements[name] = {'brimCenter':[hx,base], 'angleDegrees':round(math.degrees(angle),2)}
sheet.save(IMAGES / 'costumes/cap.png', optimize=True)
(Path(__file__).parent / 'cap_landmarks.json').write_text(json.dumps({'frames':placements},indent=2)+'\n')
