"""Optional artwork helper: rebuild the cyborg sheet from the unchanged original.
Run manually with Python + Pillow. Normal game builds load the editable PNG directly.
"""
from pathlib import Path
from PIL import Image, ImageDraw
import json
ROOT = Path(__file__).resolve().parents[2]
IMAGES = ROOT / 'src/resources/assets/images'
meta = json.loads((IMAGES / 'costumes/frames.json').read_text())
original = Image.open(IMAGES / 'sprite_sheet.png').convert('RGBA')
tail_regions = json.loads((Path(__file__).parent / 'tail_regions.json').read_text())['frames']
sheet = Image.new('RGBA', (meta['size']['w'], meta['size']['h']))
for name, info in meta['frames'].items():
    f = info['frame']
    source = original.crop((f['x'], f['y'], f['x'] + 64, f['y'] + 64))
    frame = source.copy()
    state = int(name.split('_')[-2])
    # Track a real cheek through each original pose; on front-facing poses use
    # only the right cheek so the other half remains recognizably Pikachu.
    red = {(x, y) for y in range(64) for x in range(64)
           if (lambda p: p[3] > 200 and p[0] > 180 and p[1] < 100 and p[2] < 100)(source.getpixel((x, y)))}
    components = []
    while red:
        stack = [red.pop()]
        group = []
        while stack:
            x, y = stack.pop()
            group.append((x, y))
            for neighbor in [(x-1,y),(x+1,y),(x,y-1),(x,y+1)]:
                if neighbor in red:
                    red.remove(neighbor)
                    stack.append(neighbor)
        if len(group) >= 3:
            components.append(group)
    cheek = max(components, key=lambda g: (sum(x for x,y in g)/len(g), len(g)))
    cx = round(sum(x for x,y in cheek) / len(cheek))
    cy = round(sum(y for x,y in cheek) / len(cheek))
    yellow = lambda x,y: 0 <= x < 64 and 0 <= y < 64 and (lambda p: p[3]>200 and p[0]>200 and p[1]>160 and p[2]<100)(source.getpixel((x,y)))
    face = {(x,y) for y in range(max(0,cy-14),min(64,cy+8))
            for x in range(max(0,cx-10),min(64,cx+7))
            if yellow(x,y) and x >= cx-10+abs(y-cy)//5}
    arm_x = cx - 24
    arm_y = cy - 4 if state in [3,4,6] else cy + 10
    arm = {(x,y) for y in range(max(0,arm_y),min(64,arm_y+16))
           for x in range(max(0,arm_x),min(64,arm_x+10)) if yellow(x,y)}
    for region in [face, arm]:
        for x,y in region:
            edge = any((a,b) not in region and yellow(a,b)
                       for a,b in [(x-1,y),(x+1,y),(x,y-1),(x,y+1)])
            if edge:
                color = (64,79,96,255)
            elif (x + 2*y) % 11 == 0:
                color = (222,237,246,255)
            else:
                color = (160,179,194,255) if x % 7 < 4 else (113,137,156,255)
            frame.putpixel((x,y), color)
    # Tail pixels stay original in every pose, including the body junction.
    tail_mask = Image.new('L', (64, 64))
    if tail_regions[name]:
        ImageDraw.Draw(tail_mask).polygon(tail_regions[name], fill=255)
    # Cyan cheek sensor replaces only existing red pixels, keeping its shape.
    for x,y in cheek:
        border = any((a,b) not in cheek for a,b in [(x-1,y),(x+1,y),(x,y-1),(x,y+1)])
        frame.putpixel((x,y), (26,80,103,255) if border else (57,232,255,255))
    for x,y in arm:
        if x == arm_x+4 and (y-arm_y)%7 in [2,3,4] and not any((x+dx,y) not in arm for dx in [-1,1]):
            frame.putpixel((x,y),(57,232,255,255))
    frame.paste(source, (0, 0), tail_mask)
    assert frame.getchannel('A').tobytes() == source.getchannel('A').tobytes()
    changed = sum(a!=b for a,b in zip(source.getdata(),frame.getdata()))
    assert changed > 0
    sheet.paste(frame,(f['x']-meta['offset']['x'], f['y']-meta['offset']['y']))
    print(name, changed, 'edited pixels; original outline/alpha preserved')
output = IMAGES / 'skins/cyborg.png'
output.parent.mkdir(exist_ok=True)
sheet.save(output,optimize=True)
attachments = {name:{'head':{'x':0,'y':0},'neck':{'x':0,'y':0},'eyes':{'x':0,'y':0}} for name in meta['frames']}
(IMAGES / 'skins/cyborg.json').write_text(json.dumps({'size':meta['size'],'offset':meta['offset'],'attachments':attachments},indent=2)+'\n')
