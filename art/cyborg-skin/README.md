# Cyborg Pikachu pixel edits

This skin was made by editing original game pixels directly, as requested. It is not generated replacement artwork.

Runtime asset: `src/resources/assets/images/skins/cyborg.png`.

Optional helper: run `python art/cyborg-skin/build_skin.py` from the repository root (requires Pillow). It recolors selected yellow pixels as silver plates, changes one existing red cheek into a cyan sensor, and adds short cyan circuit details. Original alpha masks, black outlines and all animation poses are preserved. The source atlas is read only.

Normal builds load the saved PNG; this helper is never run automatically. Running it intentionally overwrites the cyborg PNG and resets its accessory offsets, so preserve any hand edits first.

The tail stays in its original Pikachu colors across poses. Reviewed protected regions are stored in `tail_regions.json`; the exporter restores those source pixels after drawing mechanical panels. `python art/cyborg-skin/clean_tail.py` applies only this tail cleanup to the existing PNG, preserving all other edits. The prior skin is backed up in `cyborg-before-tail-fix.png`.
