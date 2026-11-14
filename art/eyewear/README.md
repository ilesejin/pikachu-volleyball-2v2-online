# Additional eyewear styles

Runtime assets, each a transparent **476 × 262** PNG with the original 28 frame rectangles:

- `src/resources/assets/images/costumes/round-glasses.png`: circular rims with no lens fill. Eye pixels remain visible through the genuinely transparent interiors. Bridges and temples stop at the rims instead of crossing through the lens centers.
- `src/resources/assets/images/costumes/triangle-sunglasses.png`: oversized pointed black triangular lenses with silver diagonal highlights, following the user's reference style. The outward tips are raised; each eye is covered by its lens.

Both styles use `art/sunglasses/eye_landmarks.json`, including fixed lens centers for the dizzy-pupil loop. The two styles are mutually exclusive eyewear choices and can be combined with either skin, either headwear option and a scarf. All previous appearance IDs remain valid.

Optional manual exporter: `python art/eyewear/build_new_styles.py` (requires Pillow). It intentionally overwrites only these two PNGs. Normal game builds never run this helper, so manual edits are preserved. Assets are loaded directly from the saved PNGs and composed once on first use and cached. Frame geometry, collisions and physics are unchanged.

To regenerate only one style, add `--style triangle-sunglasses` or `--style round-glasses`. The triangular lenses use a slightly reduced silhouette while retaining the reviewed eye centers and coverage in every pose.
