# Changelog

All notable changes to Sabattier are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First release.

### Added

- Batch photo editing for macOS and Windows: import files or folders (RAW included),
  copy edits to all photos, and *Auto enhance all*.
- Histogram-driven Auto Enhance, with its results placed in the normal sliders.
- Adjustments: white balance, light, hue and saturation, 3-way color balance, tone
  curve, color mixer, effects and detail, all GPU-accelerated with a live histogram.
- Masks, healing, portrait retouching, lens blur and HDR merge.
- AI tools that run on the computer through ONNX Runtime: background removal, healing
  (LaMa), depth for lens blur, 2×/4× upscaling on export, and face finding for the
  portrait tools.
- Culling with ratings, crop, undo/redo, zoom and pan, presets, watermark and an edit list.
- Export to high-quality JPEG (PNG for cutouts).
- Settings with AI model management and backup & restore.
- Release builds for Windows x64 and macOS Apple Silicon, each in two versions: one
  that downloads AI models on first use and one with every model included.

[0.1.0]: https://github.com/sina5/sabattier/releases/tag/v0.1.0
