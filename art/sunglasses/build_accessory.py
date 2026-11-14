"""Optional manual helper for the native-resolution Sunglasses accessory PNG."""
from pathlib import Path
from PIL import Image, ImageDraw
import json
ROOT=Path(__file__).resolve().parents[2]
IMAGES=ROOT/'src/resources/assets/images'
meta=json.loads((IMAGES/'costumes/frames.json').read_text())
sheet=Image.new('RGBA',(meta['size']['w'],meta['size']['h']))
# Explicit reviewed eye bounds replace cheek/outline detection. Those heuristics
# can mistake ears or eyebrows for eyes in tilted front-facing frames.
reviewed=json.loads((ROOT/'art/sunglasses/eye_landmarks.json').read_text())
landmarks=reviewed['frames']
assert set(landmarks)==set(meta['frames'])
for name,info in meta['frames'].items():
    f=info['frame']
    eyes=landmarks[name]
    # Round upward for half-pixel centers so a 6px eye fits a 7px lens.
    fixed=reviewed.get('fixedLensCenters',{}).get(name)
    centers=fixed or [((left+right+1)//2,(top+bottom+1)//2) for left,top,right,bottom in eyes]
    # Dizzy pupils move inside stationary sockets: keep the glasses stationary
    # through that loop and use matching 9px lenses to cover the whole socket.
    half_height=4 if fixed else max(3,max((b-t+1)//2 for l,t,r,b in eyes))
    lenses=[(x,y,5,half_height) for x,y in centers]
    for (x,y,hw,hh),(l,t,r,b) in zip(lenses,eyes):
        assert x-hw <= l <= r <= x+hw and y-hh <= t <= b <= y+hh, name

    image=Image.new('RGBA',(64,64));draw=ImageDraw.Draw(image)
    # Arms/bridge first; each lens is a crisp dark frame with a small reflection.
    if len(centers)>1:draw.line([centers[0],centers[-1]],fill='#11131d',width=2)
    left=centers[0];right=centers[-1]
    draw.line([(max(0,left[0]-(10 if len(centers)==1 else 7)),left[1]-2),(left[0]-3,left[1]-1)],fill='#11131d',width=2)
    if len(centers)>1:draw.line([(right[0]+3,right[1]-1),(min(63,right[0]+7),right[1]-2)],fill='#11131d',width=2)
    for x,y,half_width,half_height in lenses:
        draw.rectangle((x-half_width,y-half_height,x+half_width,y+half_height),fill='#11131d')
        draw.rectangle((x-half_width+1,y-half_height+1,x+half_width-1,y+half_height-1),fill='#172b40')
        draw.rectangle((x-half_width+2,y-half_height+1,x-half_width+4,y-half_height+1),fill='#75a5c0')
        draw.line([(x-half_width+2,y-half_height+2),(x-half_width+3,y-half_height+3)],fill='#476c89',width=1)
        draw.line([(x-half_width+1,y+half_height-1),(x+half_width-1,y+half_height-1)],fill='#080e18',width=1)
    sheet.paste(image,(f['x']-meta['offset']['x'],f['y']-meta['offset']['y']))
    print(name,centers)
sheet.save(IMAGES/'costumes/sunglasses.png',optimize=True)
