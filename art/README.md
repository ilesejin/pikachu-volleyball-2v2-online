# Costume artwork previews

Install the Python image dependency once, then run from the repository root:

```sh
python -m pip install -r art/requirements.txt
python art/preview_costumes.py --neck scarf
python art/preview_costumes.py --neck bowtie --mirror --output .test-artifacts/bowtie-right.png
python art/preview_costumes.py --skin cyborg --head crown --neck bowtie --eyes round-glasses --output .test-artifacts/cyborg-outfit.png
```

Each PNG shows all 28 poses at nearest-neighbor pixel scale, with frame names. Use `--mirror` to inspect the right-side orientation, `--scale 1` through `8` to change magnification, and `--columns` to change the layout. Run `python art/preview_costumes.py --help` for available items.

The preview reads the actual saved skin/accessory PNGs and frame/attachment metadata, using the game's body → neck → head → eyewear order. It never runs an artwork exporter or modifies game assets. This is a static artwork preview, without in-game tint, player markers or animation timing.

All input paths are resolved relative to this script's repository, so it can also be run from another working directory. Relative `--output` paths are relative to the repository. The default output goes into the ignored `.test-artifacts/` folder. No machine-specific paths are stored in the script.
