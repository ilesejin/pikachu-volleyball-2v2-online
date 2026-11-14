"""Clean only reviewed scarf artifacts; preserve the user's silhouette/cutouts."""
from pathlib import Path
from PIL import Image
import json,hashlib
ROOT=Path(__file__).resolve().parents[2]
IMAGES=ROOT/'src/resources/assets/images'
backup=ROOT/'art/scarf/scarf-before-cleanup.png'
image=Image.open(backup).convert('RGBA')
meta=json.loads((IMAGES/'costumes/frames.json').read_text())
# Inclusive local-frame rectangles containing reviewed, detached leftovers.
remove={11:[(42,34,42,34)],16:[(39,49,42,50)],23:[(25,30,28,34)],25:[(22,32,25,35),(25,62,30,62)],26:[(22,32,25,35)],27:[(23,32,26,35)]}
cutout_frames={6,7,8,10,11,12,13}
outline=(59,24,53,255)
report={}
for index,(name,info) in enumerate(meta['frames'].items()):
    f=info['frame'];left=f['x'];top=f['y']-meta['offset']['y']
    frame=image.crop((left,top,left+64,top+64));before=frame.copy();removed=[];recolored=[]
    for x0,y0,x1,y1 in remove.get(index,[]):
        for y in range(y0,y1+1):
            for x in range(x0,x1+1):
                if frame.getpixel((x,y))[3]:
                    removed.append([x,y]);frame.putpixel((x,y),(0,0,0,0))
    # Re-outline only thick cutout boundaries. Do not close any arm holes,
    # alter the collar shape, or repaint the deliberately thin curved collars.
    if index in cutout_frames:
        mask=frame.getchannel('A')
        for y in range(1,63):
            for x in range(1,63):
                pixel=frame.getpixel((x,y))
                if not pixel[3] or pixel==outline:continue
                boundary=any(not mask.getpixel((a,b)) for a,b in [(x-1,y),(x+1,y),(x,y-1),(x,y+1)])
                support=sum(mask.getpixel((x+dx,y+dy))>0 for dy in [-1,0,1] for dx in [-1,0,1])
                if boundary and support>=5:
                    frame.putpixel((x,y),outline);recolored.append([x,y])
    # Never add scarf pixels where the user erased them.
    assert all(not after or prior for prior,after in zip(before.getchannel('A').getdata(),frame.getchannel('A').getdata()))
    image.paste(frame,(left,top))
    if removed or recolored:report[name]={'removed':removed,'reoutlined':recolored}
image.save(IMAGES/'costumes/scarf.png',optimize=True)
summary={'originalSHA256':hashlib.sha256(backup.read_bytes()).hexdigest(),'frames':report,'removedPixels':sum(len(v['removed']) for v in report.values()),'reoutlinedPixels':sum(len(v['reoutlined']) for v in report.values())}
(ROOT/'art/scarf/cleanup_report.json').write_text(json.dumps(summary,indent=2)+'\n')
print('Removed',summary['removedPixels'],'orphan pixels; re-outlined',summary['reoutlinedPixels'],'boundary pixels. No filled cutouts or added pixels.')
