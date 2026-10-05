# Sabattier

Sabattier is a fast photo color editor for macOS and Windows. It edits a batch of
photos at the same time. With Sabattier, you can:

1. Import a folder of photos. RAW camera files are also possible.
2. Adjust the light with Pixelmator-style adjustments, or with **Auto Enhance**.
   Auto Enhance uses the histogram of each photo.
3. Export all the photos as high-quality JPEG files.

![version](https://img.shields.io/badge/version-0.1.1-blue)

For the changes in each release, refer to [CHANGELOG.md](CHANGELOG.md).

![Sabattier with a portrait's background removed](images/screenshots/02-remove-background-light.png)

## Download

Download the latest installer from the
[releases page](https://github.com/sina5/sabattier/releases/latest):

| System | Standard installer | Installer with all AI models |
| --- | --- | --- |
| Windows (64-bit) | `Sabattier-<version>-windows-x64.setup.exe` | `…-windows-x64-with-models.setup.exe` |
| macOS (Apple Silicon) | `Sabattier-<version>-macos-arm64.dmg` | `…-macos-arm64-with-models.dmg` |

The standard installer is small. It downloads each AI model when you use the related
tool for the first time. The *with models* installer is approximately 575 MB larger.
It operates without an internet connection from the start.

The installers do not have a code signature at this time. Thus, your system shows a
warning when you open the app for the first time.

On Windows, do these steps:

1. In the SmartScreen dialog, click *More info*.
2. Click *Run anyway*.

On macOS, if the system blocks the app, do these steps:

1. Open *System Settings → Privacy & Security*.
2. Click *Open Anyway*.

On macOS, if the system shows the message "is damaged and can't be opened", do these
steps:

1. In Terminal, run this command:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Sabattier.app
   ```

2. Open the app again.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="images/screenshots/01-face-select-dark.png" alt="Face skin mask on one of two faces"></td>
    <td width="50%"><img src="images/screenshots/04-background-mask-light.png" alt="Background mask darkened around two subjects"></td>
  </tr>
  <tr>
    <td><b>Face masks</b> — Select a face. Then edit only its skin, eyes, lips or teeth.</td>
    <td><b>Background mask</b> — Make all areas behind the subject darker, or change their color.</td>
  </tr>
  <tr>
    <td><img src="images/screenshots/03-crop-dark.png" alt="Crop to 4:5 with aspect presets"></td>
    <td><img src="images/screenshots/05-portrait-retouch-dark.png" alt="Portrait tools and simple adjustments"></td>
  </tr>
  <tr>
    <td><b>Crop</b> — Use a free ratio or a fixed ratio, for example 1:1, 4:5 or 16:9.</td>
    <td><b>Portrait retouch</b> — Make skin smooth, make eyes brighter and make teeth whiter.</td>
  </tr>
  <tr>
    <td><img src="images/screenshots/06-rate-and-pick-light.png" alt="Star ratings on photos in the filmstrip"></td>
    <td><img src="images/screenshots/07-export-dark.png" alt="Save dialog with quality, format and upscale options"></td>
  </tr>
  <tr>
    <td><b>Rate and pick</b> — Give photos a star rating, a pick flag or a reject flag. Filter the filmstrip by these values.</td>
    <td><b>Export</b> — Export to JPEG, PNG, WebP or TIFF, with AI upscaling and watermarks.</td>
  </tr>
</table>

The sample photos are from Unsplash. For the credits, refer to
[images/README.md](images/README.md).

## Features

- **Batch workflow** — Import files or full folders. Edit one photo, then use
  *Copy these edits to all*. Or use *Auto enhance all*. This command examines and
  adjusts each photo separately.
- **Auto Enhance** — Auto Enhance does a histogram analysis of each image. It applies
  these adjustments:
  - Gray-world white balance.
  - Exposure and black point, from percentiles.
  - Recovery of highlights and shadows, with a check for clipping.
  - Contrast, from the dynamic range.

  The results go into the usual sliders. You can then adjust them more.
- **Adjustments** — These adjustments are available:
  - White Balance: temperature and tint.
  - Light: exposure, highlights, shadows, brightness, contrast, whites and black point.
  - Hue & Saturation: hue, saturation and vibrance.
  - 3-Way Color Balance: color wheels for shadows, midtones and highlights, and
    luminance.

  All adjustments use the GPU (WebGL2) and show the result immediately. A live RGB
  histogram also shows the result.
- **Tone curve** — Point curves for RGB, and for each of red, green and blue. The
  curves are monotone splines, so they do not go past the points that you set. The
  curves show on the live histogram.
- **Color mixer** — Adjust the hue, saturation and luminance of eight color bands,
  from red to magenta. The transition between the bands is smooth.
- **Effects and detail** — Texture, clarity, dehaze, vignette, film grain (with grain
  size) and sharpening. Clarity and dehaze use a small, blurred copy of the photo.
  Sabattier makes this copy one time for each photo. Texture and sharpening use the
  full-resolution source. Thus, examine these two effects at 100% zoom.
- **Masks** — Masks apply local adjustments. These masks are available:
  - Subject and Background masks. These masks use the segmentation model of
    background removal. The model runs a maximum of one time for each photo.
  - Linear gradients and radial gradients. Put them on the photo with the handles.

  Each mask changes these values in its area: exposure, contrast, highlights,
  shadows, temperature, tint, saturation and clarity. You can invert a mask. You can
  show a mask as a red overlay. You can also show the outline of a mask on the photo.
  Subject masks show a traced edge, and gradients show handles. *Copy these edits to
  all* and saved looks include the masks. Subject masks run the model again on each
  photo.
- **Healing** — Use *Remove spots* to paint over dust, blemishes or small objects. An
  inpainting model (LaMa) then fills the area. Each stroke is one undo step. Sabattier
  calculates each stroke one time in each session.
- **Portrait** — These tools apply to all faces in the photo:
  - On the Quick tab: *Smooth skin*, *Brighten eyes* and *Whiten teeth*.
  - Under Masks: Face skin, Eyes, Lips and Teeth masks.

  YuNet finds the faces. The MediaPipe Face Landmarker gives 478 landmarks for each
  face. The eyes, brows and lips are not part of the skin area. The MediaPipe
  multiclass selfie segmenter gives the face skin. Masks can adjust Texture. Thus,
  skin smoothing makes the texture softer, but it does not blur the features.
- **Lens blur** — Blur the background with a depth model (Depth-Anything-V2 Small).
  Sabattier sets the focus automatically, or you click the photo to set it. You can
  adjust the focus range and the bokeh on highlights.
- **HDR merge** — Select bracketed shots, then use *Merge to HDR*. Sabattier aligns
  the shots and combines them with exposure fusion. The result is a new photo in the
  same folder as the original photos. Sabattier uses each shot with its edits. Thus,
  exposure changes that you make before the merge have an effect on the result.
- **Multicore** — The *Use all CPU cores* setting is in Settings. It is on by
  default. When it is on, HDR merge, RAW development and the AI models use all CPU
  cores. When it is off, each job uses one core.
- **Culling** — Use these keys on the selected photos:
  - `0`–`5`: give a star rating.
  - `P`: pick.
  - `X`: reject.
  - `U`: remove the flag.
  - `←` and `→`: go to the previous or the next photo.

  You can filter the filmstrip by picks, rejects or rating. Sabattier keeps the
  ratings and flags between sessions. It records them by file path in an SQLite
  catalog in the app's data folder.
- **Interactive histogram** — Drag on the histogram to adjust the photo. The
  histogram has four tonal zones: Black Point, Shadows, Exposure and Highlights. Drag
  a zone to the right to make it brighter. Double-click a zone to reset it. To lock a
  zone, use the chips below the histogram. Then a drag changes only that part of the
  tonal range.
- **Background removal** — Remove the background around the subject with one click.
  The ISNet segmentation model does this on your computer, through ONNX Runtime in the
  Rust backend. The model is approximately 170 MB. Sabattier downloads it one time,
  when you use the tool for the first time. You can set background removal to off at
  any time. Cutout photos show a transparency checkerboard. Sabattier exports them as
  PNG, not as JPEG.
- **Crop** — Draw a crop on the preview. Drag the box or its handles to change it. Use
  a free aspect ratio or a fixed aspect ratio: Original, 1:1, 4:3, 3:2, 16:9, 4:5 or
  9:16. A rule-of-thirds guide is available. The crop is non-destructive: it is a
  setting for each photo, and you can undo it as all other settings. Sabattier applies
  the crop when you export the photo. The vignette and the histogram use the cropped
  frame.
- **RAW support** — CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF and SRW. The Rust
  backend reads these files with [rawler](https://github.com/dnglab/dnglab).
- **Undo/redo** — Each adjustment, auto enhance, preset application and batch
  operation is one undo step. Use `Ctrl+Z` and `Ctrl+Shift+Z`, or the Undo and Redo
  buttons. When you undo a batch operation, the undo applies to all photos at the same
  time.
- **Zoom & pan** — Scroll to zoom. The zoom point is at the cursor. Drag to pan.
  Double-click to zoom to 100%. Click the zoom badge to fit the photo in the preview.
  The zoomed image is sharp, because the GPU uses the full-resolution image.
- **Export** — Export to JPEG, PNG, WebP or TIFF. These options are available:
  - Quality (85–100) for JPEG and WebP.
  - A resize of the long edge (1024–4096 px), for photos that you share.
  - A suffix for the filename.
  - Safe filenames. Sabattier never overwrites a file that exists. It uses a
    numbered name.

  You can save all photos, or only the photos that the filmstrip filter shows. The
  Rust backend encodes TIFF. It also encodes WebP if the webview has no WebP encoder.
  In that condition, the WebP file is lossless.
- **AI upscale** — Upscale photos 2× or 4× when you save them (Real-ESRGAN). The
  upscale occurs tile by tile on your computer. The maximum size is 8192 px.
- **Watermark** — Add text or a logo image in a corner or in the center. You can set
  the size and the opacity. Sabattier scales the watermark to the short edge of each
  photo. The save dialog shows a preview.
- **Presets** — Save adjustment presets with a name. Sabattier keeps them between
  sessions. You can apply a preset to one photo or to all photos in the batch. You can
  delete the presets that you do not use. Sabattier keeps presets in a `presets`
  folder in the app's data folder. To use a different folder, go to **Settings**.
- **Edit list** — The list shows each edit on the selected photo, with a checkbox.
  Clear the checkbox to stop the effect. The value of the effect does not change. To
  remove an edit, click the red button. Sabattier asks you to confirm first. You can
  stop this confirmation in the dialog or in **Settings**.
- **Settings** — Click the gear in the top bar. Settings contains:
  - The theme: Dark, Light or System.
  - The confirmation for edit removal.
  - The presets folder.
  - The AI models: size, license, and a delete option to make disk space available.
  - **Backup & restore**: Save settings, presets and ratings to one file. Restore them
    from that file.
- **AI models** — Sabattier downloads each model when you use the related tool for
  the first time. It checks each model against a pinned SHA-256 value. The models run
  on your computer with ONNX Runtime. Sabattier does not send your photos to other
  computers.
- **Hold to see original** — Push and hold **Hold to see original** below the preview
  to see the original photo. The adjustments are off, and cutout photos show their
  real background. Sabattier keeps the crop, so the two images align.

## Run the app

Sabattier is a [Tauri](https://tauri.app) app. It has a Rust backend and a UI in
plain HTML, CSS and JavaScript. The UI has no build step.

### Necessary software

1. **Rust** (stable). Install it from [rustup.rs](https://rustup.rs).
2. **The Tauri CLI**. Install it one time with cargo:

   ```bash
   cargo install tauri-cli --version "^2" --locked
   ```

3. **A system webview**. Windows 10 and Windows 11 have WebView2 already. On macOS,
   install the Xcode Command Line Tools (`xcode-select --install`). For other
   platforms, refer to
   [v2.tauri.app/start/prerequisites](https://v2.tauri.app/start/prerequisites/).

You can use each GPU that has WebGL2 support.

### Start the app

From the repository root, run this command:

```bash
cargo tauri dev
```

The AI tools are background removal, healing, lens blur, upscaling and the portrait
tools. When you use an AI tool for the first time, Sabattier downloads the necessary
model. It puts the model in the app's data folder. Each model is from less than 1 MB
to approximately 200 MB. All the models together are approximately 575 MB. After the
download, the tool operates without an internet connection. The "with models"
installers contain all the models, so Sabattier does not download them.

### Build a release

Run one of these commands:

```bash
cargo tauri build                 # installer: Windows NSIS / macOS DMG
cargo tauri build --no-bundle     # only the optimized executable
```

The output goes into `src-backend/target/release/`. The installers are in `bundle/`.

You can also build the installer that contains all the AI models. This installer is
approximately 575 MB larger, and it does not download models on first use. To build
it, do these steps:

1. Download the models into `src-backend/bundled-models/`. The script checks the
   hashes.

   ```bash
   python scripts/fetch-models.py
   ```

2. Build the installer with the models configuration:

   ```bash
   cargo tauri build --config src-backend/tauri.models.conf.json
   ```

### Edit photos

1. Add photos. Use one of these methods:
   - Click *Choose photos* or *Choose a folder*. After you add the first photos, use
     *Add photos* or *Add folder*.
   - Drag files into the window.
2. Select a photo in the strip below the preview.
3. Adjust the photo in the panel:
   - The **Quick** tab has one-click corrections: **Auto enhance**, **Remove
     background** and **Crop**. It also has three simple sliders: Brightness, Warmth
     and Color intensity.
   - The **Fine-tune** tab has the histogram and all the sliders and color wheels.
4. To edit the full batch, use one of these buttons:
   - **Auto enhance all**: Sabattier enhances each photo separately.
   - **Copy these edits to all**: Sabattier copies the settings of the current photo
     to all photos in the batch.

   After a batch operation, Sabattier shows a confirmation with an **Undo** button.
5. To compare with the original photo, push and hold **Hold to see original**.
6. To save the current look, click **+ Save this look**. To apply the look to the
   selected photos, click the look.
7. To crop the photo, do these steps:
   1. Click **Crop**.
   2. Drag the box or its handles.
   3. Select an aspect ratio.
   4. Click **Apply** (`Enter`) or **Cancel** (`Esc`).
8. To zoom in, scroll over the preview. To see the actual pixels, double-click or
   click **100%**. To zoom out, click **Fit**. To pan, drag the photo.
9. To undo a step, push `Ctrl+Z`. You can also undo batch operations.
10. To save the photos, do these steps:
    1. Click **Save N photos**.
    2. Select the use: *Best quality*, *Sharing online* or *Custom* quality and size.
    3. Select a folder.
    4. Optional: Type a filename suffix.

    Sabattier never overwrites files that exist.

## Architecture

- `src-backend/` — The Rust backend (Tauri 2):
  - `files.rs` — Folder lists, file read and write, safe export names and presets.
  - `raw.rs` — RAW development with rawler (demosaic, camera white balance, sRGB and
    EXIF orientation). It also extracts the embedded preview for fast thumbnails.
  - `models.rs` — The model manager: the registry (URL, SHA-256, size and license),
    the download on first use and the cached ONNX Runtime sessions.
  - `background.rs` — The ISNet subject matte, for background removal and subject
    masks.
  - `inpaint.rs` — LaMa inpainting, for healing.
  - `depth.rs` — Depth maps, for lens blur.
  - `upscale.rs` — Tiled Real-ESRGAN upscaling, and the encoding on export.
  - `hdr.rs` — HDR merge: alignment (median threshold bitmaps) and exposure fusion.
  - `parallel.rs` — The *Use all CPU cores* setting: the rayon pool and the ONNX
    thread count.
  - `faces.rs` — Face detection (YuNet), landmarks and face-skin segmentation
    (MediaPipe). The renderer uses these results to make the skin, eyes, lips and
    teeth masks (`src-frontend/engine/faceRegions.js`).
  - `catalog.rs` — The SQLite catalog for ratings and flags.
  - `smoke.rs` — Hooks for the smoke test.
- `src-frontend/` — The UI. The system webview loads these files without changes:
  - `index.html`, `main.js` — The entry point. `main.js` also contains the smoke test
    flow.
  - `backend.js` — The bridge to the backend commands, through `window.__TAURI__`.
  - `dom.js` — Small helpers for elements and bindings. The components use these
    helpers.
  - `engine/` — The WebGL2 single-pass adjustment shader, histogram binning, the
    auto enhancer and the full-resolution export.
  - `decode/` — `createImageBitmap` for standard formats, and RAW pixels from the
    backend.
  - `state/` — The store: the image list, the settings of each image, undo and batch
    operations.
  - `components/` — The filmstrip, the GPU preview, the adjustment panel and the
    export dialog.
  - `fonts/` — Barlow (SIL Open Font License). The app contains this font, so it
    operates without an internet connection.

Pixels go across the bridge as raw binary data, not as JSON. For background removal,
the UI sends a 1024×1024 copy of the decoded photo to the model. The model sends back
a matte. The UI stretches the matte over the full-resolution image and uses it as the
alpha channel.

## Licenses

All application code has the Apache-2.0 license (refer to `LICENSE`). The
dependencies have these licenses:

- Tauri: MIT/Apache-2.0.
- ort: MIT/Apache-2.0. ONNX Runtime: MIT.
- image: MIT/Apache-2.0.
- The Barlow typeface: SIL Open Font License (`src-frontend/fonts/OFL.txt`).
- rawler, the RAW decoder: LGPL-2.1. The app links rawler statically. This repository
  contains the full source code, so it complies with the LGPL relinking requirement.

Sabattier downloads the model weights at runtime. The "with models" installers
contain the model weights. The models have these licenses:

- ISNet "general use" ([DIS](https://github.com/xuebinqin/DIS)): Apache-2.0.
- LaMa ([big-lama](https://github.com/advimman/lama)): Apache-2.0.
- Depth-Anything-V2 Small: Apache-2.0.
- Real-ESRGAN x4plus ([Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN)):
  BSD-3-Clause.
- YuNet ([OpenCV Zoo](https://github.com/opencv/opencv_zoo)): MIT.
- The MediaPipe face landmark model and multiclass selfie segmentation model:
  © Google, Apache-2.0. The ONNX conversions do not change the weights.

The app contains the upstream license text of each model in `src-frontend/licenses/`.
To open a license, click its name in **Settings → AI models**.

**Settings → Open-source licenses** shows all other components in the app:

- All the Rust crates in the build, Tauri included. There are 485 crates, each with
  the full text of its license.
- ONNX Runtime 1.28.0, with its third-party notices.
- SQLite (public domain).
- The Barlow typeface.

[cargo-about](https://github.com/EmbarkStudios/cargo-about) makes the crate list from
`Cargo.lock`. To update the list, run these commands:

```bash
cargo install cargo-about --locked --features cli   # one time only
scripts/update-licenses.sh                          # after you change dependencies
```

A backend test fails if `Cargo.lock` changed after the last update of the list. The
ONNX Runtime version follows the `ort` crate. When `ort` moves to a new ONNX Runtime
release, update its license files in `src-frontend/licenses/`.
