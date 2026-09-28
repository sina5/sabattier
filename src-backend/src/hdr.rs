//! HDR merge by exposure fusion (Mertens, Kautz & Van Reeth 2007): bracketed
//! shots are aligned (median threshold bitmaps, Ward 2003), each pixel is
//! weighted by contrast, saturation and how well exposed it is, and the
//! shots are blended across a Laplacian pyramid so the seams stay invisible.
//! No model and no tone mapping: the result is a normal photo that the usual
//! adjustments then edit. The frames are the photos as edited, rendered by
//! the frontend, so exposure changes made before merging count.
//!
//! Every pass works row-parallel with rayon, within the Settings switch for
//! using all cores (see parallel.rs).

use std::path::PathBuf;
use std::sync::Mutex;

use image::{DynamicImage, GrayImage, RgbImage};
use rayon::prelude::*;
use tauri::ipc::{InvokeBody, Request};

use crate::blocking;

// ---- Alignment: median threshold bitmaps ----

fn half(g: &GrayImage) -> GrayImage {
    let (w, h) = ((g.width() / 2).max(1), (g.height() / 2).max(1));
    GrayImage::from_fn(w, h, |x, y| {
        let p = |dx: u32, dy: u32| g.get_pixel((2 * x + dx).min(g.width() - 1), (2 * y + dy).min(g.height() - 1))[0] as u32;
        image::Luma([((p(0, 0) + p(1, 0) + p(0, 1) + p(1, 1)) / 4) as u8])
    })
}

/// Threshold at the median, plus an exclusion mask for pixels near it (noise).
fn bitmaps(g: &GrayImage) -> (Vec<bool>, Vec<bool>) {
    let mut hist = [0u32; 256];
    for p in g.pixels() {
        hist[p[0] as usize] += 1;
    }
    let half_count = g.pixels().len() as u32 / 2;
    let (mut acc, mut median) = (0u32, 0u8);
    for (v, &n) in hist.iter().enumerate() {
        acc += n;
        if acc >= half_count {
            median = v as u8;
            break;
        }
    }
    let t: Vec<bool> = g.pixels().map(|p| p[0] > median).collect();
    let keep: Vec<bool> = g.pixels().map(|p| (p[0] as i32 - median as i32).abs() > 4).collect();
    (t, keep)
}

/// Fraction of compared pixels that mismatch between `a` and `b` shifted by
/// (dx, dy). A fraction, not a count: larger shifts overlap less, and a raw
/// count would favour them.
fn mismatch(w: usize, h: usize, a: &(Vec<bool>, Vec<bool>), b: &(Vec<bool>, Vec<bool>), dx: i32, dy: i32) -> f64 {
    let mut n = 0u64;
    let mut compared = 0u64;
    for y in 0..h as i32 {
        let sy = y + dy;
        if sy < 0 || sy >= h as i32 {
            continue;
        }
        for x in 0..w as i32 {
            let sx = x + dx;
            if sx < 0 || sx >= w as i32 {
                continue;
            }
            let (i, j) = ((y as usize) * w + x as usize, (sy as usize) * w + sx as usize);
            if a.1[i] && b.1[j] {
                compared += 1;
                if a.0[i] != b.0[j] {
                    n += 1;
                }
            }
        }
    }
    if compared == 0 { 1.0 } else { n as f64 / compared as f64 }
}

/// Offset (dx, dy) such that `img` at (x + dx, y + dy) lines up with
/// `reference` at (x, y). Each pyramid level doubles the search range; levels
/// stop before images get too small to match reliably.
pub(crate) fn align(reference: &GrayImage, img: &GrayImage, levels: u32) -> (i32, i32) {
    if levels == 0 || reference.width() < 48 || reference.height() < 48 {
        return (0, 0);
    }
    let (cx, cy) = align(&half(reference), &half(img), levels - 1);
    let (a, b) = rayon::join(|| bitmaps(reference), || bitmaps(img));
    let (w, h) = (reference.width() as usize, reference.height() as usize);
    let candidates: Vec<(i32, i32)> = (-1..=1).flat_map(|dy| (-1..=1).map(move |dx| (2 * cx + dx, 2 * cy + dy))).collect();
    let errs: Vec<f64> = candidates.par_iter().map(|&(sx, sy)| mismatch(w, h, &a, &b, sx, sy)).collect();
    // The first of equal errors wins, as in a sequential scan.
    let mut best = (2 * cx, 2 * cy);
    let mut best_err = f64::MAX;
    for (&c, &e) in candidates.iter().zip(&errs) {
        if e < best_err {
            best_err = e;
            best = c;
        }
    }
    best
}

fn shifted(img: RgbImage, (dx, dy): (i32, i32)) -> RgbImage {
    if (dx, dy) == (0, 0) {
        return img;
    }
    let (w, h) = (img.width() as usize, img.height() as usize);
    let src = img.as_raw();
    let mut out = vec![0u8; w * h * 3];
    out.par_chunks_mut(w * 3).enumerate().for_each(|(y, row)| {
        let sy = (y as i32 + dy).clamp(0, h as i32 - 1) as usize;
        for x in 0..w {
            let sx = (x as i32 + dx).clamp(0, w as i32 - 1) as usize;
            row[x * 3..x * 3 + 3].copy_from_slice(&src[(sy * w + sx) * 3..][..3]);
        }
    });
    RgbImage::from_raw(w as u32, h as u32, out).expect("sizes match")
}

// ---- Pyramids over planar f32 images ----

#[derive(Clone)]
struct Plane {
    w: usize,
    h: usize,
    c: usize,
    d: Vec<f32>,
}

impl Plane {
    fn new(w: usize, h: usize, c: usize) -> Self {
        Plane { w, h, c, d: vec![0.0; w * h * c] }
    }
    /// Every value from `f(x, y, ch)`, rows in parallel.
    fn from_fn(w: usize, h: usize, c: usize, f: impl Fn(usize, usize, usize) -> f32 + Sync) -> Self {
        let mut p = Plane::new(w, h, c);
        p.d.par_chunks_mut(w * c).enumerate().for_each(|(y, row)| {
            for x in 0..w {
                for ch in 0..c {
                    row[x * c + ch] = f(x, y, ch);
                }
            }
        });
        p
    }
    fn at(&self, x: isize, y: isize, ch: usize) -> f32 {
        let x = x.clamp(0, self.w as isize - 1) as usize;
        let y = y.clamp(0, self.h as isize - 1) as usize;
        self.d[(y * self.w + x) * self.c + ch]
    }
}

const K5: [f32; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];

/// Blur with the 5-tap binomial kernel, then keep every other pixel.
fn reduce(p: &Plane) -> Plane {
    let tmp = Plane::from_fn(p.w, p.h, p.c, |x, y, ch| {
        (0..5).map(|k| K5[k] * p.at(x as isize + k as isize - 2, y as isize, ch)).sum()
    });
    Plane::from_fn(p.w.div_ceil(2), p.h.div_ceil(2), p.c, |x, y, ch| {
        (0..5).map(|k| K5[k] * tmp.at(2 * x as isize, 2 * y as isize + k as isize - 2, ch)).sum()
    })
}

/// Bilinear enlargement to w×h (pixel centres aligned with `reduce`).
fn expand(p: &Plane, w: usize, h: usize) -> Plane {
    Plane::from_fn(w, h, p.c, |x, y, ch| {
        let fy = y as f32 / 2.0;
        let (y0, ty) = (fy.floor() as isize, fy - fy.floor());
        let fx = x as f32 / 2.0;
        let (x0, tx) = (fx.floor() as isize, fx - fx.floor());
        let a = p.at(x0, y0, ch) * (1.0 - tx) + p.at(x0 + 1, y0, ch) * tx;
        let b = p.at(x0, y0 + 1, ch) * (1.0 - tx) + p.at(x0 + 1, y0 + 1, ch) * tx;
        a * (1.0 - ty) + b * ty
    })
}

fn gaussian(p: Plane, levels: usize) -> Vec<Plane> {
    let mut out = vec![p];
    for _ in 1..levels {
        let next = reduce(out.last().unwrap());
        out.push(next);
    }
    out
}

fn laplacian(p: Plane, levels: usize) -> Vec<Plane> {
    let g = gaussian(p, levels);
    let mut out = Vec::with_capacity(levels);
    for i in 0..levels - 1 {
        let up = expand(&g[i + 1], g[i].w, g[i].h);
        let mut l = g[i].clone();
        l.d.par_iter_mut().zip(&up.d).for_each(|(v, u)| *v -= u);
        out.push(l);
    }
    out.push(g[levels - 1].clone());
    out
}

/// Mertens quality weight per pixel: contrast × saturation × well-exposedness.
fn weights(img: &Plane) -> Plane {
    let gray = |x: isize, y: isize| (0..3).map(|c| img.at(x, y, c)).sum::<f32>() / 3.0;
    Plane::from_fn(img.w, img.h, 1, |x, y, _| {
        let (x, y) = (x as isize, y as isize);
        let contrast = (gray(x - 1, y) + gray(x + 1, y) + gray(x, y - 1) + gray(x, y + 1) - 4.0 * gray(x, y)).abs();
        let rgb = [img.at(x, y, 0), img.at(x, y, 1), img.at(x, y, 2)];
        let mean = (rgb[0] + rgb[1] + rgb[2]) / 3.0;
        let saturation = (rgb.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / 3.0).sqrt();
        let exposed: f32 = rgb.iter().map(|v| (-(v - 0.5).powi(2) / (2.0 * 0.2 * 0.2)).exp()).product();
        (contrast + 0.01) * (saturation + 0.01) * exposed + 1e-12
    })
}

fn to_plane(img: &RgbImage) -> Plane {
    Plane { w: img.width() as usize, h: img.height() as usize, c: 3, d: img.as_raw().par_iter().map(|&v| v as f32 / 255.0).collect() }
}

/// Fuse aligned exposures of the same scene into one well-exposed image.
/// One image at a time (each pass parallel within it), so memory holds one
/// image's pyramids rather than all of them.
pub(crate) fn fuse(images: &[RgbImage]) -> RgbImage {
    let (w, h) = (images[0].width() as usize, images[0].height() as usize);
    let levels = ((w.min(h) as f32 / 8.0).log2().floor() as usize).clamp(1, 10);
    let mut ws: Vec<Plane> = images.iter().map(|i| weights(&to_plane(i))).collect();
    let sums: Vec<f32> = (0..w * h).into_par_iter().map(|i| ws.iter().map(|p| p.d[i]).sum()).collect();
    for p in ws.iter_mut() {
        p.d.par_iter_mut().zip(&sums).for_each(|(v, s)| *v /= s);
    }
    let mut result: Option<Vec<Plane>> = None;
    for (img, wt) in images.iter().zip(ws) {
        let lap = laplacian(to_plane(img), levels);
        let gw = gaussian(wt, levels);
        let acc = result.get_or_insert_with(|| lap.iter().map(|l| Plane::new(l.w, l.h, 3)).collect());
        for ((a, l), g) in acc.iter_mut().zip(&lap).zip(&gw) {
            a.d.par_chunks_mut(3).zip(l.d.par_chunks(3)).zip(&g.d).for_each(|((a, l), g)| {
                for c in 0..3 {
                    a[c] += l[c] * g;
                }
            });
        }
    }
    // Collapse the blended pyramid.
    let mut pyr = result.expect("at least one image");
    let mut img = pyr.pop().unwrap();
    while let Some(l) = pyr.pop() {
        let mut up = expand(&img, l.w, l.h);
        up.d.par_iter_mut().zip(&l.d).for_each(|(u, v)| *u += v);
        img = up;
    }
    RgbImage::from_raw(w as u32, h as u32, img.d.par_iter().map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8).collect())
        .expect("sizes match")
}

/// Merge bracketed frames: check sizes, align to the first, fuse.
pub(crate) fn merge(frames: Vec<RgbImage>) -> Result<RgbImage, String> {
    if frames.len() < 2 {
        return Err("Pick at least two photos to merge.".into());
    }
    let (w, h) = frames[0].dimensions();
    if frames.iter().any(|i| i.dimensions() != (w, h)) {
        return Err("These photos have different sizes; HDR merge needs shots of the same scene from the same camera, cropped alike.".into());
    }
    let gray: Vec<GrayImage> = frames.par_iter().map(image::imageops::grayscale).collect();
    let offsets: Vec<(i32, i32)> = gray[1..].par_iter().map(|g| align(&gray[0], g, 6)).collect();
    drop(gray);
    let aligned: Vec<RgbImage> = frames
        .into_iter()
        .enumerate()
        .map(|(k, img)| if k == 0 { img } else { shifted(img, offsets[k - 1]) })
        .collect();
    Ok(fuse(&aligned))
}

/// Frames for the next `merge_hdr`, staged one per call so a set of
/// full-size photos never crosses the bridge in one piece.
static FRAMES: Mutex<Vec<RgbImage>> = Mutex::new(Vec::new());

/// Stage one frame for `merge_hdr`: a photo as edited, RGBA8, with `width`,
/// `height` and `index` headers. Index 0 starts a new set.
#[tauri::command]
pub async fn hdr_add_frame(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("hdr_add_frame expects a raw RGBA body".into());
    };
    let parse = |name| crate::files::header(&request, name)?.parse::<usize>().map_err(|e| e.to_string());
    let (width, height, index) = (parse("width")?, parse("height")?, parse("index")?);
    let data = data.clone();
    blocking(move || {
        let rgba = image::RgbaImage::from_raw(width as u32, height as u32, data).ok_or("frame size doesn't match its pixels")?;
        let rgb = DynamicImage::ImageRgba8(rgba).into_rgb8();
        let mut frames = FRAMES.lock().map_err(|e| e.to_string())?;
        if index == 0 {
            frames.clear();
        }
        if frames.len() != index {
            return Err(format!("HDR frame {index} arrived out of order"));
        }
        frames.push(rgb);
        Ok(())
    })
    .await
}

/// Merge the staged frames and save the result as a PNG next to
/// `first_path`, the first photo (`<name>-HDR.png`, numbered if taken).
/// Returns its path.
#[tauri::command]
pub async fn merge_hdr(first_path: String) -> Result<String, String> {
    blocking(move || {
        let frames = std::mem::take(&mut *FRAMES.lock().map_err(|e| e.to_string())?);
        let fused = crate::parallel::run(|| merge(frames))?;
        let first = PathBuf::from(first_path);
        let stem = first.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "merged".into());
        let target = first.with_file_name(format!("{stem}-HDR.png"));
        let out = PathBuf::from(crate::files::unique_path(target.to_string_lossy().into_owned()));
        fused.save_with_format(&out, image::ImageFormat::Png).map_err(|e| format!("{}: {e}", out.display()))?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scene with deep shadows and bright highlights, "shot" at three
    /// exposures (the brightest shifted by a few pixels, as handheld).
    /// `split`: dark left half, blown-out right half (for fusion). Without it
    /// the scene is mid-toned throughout (for alignment: a half split leaves
    /// the median bitmap nothing but one vertical edge).
    fn brackets(split: bool) -> (Vec<RgbImage>, (i32, i32)) {
        let (w, h) = (240u32, 160u32);
        // Blobs vary in both directions so alignment has something to lock onto.
        let radiance = |x: u32, y: u32| -> [f32; 3] {
            let side = if !split { 0.12 } else if x < w / 2 { 0.02 } else { 2.0 };
            let blobs = 100f32.powf(((x as f32 / 9.0).sin() + (y as f32 / 7.0).cos() + 2.0) / 8.0);
            let tex = 1.0 + 0.5 * (((x / 6) + (y / 6)) % 2) as f32;
            let v = side * blobs * tex / 3.0;
            [v, v * 0.8, v * 0.6]
        };
        let shot = |gain: f32, dx: i32, dy: i32| {
            RgbImage::from_fn(w, h, |x, y| {
                let sx = (x as i32 + dx).clamp(0, w as i32 - 1) as u32;
                let sy = (y as i32 + dy).clamp(0, h as i32 - 1) as u32;
                let r = radiance(sx, sy);
                image::Rgb(r.map(|v| ((v * gain).powf(1.0 / 2.2) * 255.0).clamp(0.0, 255.0) as u8))
            })
        };
        let shift = (3, -2);
        (vec![shot(1.0, 0, 0), shot(0.15, 0, 0), shot(8.0, shift.0, shift.1)], shift)
    }

    #[test]
    fn aligns_a_handheld_shift() {
        let (imgs, shift) = brackets(false);
        let g: Vec<GrayImage> = imgs.iter().map(|i| DynamicImage::ImageRgb8(i.clone()).to_luma8()).collect();
        // The third shot sees the scene at (x + 3, y - 2): the image content is
        // found at (x - 3, y + 2) in it.
        assert_eq!(align(&g[0], &g[2], 5), (-shift.0, -shift.1));
    }

    #[test]
    fn pyramid_round_trip_is_exact() {
        let (imgs, _) = brackets(true);
        let p = to_plane(&imgs[0]);
        let mut pyr = laplacian(p.clone(), 4);
        let mut img = pyr.pop().unwrap();
        while let Some(l) = pyr.pop() {
            let mut up = expand(&img, l.w, l.h);
            for (u, v) in up.d.iter_mut().zip(&l.d) {
                *u += v;
            }
            img = up;
        }
        let err = img.d.iter().zip(&p.d).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(err < 1e-4, "reconstruction error {err}");
    }

    #[test]
    fn fusion_recovers_shadows_and_highlights() {
        let (imgs, _) = brackets(true);
        let fused = fuse(&imgs);
        let mean = |img: &RgbImage, x0: u32, x1: u32| {
            let mut s = 0u64;
            for y in 20..140 {
                for x in x0..x1 {
                    s += img.get_pixel(x, y)[1] as u64;
                }
            }
            s as f32 / (120 * (x1 - x0)) as f32
        };
        let (dark, bright) = ((10, 110), (130, 230));
        // The middle exposure has crushed shadows and clipped highlights.
        assert!(mean(&imgs[0], dark.0, dark.1) < 70.0 && mean(&imgs[0], bright.0, bright.1) > 245.0);
        let (d, b) = (mean(&fused, dark.0, dark.1), mean(&fused, bright.0, bright.1));
        eprintln!("fused: shadows {d:.0}, highlights {b:.0}");
        assert!(d > mean(&imgs[0], dark.0, dark.1) + 25.0, "shadows lifted: {d}");
        assert!(b < 235.0, "highlights recovered: {b}");
    }

    /// Timing on 12 MP frames; run with SABATTIER_BENCH=1.
    #[test]
    fn bench_12mp() {
        if std::env::var("SABATTIER_BENCH").is_err() { return; }
        let (w, h) = (4000u32, 3000u32);
        let shot = |gain: f32| RgbImage::from_fn(w, h, |x, y| {
            let v = 0.1 * 100f32.powf(((x as f32 / 90.0).sin() + (y as f32 / 70.0).cos() + 2.0) / 8.0) * gain;
            image::Rgb([(v.powf(1.0 / 2.2) * 255.0).min(255.0) as u8; 3])
        });
        let imgs = vec![shot(1.0), shot(0.2), shot(5.0)];
        let t = std::time::Instant::now();
        let g: Vec<GrayImage> = imgs.iter().map(|i| DynamicImage::ImageRgb8(i.clone()).to_luma8()).collect();
        let _ = align(&g[0], &g[1], 6);
        let ta = t.elapsed();
        let _ = fuse(&imgs);
        eprintln!("12MP x3: align {ta:?}, total {:?}", t.elapsed());
    }
}
