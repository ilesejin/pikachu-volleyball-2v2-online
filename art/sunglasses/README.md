# Sunglasses pixel artwork

Runtime asset: `src/resources/assets/images/costumes/sunglasses.png` (transparent 476 × 262 PNG, 28 poses).

This accessory is drawn with native-resolution pixel shapes in the existing accessory style. It uses one visible lens in side poses and two lenses in front-facing poses, matched to the reviewed original eye bounds in `eye_landmarks.json`. The tilted win/loss poses use their actual eyes rather than cheek/outline estimates. The dizzy-pupil loop keeps the lenses stationary relative to the head. Eyewear is independent of headwear, neckwear and body skin. Layer order is body → neck → head → eyewear.

You can edit the PNG directly. An optional helper reproduces the initial artwork: `python art/sunglasses/build_accessory.py` (requires Pillow). Normal builds never run the helper; running it intentionally overwrites the PNG. It reads the unchanged original atlas and frame metadata, and writes only the sunglasses accessory sheet. Preserve any manual edits before using it.
