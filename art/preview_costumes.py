"""Render saved costume PNGs as a contact sheet; never changes game assets.

Run from any directory. Relative output paths are relative to the repository.
Requires Pillow: python -m pip install -r art/requirements.txt
"""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / 'src/resources/assets/images'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skin', choices=['pikachu', 'cyborg'], default='pikachu')
    parser.add_argument('--head', choices=['none', 'cap', 'headband', 'crown', 'headphones'], default='none')
    parser.add_argument('--neck', choices=['none', 'scarf', 'bowtie'], default='none')
    parser.add_argument('--eyes', choices=['none', 'sunglasses', 'round-glasses', 'triangle-sunglasses', 'star-sunglasses'], default='none')
    parser.add_argument('--scale', type=int, choices=range(1, 9), default=3)
    parser.add_argument('--columns', type=int, choices=range(1, 15), default=7)
    parser.add_argument('--mirror', action='store_true', help='Preview the right-side player orientation.')
    parser.add_argument('--output', type=Path, default=Path('.test-artifacts/costume-preview.png'))
    args = parser.parse_args()
    if args.output.suffix.lower() != '.png':
        parser.error('--output must be a PNG file')
    layout = json.loads((IMAGES / 'costumes/frames.json').read_text(encoding='utf-8'))
    skin_layout = None
    if args.skin == 'pikachu':
        body = Image.open(IMAGES / 'sprite_sheet.png').convert('RGBA')
        body_offset = {'x': 0, 'y': 0}
    else:
        body = Image.open(IMAGES / 'skins' / (args.skin + '.png')).convert('RGBA')
        skin_layout = json.loads((IMAGES / 'skins' / (args.skin + '.json')).read_text(encoding='utf-8'))
        body_offset = skin_layout['offset']
    # Same composition order and per-frame attachments as the runtime.
    layers = [(category, Image.open(IMAGES / 'costumes' / (part + '.png')).convert('RGBA'))
              for category, part in [('neck', args.neck), ('head', args.head), ('eyes', args.eyes)]
              if part != 'none']
    scale = args.scale
    cell_w, cell_h = 64 * scale + 16, 64 * scale + 36
    frames = list(layout['frames'].items())
    rows = (len(frames) + args.columns - 1) // args.columns
    output = Image.new('RGB', (cell_w * args.columns, cell_h * rows + 24), '#929292')
    draw = ImageDraw.Draw(output)
    title = ' / '.join([args.skin, args.head, args.neck, args.eyes])
    draw.text((8, 6), title + (' (mirrored)' if args.mirror else ''), fill='white')
    for index, (name, info) in enumerate(frames):
        f = info['frame']
        x, y, w, h = f['x'], f['y'], f['w'], f['h']
        bx, by = x - body_offset['x'], y - body_offset['y']
        frame = body.crop((bx, by, bx + w, by + h))
        for category, sheet in layers:
            sx, sy = x - layout['offset']['x'], y - layout['offset']['y']
            accessory = sheet.crop((sx, sy, sx + w, sy + h))
            offset = skin_layout['attachments'][name][category] if skin_layout else {'x': 0, 'y': 0}
            frame.alpha_composite(accessory, (offset['x'], offset['y']))
        if args.mirror:
            frame = ImageOps.mirror(frame)
        px, py = (index % args.columns) * cell_w + 8, (index // args.columns) * cell_h + 24
        draw.text((px, py), f"{index}: {Path(name).stem}", fill='white')
        frame = frame.resize((w * scale, h * scale), Image.Resampling.NEAREST)
        output.paste(frame, (px, py + 20), frame)
    target = args.output if args.output.is_absolute() else ROOT / args.output
    target.parent.mkdir(parents=True, exist_ok=True)
    output.save(target)
    # Do not print machine-specific absolute paths.
    print(f'Preview saved: {args.output.as_posix()} ({len(frames)} poses)')


if __name__ == '__main__':
    main()
