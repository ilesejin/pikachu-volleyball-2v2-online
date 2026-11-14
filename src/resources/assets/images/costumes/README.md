# Editable accessory sprite sheets

- `cap.png` — head layer.
- `crown.png`, `headphones.png` — additional headwear.
- `bowtie.png` — alternative neckwear.
- `star-sunglasses.png` — star-shaped eyewear.
- `headband.png` — alternative head layer.
- `scarf.png` — neck layer.
- `sunglasses.png` — original dark rectangular eyewear.
- `round-glasses.png` — circular rims with fully transparent lens interiors.
- `triangle-sunglasses.png` — pointed black lenses with silver diagonal highlights.
All eyewear works independently with any headwear and either scarf or bow tie.

These transparent RGBA PNGs are the runtime artwork source, not generated build outputs. Each canvas is **476 × 262 pixels**: the common vertical crop of `../sprite_sheet.png` from **Y = 266 (inclusive) to Y = 528 (exclusive)**. All 28 complete Pikachu frame rectangles are preserved, including their internal transparent margins and spacing. The original 476 × 885 atlas is unchanged.

`frames.json` stores the cropped `size`, original atlas `sourceSize`, shared `offset` (`x: 0, y: 266`), and the 28 frame descriptors in their **original atlas coordinates**. The renderer samples each accessory at `originalFrameX - offset.x`, `originalFrameY - offset.y`. Do not repack or independently trim individual sheets or frames.

## Editing

1. Open a copy of `../sprite_sheet.png` in a pixel-art editor and crop the reference canvas to **X = 0, Y = 266, width = 476, height = 262**. Do not overwrite the original atlas. Lock the reference layer.
2. Import one accessory PNG as a separate layer at `(0, 0)` on this cropped canvas. Do not resize or move it. Alternatively, on the full original canvas, import the accessory at `(0, 266)`.
3. Edit only that accessory inside each original 64 × 64 Pikachu frame. In the cropped canvas, subtract 266 from the Y coordinates listed in `frames.json`. Check every pose, including dive, lying down, win and loss. Pixels outside a frame are not rendered for that animation.
4. Hide the reference layer and export only the accessory as an RGBA PNG with transparency. Preserve the **476 × 262** accessory canvas; disable further trimming, cropping, scaling, rotation and atlas repacking. If using the full original canvas, export only the same shared crop region. Do not flatten onto the Pikachu or a background.
5. Replace the corresponding PNG here and rebuild (`npm run build`). Both the game and replay viewer use the new artwork; the build hashes asset URLs to invalidate older cached images.

Layer order is selected skin body → neck (scarf OR bow tie) → head (cap, headband, crown OR headphones) → eyewear (sunglasses). Pikachu uses the original body; replacement skins and their per-frame accessory attachment offsets are documented in [../skins/README.md](../skins/README.md). Thus accessories can be combined without duplicating the body. Textures for all 28 frames are composed once and cached. The original sprites, frame geometry and physics are unchanged.

Selection metadata uses stable IDs: `classic`, `cap`, `headband`, `scarf`, `cap-scarf`, `headband-scarf`. Earlier saved choices and replay files still work. Replays store these IDs, not embedded PNGs, so replay playback uses the currently installed artwork.

Adding a new accessory also requires registering it and its valid combinations in `online_2v2/costumes.js`, `protocol.js`, the picker and translations; dropping an unregistered PNG into this folder alone will not add it to the catalog.


Eyewear is selected independently. Existing IDs remain unchanged; appearances with sunglasses append `-sunglasses` (for example `cap-scarf-sunglasses` or `cyborg-cap-scarf-sunglasses`). Sunglasses alone on the original skin use `sunglasses`. The optional `art/sunglasses/build_accessory.py` helper reproduces the initial native pixel drawing using explicitly reviewed eye coordinates in `art/sunglasses/eye_landmarks.json`. Normal builds load the saved PNG and never run that helper, so manual artwork edits are preserved. Running the helper intentionally overwrites the sunglasses PNG.


The new eyewear IDs are `round-glasses` and `triangle-sunglasses`. Combined appearance IDs append the chosen eyewear ID to the existing body/head/neck ID (for example `cyborg-cap-scarf-round-glasses`). Select exactly one eyewear option. `art/eyewear/build_new_styles.py` is an optional native-pixel exporter for the two new sheets, using the same reviewed eye positions and fixed dizzy-loop centers. It is not run by builds; running it manually intentionally overwrites those two PNGs. Edit the saved PNGs directly for custom artwork.


The four new accessories and corrected headband are exported by the optional `art/accessories/build_accessories.py` helper. It intentionally overwrites only `headband.png`, `crown.png`, `headphones.png`, `bowtie.png`, and `star-sunglasses.png`; normal builds never run it. Their pose/forehead/neck landmarks are in `art/accessories/fit_landmarks.json`. Keep a copy of hand-edited PNGs before using any exporter. Each requested outfit is cached on first use rather than prebuilding the entire growing catalog.

For selective exports, pass `--style bowtie` (or another supported style) to `art/accessories/build_accessories.py`; only that PNG and its fit landmarks are updated. The bow tie uses narrower profile loops anchored below the chin in side-view poses.

The hand-edited scarf silhouette, arm cutouts and removed tails are preserved. `art/scarf/scarf-before-cleanup.png` backs up the artwork before the targeted artifact cleanup; `cleanup_report.json` lists every changed pixel. The optional `art/scarf/clean_artifacts.py` reproduces that cleanup from the backup, not from later edits. Normal builds never run it; do not use it to overwrite subsequent hand edits.
