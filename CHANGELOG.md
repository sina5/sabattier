# Changelog

This file lists all important changes to Sabattier. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-09-28

### Fixed

- macOS: Before this fix, macOS showed the message "Sabattier is damaged and can't be
  opened" for the app from GitHub. Now the full app bundle has an ad-hoc signature.
  Thus, macOS shows its usual warning for apps from unidentified developers. To open
  the app, click *Open Anyway* in *System Settings → Privacy & Security*.
- README: Added the procedure to open a copy of 0.1.0 that macOS shows as damaged.

## [0.1.0] - 2026-09-27

First release.

### Added

- Batch photo editing for macOS and Windows. You can import files or folders (RAW
  files included), copy edits to all photos and use *Auto enhance all*.
- Auto Enhance from the histogram. It puts its results in the usual sliders.
- Adjustments: white balance, light, hue and saturation, 3-way color balance, tone
  curve, color mixer, and effects and detail. All adjustments use the GPU and show a
  live histogram.
- Masks, healing, portrait retouch, lens blur and HDR merge.
- AI tools that run on the computer through ONNX Runtime: background removal, healing
  (LaMa), depth for lens blur, 2× and 4× upscaling on export, and face detection for
  the portrait tools.
- Culling with ratings, crop, undo and redo, zoom and pan, presets, watermark and an
  edit list.
- Export to high-quality JPEG (PNG for cutouts).
- Settings, with AI model management, backup and restore.
- Release builds for Windows x64 and macOS Apple Silicon. Each build has two
  versions. One version downloads the AI models on first use. The other version
  contains all the models.

[0.1.1]: https://github.com/sina5/sabattier/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sina5/sabattier/releases/tag/v0.1.0
