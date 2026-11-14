# Editable accessory sprite sheets

- `cap.png` — head layer.
- `headband.png` — alternative head layer.
- `scarf.png` — neck layer.

These transparent RGBA PNGs are the runtime artwork source, not generated build outputs. Each canvas is **476 × 262 pixels**: the common vertical crop of `../sprite_sheet.png` from **Y = 266 (inclusive) to Y = 528 (exclusive)**. All 28 complete Pikachu frame rectangles are preserved, including their internal transparent margins and spacing. The original 476 × 885 atlas is unchanged.

`frames.json` stores the cropped `size`, original atlas `sourceSize`, shared `offset` (`x: 0, y: 266`), and the 28 frame descriptors in their **original atlas coordinates**. The renderer samples each accessory at `originalFrameX - offset.x`, `originalFrameY - offset.y`. Do not repack or independently trim individual sheets or frames.

## Editing

1. Open a copy of `../sprite_sheet.png` in a pixel-art editor and crop the reference canvas to **X = 0, Y = 266, width = 476, height = 262**. Do not overwrite the original atlas. Lock the reference layer.
2. Import one accessory PNG as a separate layer at `(0, 0)` on this cropped canvas. Do not resize or move it. Alternatively, on the full original canvas, import the accessory at `(0, 266)`.
3. Edit only that accessory inside each original 64 × 64 Pikachu frame. In the cropped canvas, subtract 266 from the Y coordinates listed in `frames.json`. Check every pose, including dive, lying down, win and loss. Pixels outside a frame are not rendered for that animation.
4. Hide the reference layer and export only the accessory as an RGBA PNG with transparency. Preserve the **476 × 262** accessory canvas; disable further trimming, cropping, scaling, rotation and atlas repacking. If using the full original canvas, export only the same shared crop region. Do not flatten onto the Pikachu or a background.
5. Replace the corresponding PNG here and rebuild (`npm run build`). Both the game and replay viewer use the new artwork; the build hashes asset URLs to invalidate older cached images.

Layer order is original Pikachu → neck (scarf) → head (cap OR headband). Thus accessories can be combined without duplicating the body. Textures for all 28 frames are composed once and cached. The original sprites, frame geometry and physics are unchanged.

Selection metadata uses stable IDs: `classic`, `cap`, `headband`, `scarf`, `cap-scarf`, `headband-scarf`. Earlier saved choices and replay files still work. Replays store these IDs, not embedded PNGs, so replay playback uses the currently installed artwork.

Adding a new accessory also requires registering it and its valid combinations in `online_2v2/costumes.js`, `protocol.js`, the picker and translations; dropping an unregistered PNG into this folder alone will not add it to the catalog.
