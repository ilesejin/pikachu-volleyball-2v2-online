# Character skins

`cyborg.png` is the selectable **Cyborg Pikachu** body: the original yellow Pikachu with silver mechanical face/arm panels and cyan sensor details. It is a direct pixel edit, not AI-generated replacement artwork. Each of the 28 frames preserves the original alpha mask, silhouette, pose and black outlines. The original atlas remains unchanged.

The canvas is **476 × 262**, sharing the accessory atlas geometry and `(0, 266)` crop offset. Original frame rectangles are listed in `../costumes/frames.json`. This PNG contains the complete character; the renderer does not draw another Pikachu body beneath it. All headwear/scarf/sunglasses combinations work with either skin. Switching skin preserves accessory choices.

## Editing

- Edit `cyborg.png` directly with a pixel pencil, keeping its transparency, canvas dimensions, all 28 frame rectangles and 64 × 64 local origins. Use the [accessory guide](../costumes/README.md) to prepare a cropped original reference.
- `cyborg.json` stores head/neck/eyes accessory offsets keyed by original frame names. They are all `(0, 0)` for Cyborg Pikachu, because the original geometry is preserved. Positive X moves an accessory right; positive Y moves it down. Keep shifted artwork inside its 64 × 64 frame.
- Layer order is selected body → neck → head → eyewear. Accessories reuse the same PNGs on both bodies; neither the skin nor its accessories affect physics, collision bounds, AI, inputs or RNG.
- Rebuild with `npm run build` to update both game and replay viewer. Art uses content-hashed URLs. Replays retain appearance IDs and use the currently installed artwork.
- `art/cyborg-skin/build_skin.py` is an optional, manually run Python/Pillow helper that reproduces the initial pixel edits from the original atlas. Normal builds never run it, so editing this PNG by hand is safe. Running the helper intentionally overwrites this PNG and resets attachment offsets.

Stable new appearance IDs are `cyborg`, `cyborg-cap`, `cyborg-headband`, `cyborg-scarf`, `cyborg-cap-scarf`, `cyborg-headband-scarf`. Earlier Pikachu appearance IDs, saved choices and replays remain compatible. Empty AI positions still use Classic; automatic AI-skin assignment is left for a future change. An AI replacing a disconnected player keeps that player's existing appearance.

The separate computer character was kept for future use in `art/computer-skin/`: original generated source, prepared 476 × 262 PNG, attachment offsets and generation prompt. Those files are archived artwork, not selectable or loaded by the game.

Adding another skin requires registering its asset, appearance IDs, picker entry and translations. Add attachment offsets when its anatomy differs from Pikachu. Dropping in an unregistered PNG alone does not add a selectable character.


Sunglasses are a separate Eyewear category and can be worn with every existing outfit. `eyes` in the per-frame attachment metadata controls their offset; it is `(0, 0)` for Cyborg Pikachu. New appearance IDs add a `-sunglasses` suffix while preserving all earlier IDs.
