"""Optional manual exporter for clear round and pointed triangular glasses."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageChops
import json, math, argparse
ROOT=Path(__file__).resolve().parents[2]
IMAGES=ROOT/'src/resources/assets/images'
meta=json.loads((IMAGES/'costumes/frames.json').read_text())
reviewed=json.loads((ROOT/'art/sunglasses/eye_landmarks.json').read_text())
parser=argparse.ArgumentParser()
parser.add_argument('--style',choices=['round-glasses','triangle-sunglasses'])
args=parser.parse_args()
styles=[args.style] if args.style else ['round-glasses','triangle-sunglasses']
sheets={style:Image.new('RGBA',(meta['size']['w'],meta['size']['h'])) for style in styles}
for name,info in meta['frames'].items():
    eyes=reviewed['frames'][name]
    fixed=reviewed.get('fixedLensCenters',{}).get(name)
    centers=fixed or [((l+r+1)//2,(t+b+1)//2) for l,t,r,b in eyes]
    radius=6 if fixed else 5
    for style,sheet in sheets.items():
        image=Image.new('RGBA',(64,64));draw=ImageDraw.Draw(image)
        if style=='round-glasses':
            if len(centers)>1:
                (x1,y1),(x2,y2)=centers;distance=math.hypot(x2-x1,y2-y1)
                if distance>radius*2:
                    ux=(x2-x1)/distance;uy=(y2-y1)/distance
                    draw.line([(round(x1+ux*radius),round(y1+uy*radius)),(round(x2-ux*radius),round(y2-uy*radius))],fill='#243348',width=1)
            left,right=centers[0],centers[-1]
            draw.line([(max(0,left[0]-radius-6),left[1]-2),(left[0]-radius,left[1]-1)],fill='#243348',width=1)
            if len(centers)>1:draw.line([(right[0]+radius,right[1]-1),(min(63,right[0]+radius+4),right[1]-2)],fill='#243348',width=1)
            for x,y in centers:
                box=(x-radius,y-radius,x+radius,y+radius)
                # Deliberately no fill: eyes and skin remain visible through glass.
                draw.ellipse(box,outline='#243348',width=1)
                draw.arc(box,205,255,fill='#91b7c5',width=1)
            for x,y in centers:assert image.getpixel((x,y))[3]==0, name
        else:
            if len(centers)>1:draw.line(centers,fill='#080a10',width=2)
            left,right=centers[0],centers[-1]
            draw.line([(max(0,left[0]-8),left[1]-3),(left[0]-5,left[1]-2)],fill='#080a10',width=2)
            if len(centers)>1:draw.line([(right[0]+5,right[1]-2),(min(63,right[0]+8),right[1]-3)],fill='#080a10',width=2)
            for index,(x,y) in enumerate(centers):
                # Outward raised tips, deep lower corners and a silver diagonal
                # reflection match the bold triangular silhouette of the reference.
                direction=-1 if index==0 else 1
                # Keep the compact lenses slightly deeper for the larger dizzy eyes.
                bottom=8 if fixed else 6
                points=[(x+direction*7,y-6),(x-direction*7,y-3),(x+direction*2,y+bottom)]
                draw.polygon(points,fill='#080a10')
                mask=Image.new('L',(64,64));ImageDraw.Draw(mask).polygon(points,fill=255)
                shine=Image.new('RGBA',(64,64));sd=ImageDraw.Draw(shine)
                sd.polygon([(x+direction*4,y-4),(x+direction*2,y-3),(x-direction*1,y+3),(x+direction*1,y+2)],fill='#9aa4b3')
                shine.putalpha(ImageChops.multiply(shine.getchannel('A'),mask))
                image=Image.alpha_composite(image,shine);draw=ImageDraw.Draw(image)
        f=info['frame'];sheet.paste(image,(f['x']-meta['offset']['x'],f['y']-meta['offset']['y']))
for style,sheet in sheets.items():sheet.save(IMAGES/'costumes'/(style+'.png'),optimize=True)
