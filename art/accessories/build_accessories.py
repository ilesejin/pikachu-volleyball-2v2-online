"""Optional native pixel exporter for new accessories and the fitted headband."""
from pathlib import Path
from PIL import Image,ImageDraw,ImageChops
import math,json,argparse
ROOT=Path(__file__).resolve().parents[2]
IMAGES=ROOT/'src/resources/assets/images'
meta=json.loads((IMAGES/'costumes/frames.json').read_text())
reviewed=json.loads((ROOT/'art/sunglasses/eye_landmarks.json').read_text())
base=Image.open(IMAGES/'sprite_sheet.png').convert('RGBA')
parser=argparse.ArgumentParser()
parser.add_argument('--style',choices=['headband','crown','headphones','bowtie','star-sunglasses'])
args=parser.parse_args()
styles=[args.style] if args.style else ['headband','crown','headphones','bowtie','star-sunglasses']
sheets={style:Image.new('RGBA',(476,262)) for style in styles}
neck_points=[(55,35),(55,36),(54,37),(55,36),(55,35),(55,39),(55,38),(55,38),(56,39),(55,40),(55,39),(55,39),(55,39),(56,38),(54,39),(48,52),(49,52),(48,60),(27,40),(32,37),(28,36),(26,35),(33,42),(41,41),(42,40),(25,54),(25,54),(26,54)]
fit={}
def bezier(a,b,c):
 return [(round((1-t)**2*a[0]+2*(1-t)*t*b[0]+t*t*c[0]),round((1-t)**2*a[1]+2*(1-t)*t*b[1]+t*t*c[1])) for t in [i/24 for i in range(25)]]
def star(x,y,outer,inner):
 return [(round(x+math.cos(-math.pi/2+i*math.pi/5)*(outer if i%2==0 else inner)),round(y+math.sin(-math.pi/2+i*math.pi/5)*(outer if i%2==0 else inner))) for i in range(10)]
for index,(name,info) in enumerate(meta['frames'].items()):
 f=info['frame'];source=base.crop((f['x'],f['y'],f['x']+64,f['y']+64))
 eyes=reviewed['frames'][name];fixed=reviewed.get('fixedLensCenters',{}).get(name)
 centers=fixed or [((l+r+1)//2,(t+b+1)//2) for l,t,r,b in eyes]
 if len(centers)==1:
  ex,ey=centers[0];path=[(ex-23,ey-5),(ex-14,ey-6),(ex+3,ey-6)]
  if index==9:path=[(30,9),(40,13),(54,16)]
  if index in [15,16,17]:path=[(ex-22,ey-8),(ex-10,ey-8),(ex+3,ey-6)]
  hx=ex-10
 else:
  (x1,y1),(x2,y2)=centers;length=math.hypot(x2-x1,y2-y1);ux=(x2-x1)/length;uy=(y2-y1)/length
  path=[(round(x1-ux*7),round(y1-uy*7-7)),(round((x1+x2)/2),round((y1+y2)/2-7)),(round(x2+ux*7),round(y2+uy*7-7))]
  hx=round((x1+x2)/2)
 hx=max(10,min(53,hx))
 start=centers[0][1]-8 if index in [15,16] else 0
 top=min(y for y in range(max(0,start),64) if source.getpixel((hx,y))[3]>200)
 theta=math.atan2(path[-1][1]-path[0][1],path[-1][0]-path[0][0])
 fit[name]={'headbandPath':path,'crownBase':[hx,top+1],'neck':list(neck_points[index])}
 for style,sheet in sheets.items():
  im=Image.new('RGBA',(64,64));d=ImageDraw.Draw(im)
  if style=='headband':
   d.line(path,fill='#17283f',width=5);d.line(path,fill='#2eaae6',width=3)
   d.line([(x,y-1) for x,y in path],fill='#b9efff',width=1)
   im.putalpha(ImageChops.multiply(im.getchannel('A'),source.getchannel('A')))
   # Tie ends attach to the first actual band pixel, not to an off-head estimate.
   pixels=[(x,y) for y in range(64) for x in range(64) if im.getpixel((x,y))[3]]
   ax=min(x for x,y in pixels);ay=round(sum(y for x,y in pixels if x==ax)/sum(x==ax for x,y in pixels))
   d=ImageDraw.Draw(im);d.line([(ax,ay),(max(0,ax-5),ay+3)],fill='#17283f',width=3);d.line([(ax,ay),(max(0,ax-5),ay+3)],fill='#2995d6',width=1)
   d.line([(ax,ay+1),(max(0,ax-3),ay+6)],fill='#17283f',width=2);d.point((ax,ay),fill='#b9efff')
  elif style=='crown':
   cy=top+1;h=min(7,max(3,cy-1))
   def rotate(points):return [(max(0,min(63,round(hx+x*math.cos(theta)-y*math.sin(theta)))),max(0,min(63,round(cy+x*math.sin(theta)+y*math.cos(theta))))) for x,y in points]
   shape=[(-9,1),(-9,-h),(-4,-h+3),(0,-h-1),(4,-h+3),(9,-h),(9,1)]
   d.polygon(rotate(shape),fill='#523715');d.polygon(rotate([(-8,0),(-8,-h+2),(-4,-h+4),(0,-h+1),(4,-h+4),(8,-h+2),(8,0)]),fill='#f8c449')
   d.line(rotate([(-7,-1),(7,-1)]),fill='#fff0a3',width=1);d.polygon(rotate([(-1,-3),(1,-3),(1,-1),(-1,-1)]),fill='#e3455e')
  elif style=='headphones':
   if len(centers)==1:
    ex,ey=centers[0];cups=[(max(4,ex-19),ey+1)];arc=bezier(cups[0],(ex-22,max(0,top-6)),(ex+2,ey-7))
   else:
    cups=[(max(3,centers[0][0]-9),centers[0][1]+2),(min(59,centers[1][0]+9),centers[1][1]+2)];arc=bezier(cups[0],(hx,max(0,top-10)),cups[1])
   d.line(arc,fill='#1d1c35',width=3);d.line(arc,fill='#7263be',width=1)
   for x,y in cups:
    d.rounded_rectangle((x-4,y-6,x+4,y+6),radius=2,fill='#1d1c35');d.rectangle((x-2,y-4,x+2,y+4),fill='#8b73cf');d.line((x-2,y-3,x-2,y+2),fill='#a8f4ef',width=1)
   fit[name]['headphoneCups']=[list(p) for p in cups]
  elif style=='bowtie':
   x,y=neck_points[index]
   if index<18:
    # In profile the knot sits at the front of the throat, with foreshortened
    # loops; do not stamp a wide frontal bow onto the shoulder/chest.
    d.polygon([(x-5,y-3),(x-1,y-1),(x-1,y+1),(x-5,y+3)],fill='#41172c')
    d.polygon([(x+2,y-2),(x+3,y-2),(x+3,y+2),(x+2,y+1)],fill='#41172c')
    d.polygon([(x-4,y-1),(x-2,y),(x-4,y+1)],fill='#ee5484')
    d.rectangle((x,y-2,x+1,y+2),fill='#f798b6')
   else:
    d.polygon([(x-7,y-4),(x-1,y-1),(x-1,y+1),(x-7,y+4)],fill='#41172c');d.polygon([(x+7,y-4),(x+1,y-1),(x+1,y+1),(x+7,y+4)],fill='#41172c')
    d.polygon([(x-6,y-2),(x-2,y),(x-6,y+2)],fill='#f15a89');d.polygon([(x+6,y-2),(x+2,y),(x+6,y+2)],fill='#d73469');d.rectangle((x-1,y-2,x+1,y+2),fill='#f798b6')
   fit[name]['bowtieFacing']='profile' if index<18 else 'front'

  else:
   if len(centers)>1:d.line(centers,fill='#32203d',width=2)
   for x,y in centers:
    d.polygon(star(x,y,9,4.5),fill='#32203d');d.polygon(star(x,y,8,3.8),fill='#f6c04b');d.polygon(star(x,y,6.7,2.8),fill='#24263e');d.line((x-3,y-2,x-1,y-2),fill='#a5e5e8',width=1)
  # Refuse exports that hide an eye with head/neckwear or leave an eye
  # exposed through opaque star lenses. These checks use the original pixels.
  for left,upper,right,lower in eyes:
   for yy in range(upper,lower+1):
    for xx in range(left,right+1):
     pixel=source.getpixel((xx,yy))
     if pixel[3]>200 and (max(pixel[:3])<80 or min(pixel[:3])>200):
      assert bool(im.getpixel((xx,yy))[3]) == (style=='star-sunglasses'), (style,name,xx,yy)
  sheet.paste(im,(f['x']-meta['offset']['x'],f['y']-meta['offset']['y']))
for style,sheet in sheets.items():sheet.save(IMAGES/'costumes'/(style+'.png'),optimize=True)
fit_path=ROOT/'art/accessories/fit_landmarks.json'
if args.style and fit_path.exists():
 previous=json.loads(fit_path.read_text())['frames']
 fields={'headband':['headbandPath'],'crown':['crownBase'],'headphones':['headphoneCups'],'bowtie':['neck','bowtieFacing'],'star-sunglasses':[]}[args.style]
 for name,entry in fit.items():
  for field in fields:previous[name][field]=entry[field]
 fit=previous
fit_path.write_text(json.dumps({'frames':fit},indent=2)+'\n')
