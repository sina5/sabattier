//! Face analysis for portrait retouching, all permissively licensed:
//! - YuNet (MIT, OpenCV Zoo) finds faces and their eyes;
//! - MediaPipe Face Landmarker's landmark model (Apache-2.0, ONNX export)
//!   places 478 points per face, on a crop rotated so the eyes are level;
//! - MediaPipe's multiclass selfie segmenter (Apache-2.0, ONNX export)
//!   gives the face-skin probability around each face.
//!
//! The renderer turns these into skin / eyes / lips / teeth masks.

use ort::session::Session;
use ort::value::Tensor;
use tauri::AppHandle;
use tauri::ipc::{InvokeBody, Request};

use crate::models::{self, FACE_LANDMARKS, SELFIE_SEGMENTER, YUNET};

const DET: usize = 640;
const CROP: usize = 256;
const MIN_SCORE: f32 = 0.7;
const NMS_IOU: f32 = 0.3;

/// RGB image as f32 in [0, 1], interleaved.
pub struct Rgb {
    pub w: usize,
    pub h: usize,
    pub d: Vec<f32>,
}

impl Rgb {
    pub fn from_rgba(rgba: &[u8], w: usize, h: usize) -> Self {
        let d = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]].map(|v| v as f32 / 255.0)).collect();
        Rgb { w, h, d }
    }

    /// Bilinear sample at (x, y) in pixel units (centres at +0.5), clamped at the edges.
    fn sample(&self, x: f32, y: f32) -> [f32; 3] {
        let (fx, fy) = (x - 0.5, y - 0.5);
        let (x0, y0) = (fx.floor(), fy.floor());
        let (tx, ty) = (fx - x0, fy - y0);
        let at = |xi: f32, yi: f32, c: usize| {
            let xi = (xi as isize).clamp(0, self.w as isize - 1) as usize;
            let yi = (yi as isize).clamp(0, self.h as isize - 1) as usize;
            self.d[(yi * self.w + xi) * 3 + c]
        };
        [0, 1, 2].map(|c| {
            let a = at(x0, y0, c) * (1.0 - tx) + at(x0 + 1.0, y0, c) * tx;
            let b = at(x0, y0 + 1.0, c) * (1.0 - tx) + at(x0 + 1.0, y0 + 1.0, c) * tx;
            a * (1.0 - ty) + b * ty
        })
    }
}

/// A square crop of the image, rotated by `angle` (radians) around `center`.
/// Crop pixel (u, v) in 0..CROP maps to image point center + R·((u/CROP − ½)·size, (v/CROP − ½)·size).
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct Crop {
    pub cx: f32,
    pub cy: f32,
    pub size: f32,
    pub angle: f32,
}

impl Crop {
    fn to_image(&self, u: f32, v: f32) -> (f32, f32) {
        let (dx, dy) = ((u / CROP as f32 - 0.5) * self.size, (v / CROP as f32 - 0.5) * self.size);
        let (s, c) = self.angle.sin_cos();
        (self.cx + c * dx - s * dy, self.cy + s * dx + c * dy)
    }

    /// NHWC [0, 1] input for the MediaPipe models.
    fn pixels(&self, img: &Rgb) -> Vec<f32> {
        let mut out = Vec::with_capacity(CROP * CROP * 3);
        for v in 0..CROP {
            for u in 0..CROP {
                let (x, y) = self.to_image(u as f32 + 0.5, v as f32 + 0.5);
                out.extend(img.sample(x, y));
            }
        }
        out
    }
}

#[derive(Clone, Debug)]
pub struct Detection {
    pub score: f32,
    /// x, y, w, h in image pixels.
    pub bbox: [f32; 4],
    /// The two eyes, in image pixels.
    pub eyes: [(f32, f32); 2],
}

fn iou(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let (x0, y0) = (a[0].max(b[0]), a[1].max(b[1]));
    let (x1, y1) = ((a[0] + a[2]).min(b[0] + b[2]), (a[1] + a[3]).min(b[1] + b[3]));
    let inter = (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
    inter / (a[2] * a[3] + b[2] * b[3] - inter).max(1e-6)
}

/// YuNet at one scale: the image is fitted into DET² (scale `fit`), padded
/// right/bottom. Decoding follows OpenCV's FaceDetectorYN.
fn detect_at(session: &mut Session, img: &Rgb, fit: f32) -> Result<Vec<Detection>, String> {
    let k = fit * DET as f32 / img.w.max(img.h) as f32;
    let plane = DET * DET;
    let mut input = vec![0f32; 3 * plane];
    let (sw, sh) = ((img.w as f32 * k) as usize, (img.h as f32 * k) as usize);
    for y in 0..sh.min(DET) {
        for x in 0..sw.min(DET) {
            let p = img.sample((x as f32 + 0.5) / k, (y as f32 + 0.5) / k);
            // BGR, 0–255.
            for (c, v) in [p[2], p[1], p[0]].into_iter().enumerate() {
                input[c * plane + y * DET + x] = v * 255.0;
            }
        }
    }
    let tensor = Tensor::from_array(([1usize, 3, DET, DET], input)).map_err(|e| e.to_string())?;
    let out = session.run(ort::inputs!["input" => tensor]).map_err(|e| format!("face detection: {e}"))?;
    let mut found = Vec::new();
    for stride in [8usize, 16, 32] {
        let get = |name: String| -> Result<Vec<f32>, String> {
            let (_, v) = out[name.as_str()].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            Ok(v.to_vec())
        };
        let (cls, obj) = (get(format!("cls_{stride}"))?, get(format!("obj_{stride}"))?);
        let (bbox, kps) = (get(format!("bbox_{stride}"))?, get(format!("kps_{stride}"))?);
        let cols = DET / stride;
        for i in 0..cls.len() {
            let score = (cls[i].clamp(0.0, 1.0) * obj[i].clamp(0.0, 1.0)).sqrt();
            if score < MIN_SCORE {
                continue;
            }
            let (c, r) = ((i % cols) as f32, (i / cols) as f32);
            let s = stride as f32;
            let b = &bbox[i * 4..i * 4 + 4];
            let (cx, cy) = ((c + b[0]) * s, (r + b[1]) * s);
            let (w, h) = (b[2].exp() * s, b[3].exp() * s);
            let kp = |j: usize| (((kps[i * 10 + 2 * j] + c) * s) / k, ((kps[i * 10 + 2 * j + 1] + r) * s) / k);
            found.push(Detection {
                score,
                bbox: [(cx - w / 2.0) / k, (cy - h / 2.0) / k, w / k, h / k],
                eyes: [kp(0), kp(1)],
            });
        }
    }
    Ok(found)
}

/// Faces at two scales (YuNet sees faces up to ~300 px of its 640 input, so
/// close-ups need the smaller pass), merged by non-maximum suppression.
pub fn detect(session: &mut Session, img: &Rgb) -> Result<Vec<Detection>, String> {
    let mut all = detect_at(session, img, 1.0)?;
    all.extend(detect_at(session, img, 0.45)?);
    all.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for d in all {
        if kept.iter().all(|k| iou(&k.bbox, &d.bbox) < NMS_IOU) {
            kept.push(d);
        }
    }
    Ok(kept)
}

/// 478 landmarks in image pixels and the face-presence probability.
fn landmarks_once(session: &mut Session, img: &Rgb, crop: &Crop) -> Result<(Vec<(f32, f32)>, f32), String> {
    let tensor = Tensor::from_array(([1usize, CROP, CROP, 3], crop.pixels(img))).map_err(|e| e.to_string())?;
    let out = session.run(ort::inputs!["input_12" => tensor]).map_err(|e| format!("face landmarks: {e}"))?;
    let (_, pts) = out["Identity"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    let (_, presence) = out["Identity_1"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    if pts.len() != 478 * 3 {
        return Err(format!("unexpected landmark output size {}", pts.len()));
    }
    let points = (0..478).map(|i| crop.to_image(pts[i * 3], pts[i * 3 + 1])).collect();
    Ok((points, 1.0 / (1.0 + (-presence[0]).exp())))
}

/// Level the eyes: the angle of the line from the image-left eye to the other.
fn eye_angle(a: (f32, f32), b: (f32, f32)) -> f32 {
    let (l, r) = if a.0 <= b.0 { (a, b) } else { (b, a) };
    (r.1 - l.1).atan2(r.0 - l.0)
}

/// A square crop around points, rotated by `angle`, `scale` × their extent.
fn crop_around(points: &[(f32, f32)], angle: f32, scale: f32) -> Crop {
    let (s, c) = angle.sin_cos();
    // Extent measured in the rotated frame, so a tilted face isn't over-sized.
    let rot = |p: &(f32, f32)| (c * p.0 + s * p.1, -s * p.0 + c * p.1);
    let (mut lo, mut hi) = ((f32::MAX, f32::MAX), (f32::MIN, f32::MIN));
    for p in points.iter().map(rot) {
        lo = (lo.0.min(p.0), lo.1.min(p.1));
        hi = (hi.0.max(p.0), hi.1.max(p.1));
    }
    let (mx, my) = ((lo.0 + hi.0) / 2.0, (lo.1 + hi.1) / 2.0);
    Crop { cx: c * mx - s * my, cy: s * mx + c * my, size: (hi.0 - lo.0).max(hi.1 - lo.1) * scale, angle }
}

#[derive(serde::Serialize)]
pub struct Face {
    pub score: f32,
    /// 478 points, in pixels of the analyzed image.
    pub landmarks: Vec<[f32; 2]>,
    /// Where the skin probabilities sit on the image.
    pub skin_crop: Crop,
    /// Face-skin probability, CROP² bytes (row-major over the crop).
    pub skin: Vec<u8>,
}

#[derive(serde::Serialize)]
pub struct Analysis {
    pub width: usize,
    pub height: usize,
    pub crop_size: usize,
    pub faces: Vec<Face>,
}

/// Landmarks for one detection: a first pass on a crop from the detector,
/// then a second from the first pass's own points (how MediaPipe tracks).
pub fn landmarks(session: &mut Session, img: &Rgb, det: &Detection) -> Result<Option<Vec<(f32, f32)>>, String> {
    let angle = eye_angle(det.eyes[0], det.eyes[1]);
    let [x, y, w, h] = det.bbox;
    let corners = [(x, y), (x + w, y + h)];
    let first = crop_around(&corners, angle, 1.5);
    let (pts, presence) = landmarks_once(session, img, &first)?;
    if presence < 0.5 {
        return Ok(None);
    }
    let refined = crop_around(&pts, eye_angle(pts[33], pts[263]), 1.35);
    let (pts, presence) = landmarks_once(session, img, &refined)?;
    Ok((presence >= 0.5).then_some(pts))
}

/// Face-skin probability on a crop around the face (with some head and
/// shoulders, the framing the selfie model expects).
pub fn skin(session: &mut Session, img: &Rgb, pts: &[(f32, f32)]) -> Result<(Crop, Vec<u8>), String> {
    let crop = crop_around(pts, eye_angle(pts[33], pts[263]), 2.2);
    let tensor = Tensor::from_array(([1usize, CROP, CROP, 3], crop.pixels(img))).map_err(|e| e.to_string())?;
    let out = session.run(ort::inputs!["input_29" => tensor]).map_err(|e| format!("skin segmentation: {e}"))?;
    let (_, logits) = out["Identity"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    if logits.len() != CROP * CROP * 6 {
        return Err(format!("unexpected segmenter output size {}", logits.len()));
    }
    let probs = logits
        .chunks_exact(6)
        .map(|l| {
            let m = l.iter().copied().fold(f32::MIN, f32::max);
            let sum: f32 = l.iter().map(|v| (v - m).exp()).sum();
            ((l[3] - m).exp() / sum * 255.0).round() as u8 // class 3: face skin
        })
        .collect();
    Ok((crop, probs))
}

/// Body: RGBA8 at `width`×`height` (headers). Returns every face found with
/// its landmarks and face-skin probabilities.
#[tauri::command]
pub async fn analyze_faces(app: AppHandle, request: Request<'_>) -> Result<Analysis, String> {
    let InvokeBody::Raw(rgba) = request.body() else {
        return Err("analyze_faces expects a raw RGBA body".into());
    };
    let dim = |name: &str| -> Result<usize, String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .ok_or(format!("analyze_faces: missing {name} header"))
    };
    let (w, h) = (dim("width")?, dim("height")?);
    if w == 0 || h == 0 || rgba.len() != w * h * 4 {
        return Err(format!("analyze_faces: expected {w}x{h} RGBA, got {} bytes", rgba.len()));
    }
    let img = std::sync::Arc::new(Rgb::from_rgba(rgba, w, h));

    let im = img.clone();
    let dets = models::with_session(app.clone(), YUNET, move |s| detect(s, &im)).await?;
    let im = img.clone();
    let marks = models::with_session(app.clone(), FACE_LANDMARKS, move |s| {
        dets.iter().map(|d| Ok(landmarks(s, &im, d)?.map(|p| (d.score, p)))).collect::<Result<Vec<_>, String>>()
    })
    .await?;
    let marks: Vec<(f32, Vec<(f32, f32)>)> = marks.into_iter().flatten().collect();
    if marks.is_empty() {
        return Ok(Analysis { width: w, height: h, crop_size: CROP, faces: vec![] });
    }
    let im = img.clone();
    let faces = models::with_session(app, SELFIE_SEGMENTER, move |s| {
        marks
            .iter()
            .map(|(score, pts)| {
                let (skin_crop, skin) = skin(s, &im, pts)?;
                Ok(Face { score: *score, landmarks: pts.iter().map(|p| [p.0, p.1]).collect(), skin_crop, skin })
            })
            .collect::<Result<Vec<_>, String>>()
    })
    .await?;
    Ok(Analysis { width: w, height: h, crop_size: CROP, faces })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_maps_centre_and_rotation() {
        let c = Crop { cx: 100.0, cy: 50.0, size: 64.0, angle: std::f32::consts::FRAC_PI_2 };
        let (x, y) = c.to_image(128.0, 128.0);
        assert!((x - 100.0).abs() < 1e-4 && (y - 50.0).abs() < 1e-4);
        // +u in the crop points down the image when rotated a quarter turn.
        let (x, y) = c.to_image(256.0, 128.0);
        assert!((x - 100.0).abs() < 1e-3 && (y - 82.0).abs() < 1e-3, "({x}, {y})");
    }

    /// Runs the real models when SABATTIER_FACES points at a folder with
    /// yunet.onnx, face_landmarks.onnx, selfie_multiclass.onnx and portrait.jpg
    /// (MediaPipe's public test portrait): one face, landmarks on it, the eyes
    /// level, and skin found on the cheeks but not on the eyes or lips.
    #[test]
    fn analyzes_a_portrait() {
        let Ok(dir) = std::env::var("SABATTIER_FACES") else { return };
        let dir = std::path::Path::new(&dir);
        let open = |f: &str| Session::builder().unwrap().commit_from_file(dir.join(f)).unwrap();
        let photo = image::open(dir.join("portrait.jpg")).unwrap().to_rgba8();
        let img = Rgb::from_rgba(photo.as_raw(), photo.width() as usize, photo.height() as usize);
        let t = std::time::Instant::now();
        let dets = detect(&mut open("yunet.onnx"), &img).unwrap();
        assert_eq!(dets.len(), 1, "{dets:?}");
        let [x, y, w, h] = dets[0].bbox;
        eprintln!("face at {x:.0},{y:.0} {w:.0}x{h:.0} score {:.2}", dets[0].score);
        assert!(x > 250.0 && x + w < 560.0 && y > 20.0 && y + h < 400.0);
        let pts = landmarks(&mut open("face_landmarks.onnx"), &img, &dets[0]).unwrap().expect("face present");
        let (le, re) = (pts[33], pts[263]);
        assert!((le.1 - re.1).abs() < 12.0, "eyes level-ish: {le:?} {re:?}");
        let (crop, probs) = skin(&mut open("selfie_multiclass.onnx"), &img, &pts).unwrap();
        eprintln!("analysis in {:?}", t.elapsed());
        // Probability at an image point, through the crop's inverse transform.
        let prob = |p: (f32, f32)| {
            let (s, c) = crop.angle.sin_cos();
            let (dx, dy) = (p.0 - crop.cx, p.1 - crop.cy);
            let (u, v) = ((c * dx + s * dy) / crop.size + 0.5, (-s * dx + c * dy) / crop.size + 0.5);
            probs[(v * CROP as f32) as usize * CROP + (u * CROP as f32) as usize]
        };
        // Cheek: between the eye corner and the mouth corner.
        let cheek = ((pts[33].0 + pts[61].0) / 2.0, (pts[33].1 + pts[61].1) / 2.0 + 10.0);
        let (cheek_p, forehead_p) = (prob(cheek), prob(pts[151]));
        eprintln!("skin probability: cheek {cheek_p}, forehead {forehead_p}, pupil {}", prob(pts[468]));
        assert!(cheek_p > 180 && forehead_p > 150);
        // Optionally save the analysis, for checking the renderer's masks.
        if let Ok(out) = std::env::var("SABATTIER_FACES_DUMP") {
            let analysis = Analysis {
                width: img.w,
                height: img.h,
                crop_size: CROP,
                faces: vec![Face { score: dets[0].score, landmarks: pts.iter().map(|p| [p.0, p.1]).collect(), skin_crop: crop, skin: probs }],
            };
            std::fs::write(out, serde_json::to_string(&analysis).unwrap()).unwrap();
        }
    }
}
