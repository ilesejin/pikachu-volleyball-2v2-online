# Fitted accessories and headband correction

Editable runtime PNGs in `src/resources/assets/images/costumes/`:

- `crown.png`: small gold crown with a red jewel, following the head tilt and resting on the skull rather than the ear during dives.
- `headphones.png`: purple earcups and a connected headband, with one visible cup in profile and two in front-facing poses.
- `bowtie.png`: pink bow tie at a reviewed neck/chest position for every pose.
- `star-sunglasses.png`: gold-rimmed five-point stars with opaque dark lenses and pale reflections.
- `headband.png`: corrected blue band. It follows the forehead slope, is clipped to the original silhouette, and attaches its ties to the actual back edge. It no longer uses a horizontal cheek-based estimate.

All sheets are transparent 476 × 262 PNGs with the original 28 frame rectangles and shared `(0, 266)` crop offset. Both skins share the original geometry, so no different offsets are required. `fit_landmarks.json` records the per-pose forehead paths, crown bases, headphone cup locations and bow-tie anchors. Eyes use the reviewed `art/sunglasses/eye_landmarks.json` positions, including stable centers in the dizzy loop.

The optional manual exporter is `python art/accessories/build_accessories.py` (requires Pillow). It overwrites the five files above and updates the fit metadata. It checks that head/neckwear does not cover any original eye pixels and that star lenses do cover those pixels. Normal builds load the saved PNGs and never run exporters, so manual edits are preserved. Back up hand edits before re-exporting.

Headwear choices are mutually exclusive; so are neckwear and eyewear choices. Different categories can be combined. All previous appearance IDs are preserved. English/Korean/Traditional Chinese outfit captions translate each item separately. Outfits are composed and cached on first use; the catalog's unused combinations do not allocate thousands of textures during startup. Cosmetics never change physics, collision geometry, AI or RNG.

`python art/accessories/build_cap.py` selectively exports the red cap using pose-specific skull anchors and forehead tilt, with placement recorded in `cap_landmarks.json`. The pre-adjustment PNG is preserved as `cap-before-position-fix.png`. Builds never run this exporter.
