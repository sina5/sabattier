import { bind, drag, h } from '../dom.js';
import { icon } from '../icons.js';
import { FULL_VIEW, GLEngine } from '../engine/gl.js';
import { defaultSettings, effectiveSettings, isFullCrop } from '../engine/types.js';
import { isFaceMask } from '../engine/types.js';
import { getDepth, getFaces, getFullBitmap, getMatte, getOriginalBitmap, selectedImage, sourceKeyOf, store } from '../state/store.js';
import { BG_MODEL_SIZE } from '../backend.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Masks whose shape comes from a model, outlined by the shader. */
const tracedMask = (m) => !!m && (m.type === 'subject' || isFaceMask(m.type));
/** An SVG element with attributes (no children). */
function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// Zoom is CSS pixels per image pixel, or 'fit'. A crop handle is 'move' or a
// compass direction naming the edge/corner being dragged.
const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Aspect ratios offered in crop mode; null = free, 0 = the source aspect. */
const ASPECTS = [
  { label: 'Free', value: null },
  { label: 'Original', value: 0 },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '16:9', value: 16 / 9 },
  { label: '4:5', value: 4 / 5 },
  { label: '9:16', value: 9 / 16 },
];

const FULL_RECT = { x: 0, y: 0, w: 1, h: 1 };
/** Smallest crop, as a fraction of each image edge. */
const MIN_CROP = 0.05;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Height/width ratio, in normalized units, for a pixel aspect of `a`. */
function normRatio(a, imgW, imgH) {
  return imgW / (a * imgH);
}

/** Resize `start` by dragging `handle` (dx/dy in normalized image units). */
function resizeRect(start, handle, dx, dy, aspect, imgW, imgH) {
  const l0 = start.x;
  const t0 = start.y;
  const r0 = start.x + start.w;
  const b0 = start.y + start.h;

  // Anchor: the edge/point that stays put, and the direction the box grows in
  // (0 = symmetric around the anchor, for the side handles).
  const wDir = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const hDir = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const ax = wDir === -1 ? r0 : wDir === 1 ? l0 : (l0 + r0) / 2;
  const ay = hDir === -1 ? b0 : hDir === 1 ? t0 : (t0 + b0) / 2;

  let w = wDir === -1 ? r0 - (l0 + dx) : wDir === 1 ? r0 + dx - l0 : start.w;
  let h = hDir === -1 ? b0 - (t0 + dy) : hDir === 1 ? b0 + dy - t0 : start.h;
  w = Math.max(MIN_CROP, w);
  h = Math.max(MIN_CROP, h);

  const maxW = wDir === 0 ? 2 * Math.min(ax, 1 - ax) : wDir === 1 ? 1 - ax : ax;
  const maxH = hDir === 0 ? 2 * Math.min(ay, 1 - ay) : hDir === 1 ? 1 - ay : ay;

  if (aspect) {
    const k = normRatio(aspect, imgW, imgH); // h = w * k
    // Corner and left/right handles drive from the width, top/bottom from the height.
    if (wDir !== 0) h = w * k;
    else w = h / k;
    w = Math.max(MIN_CROP, Math.min(w, maxW, maxH / k));
    h = w * k;
  } else {
    w = Math.max(MIN_CROP, Math.min(w, maxW));
    h = Math.max(MIN_CROP, Math.min(h, maxH));
  }

  const x = wDir === -1 ? ax - w : wDir === 1 ? ax : ax - w / 2;
  const y = hDir === -1 ? ay - h : hDir === 1 ? ay : ay - h / 2;
  return { x: clamp01(x), y: clamp01(y), w, h };
}

/** Largest rect of the given pixel aspect that fits inside `r`, centered on it. */
function fitAspect(r, aspect, imgW, imgH) {
  const k = normRatio(aspect, imgW, imgH);
  const w = Math.min(r.w, r.h / k, 1, 1 / k);
  const h = w * k;
  return {
    x: clamp01(Math.min(r.x + (r.w - w) / 2, 1 - w)),
    y: clamp01(Math.min(r.y + (r.h - h) / 2, 1 - h)),
    w,
    h,
  };
}

export function Preview() {
  const st = () => store.getState();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // ---- local view state ----
  let item = null;
  let loading = false;
  let decodeError = null;
  let compare = false;
  let box = { w: 0, h: 0 };
  let zoom = 'fit';
  let center = { x: 0.5, y: 0.5 };
  let panning = false;
  let cropping = false;
  let healing = false;
  /** Waiting for a click that sets the lens-blur focus. */
  let pickingFocus = false;
  /** Heal brush radius, as a fraction of the image width. */
  let brush = 0.015;
  /** The stroke being painted, in image uv. */
  let painting = null;
  let draft = FULL_RECT;
  let aspect = null;
  let engine = null;
  let raf = 0;
  let lastHist = 0;
  let loadKey = '';
  let loadToken = 0;

  const currentSettings = () => (compare || !item ? defaultSettings() : item.settings);
  // What the photo looks like with switched-off edits removed.
  const shown = () => (item ? effectiveSettings(item.settings) : null);
  // While cropping, the whole frame stays visible so the crop can be widened again.
  const currentCrop = () => (cropping ? null : (shown()?.crop ?? null));

  /** Crop rectangle expressed as a shader window over the source image. */
  const frameFor = () => {
    const crop = currentCrop();
    return crop ? { sx: crop.w, sy: crop.h, ox: crop.x, oy: crop.y } : FULL_VIEW;
  };

  /** Size of the visible (cropped) frame, in image pixels. */
  const frameSize = () => {
    if (!engine || !engine.hasImage) return null;
    const crop = currentCrop();
    return { w: engine.imgWidth * (crop?.w ?? 1), h: engine.imgHeight * (crop?.h ?? 1) };
  };

  const fitZoom = () => {
    const size = frameSize();
    if (!size || !box.w || !box.h) return 1;
    return Math.min(box.w / size.w, box.h / size.h, 2.5);
  };

  /** Canvas CSS size + shader windows for the current zoom/crop state. */
  const viewFor = () => {
    const size = frameSize();
    if (!size) return null;
    const frame = frameFor();
    // Sub-window inside the cropped frame, composed back into image space.
    const compose = (sub) => ({
      sx: sub.sx * frame.sx,
      sy: sub.sy * frame.sy,
      ox: frame.ox + sub.ox * frame.sx,
      oy: frame.oy + sub.oy * frame.sy,
    });
    if (zoom === 'fit') {
      const z = fitZoom();
      return {
        cw: Math.max(1, Math.floor(size.w * z)),
        ch: Math.max(1, Math.floor(size.h * z)),
        view: frame,
        frame,
      };
    }
    const cw = Math.max(1, box.w);
    const ch = Math.max(1, box.h);
    const sx = cw / zoom / size.w;
    const sy = ch / zoom / size.h;
    const clampOff = (c, s) => (s >= 1 ? (1 - s) / 2 : Math.min(1 - s, Math.max(0, c - s / 2)));
    return {
      cw,
      ch,
      view: compose({ sx, sy, ox: clampOff(center.x, sx), oy: clampOff(center.y, sy) }),
      frame,
    };
  };

  const scheduleRender = (forceHistogram = false) => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const v = viewFor();
      if (!engine || !v) return;
      canvas.style.width = `${v.cw}px`;
      canvas.style.height = `${v.ch}px`;
      overlay.style.width = `${v.cw}px`;
      overlay.style.height = `${v.ch}px`;
      const bw = Math.floor(v.cw * dpr);
      const bh = Math.floor(v.ch * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      const settings = currentSettings();
      engine.setMatte(item && !compare ? getMatte(item.id) : null, BG_MODEL_SIZE);
      engine.setDepth(item && !compare ? getDepth(item.id) : null);
      engine.setFace(item && !compare ? getFaces(item.id) || null : null);
      const s = st();
      const editing = !compare && !cropping && !healing;
      engine.render(settings, v.view, v.frame, {
        showMask: editing && s.maskOverlay ? s.activeMaskId : null,
        // Subject and face masks get a traced edge; gradients show their handles instead.
        outlineMask:
          editing && s.maskOutline && tracedMask(item?.settings.masks?.find((m) => m.id === s.activeMaskId))
            ? s.activeMaskId
            : null,
      });
      placeMaskHandles(v);
      placeHealOverlay(v);

      const now = performance.now();
      if (forceHistogram || now - lastHist > 120) {
        lastHist = now;
        st().setHistogram(engine.computeHistogram(settings, v.frame));
      }
    });
  };

  const setZoom = (z, c = { x: 0.5, y: 0.5 }) => {
    zoom = z;
    center = c;
    sync();
  };

  // Load the selected image (or its original, while comparing) into the engine
  const loadIfNeeded = () => {
    // The texture changes with healing and the cutout; comparing shows the original.
    const source = item ? sourceKeyOf(item) : '';
    const wantOriginal = compare && source !== '|0';
    const key = item ? `${item.id}|${wantOriginal ? 'original' : source}` : '';
    if (key === loadKey) return;
    loadKey = key;
    if (!item) return;
    const token = ++loadToken;
    const target = item;
    decodeError = null;
    // Cached bitmaps resolve within a frame; only show the spinner for real decodes.
    const spinner = setTimeout(() => {
      if (token === loadToken) {
        loading = true;
        sync();
      }
    }, 120);
    (async () => {
      try {
        const bmp = wantOriginal ? await getOriginalBitmap(target) : await getFullBitmap(target);
        if (token !== loadToken) return;
        engine ??= new GLEngine(canvas);
        engine.setImage(bmp);
        scheduleRender(true);
      } catch (err) {
        if (token === loadToken) decodeError = String(err);
      } finally {
        clearTimeout(spinner);
        if (token === loadToken) {
          loading = false;
          sync();
        }
      }
    })();
  };

  // ---- elements ----
  const errorText = h('p', { style: { maxWidth: '420px', userSelect: 'text' } });
  const errorState = h('div', { className: 'empty-state' }, h('h2', {}, "This photo can't be opened"), errorText);

  const canvas = h('canvas', {
    onPointerDown: (e) => {
      if (pickingFocus) return pickFocusAt(e);
      const size = frameSize();
      if (zoom === 'fit' || cropping || !size) return;
      const start = { x: e.clientX, y: e.clientY, cx: center.x, cy: center.y };
      panning = true;
      sync();
      drag(
        (ev) => {
          center = {
            x: start.cx - (ev.clientX - start.x) / zoom / size.w,
            y: start.cy - (ev.clientY - start.y) / zoom / size.h,
          };
          scheduleRender();
        },
        () => {
          panning = false;
          sync();
        },
      );
    },
    onDblClick: (e) => {
      if (!frameSize() || cropping) return;
      if (zoom !== 'fit') return setZoom('fit');
      const rect = canvas.getBoundingClientRect();
      zoomTo100({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
    },
  });

  const onCropPointerDown = (handle) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!engine) return;
    const rect = overlay.getBoundingClientRect();
    const start = draft;
    const startX = e.clientX;
    const startY = e.clientY;
    const ratio = aspect === 0 ? engine.imgWidth / engine.imgHeight : aspect;
    drag((ev) => {
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      draft =
        handle === 'move'
          ? {
              ...start,
              x: Math.min(1 - start.w, Math.max(0, start.x + dx)),
              y: Math.min(1 - start.h, Math.max(0, start.y + dy)),
            }
          : resizeRect(start, handle, dx, dy, ratio, engine.imgWidth, engine.imgHeight);
      sync();
    });
  };
  const cropRect = h(
    'div',
    { className: 'crop-rect', onPointerDown: onCropPointerDown('move') },
    h('div', { className: 'crop-grid' }),
    RESIZE_HANDLES.map((hd) => h('div', { className: `crop-handle ${hd}`, onPointerDown: onCropPointerDown(hd) })),
  );
  const overlay = h('div', { className: 'crop-overlay' }, cropRect);

  /** One image pixel per device pixel, unless the whole photo already fits at that size. */
  const zoomTo100 = (c) => {
    const z100 = 1 / dpr;
    if (z100 <= fitZoom()) return setZoom('fit');
    setZoom(z100, c);
  };

  const rawTag = h('span', { className: 'raw-tag' }, 'RAW');
  const zoomBadge = h('button', { className: 'zoom-badge', title: 'Fit the photo in the window', onClick: () => setZoom('fit') });
  const zoom100 = h('button', { className: 'zoom-100', title: 'Actual pixels', onClick: () => zoomTo100() }, '100%');
  const loadingEl = h('div', { className: 'preview-loading' });

  const startCrop = () => {
    healing = false;
    zoom = 'fit';
    center = { x: 0.5, y: 0.5 };
    draft = item?.settings.crop ?? FULL_RECT;
    aspect = null;
    cropping = true;
    sync();
  };
  const endCrop = () => {
    cropping = false;
    sync();
  };
  const applyCrop = () => {
    cropping = false;
    st().updateSettings({ crop: isFullCrop(draft) ? null : draft });
    sync();
  };
  const setCompare = (on) => {
    if (compare === on) return;
    compare = on;
    loadIfNeeded();
    sync();
  };

  // ---- Lens blur focus pick ----
  const pickFocusAt = (e) => {
    const v = viewFor();
    const depth = item && getDepth(item.id);
    pickingFocus = false;
    if (v && depth) {
      const rect = canvas.getBoundingClientRect();
      const u = v.view.ox + ((e.clientX - rect.left) / rect.width) * v.view.sx;
      const t = v.view.oy + ((e.clientY - rect.top) / rect.height) * v.view.sy;
      const x = Math.min(depth.width - 1, Math.max(0, Math.floor(u * depth.width)));
      const y = Math.min(depth.height - 1, Math.max(0, Math.floor(t * depth.height)));
      st().updateSettings({ lensFocus: depth.data[y * depth.width + x] / 255, lensEnabled: true });
    } else {
      st().notify('Turn up Blur amount first, so the depth of the photo is measured.');
    }
    sync();
  };

  // ---- Heal brush ----
  const healSvg = svg('svg', { class: 'mask-svg' });
  const brushRing = h('div', { className: 'brush-ring' });
  const healOverlay = h('div', { className: 'heal-overlay' }, healSvg, brushRing);

  /** Pointer → full-image uv through the current view window. */
  const uvAt = (e) => {
    const v = lastView;
    const rect = healOverlay.getBoundingClientRect();
    return [
      v.view.ox + ((e.clientX - rect.left) / rect.width) * v.view.sx,
      v.view.oy + ((e.clientY - rect.top) / rect.height) * v.view.sy,
    ];
  };
  /** Brush radius on screen, in CSS px. */
  const brushPx = () => (lastView && engine ? (brush * engine.imgWidth * lastView.cw) / (lastView.view.sx * engine.imgWidth) : 20);

  healOverlay.addEventListener('pointermove', (e) => {
    const rect = healOverlay.getBoundingClientRect();
    const r = brushPx();
    Object.assign(brushRing.style, {
      width: `${2 * r}px`,
      height: `${2 * r}px`,
      left: `${e.clientX - rect.left - r}px`,
      top: `${e.clientY - rect.top - r}px`,
    });
    brushRing.hidden = false;
  });
  healOverlay.addEventListener('pointerleave', () => (brushRing.hidden = true));
  healOverlay.addEventListener('pointerdown', (e) => {
    if (!lastView || st().busy || e.button !== 0) return;
    e.preventDefault();
    painting = [uvAt(e)];
    const minStep = brush / 3;
    drag(
      (ev) => {
        const p = uvAt(ev);
        const last = painting[painting.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < minStep) return;
        painting.push(p);
        placeHealOverlay(lastView);
      },
      () => {
        const points = painting;
        painting = null;
        placeHealOverlay(lastView);
        void st().addHealStroke(points, brush);
      },
    );
    placeHealOverlay(lastView);
  });

  /** Earlier strokes as dashed outlines, the stroke being painted as a filled band. */
  function placeHealOverlay(v) {
    healOverlay.hidden = !(healing && item && !compare);
    if (healOverlay.hidden || !engine) return;
    healOverlay.style.width = `${v.cw}px`;
    healOverlay.style.height = `${v.ch}px`;
    healSvg.setAttribute('viewBox', `0 0 ${v.cw} ${v.ch}`);
    const X = (u) => ((u - v.view.ox) / v.view.sx) * v.cw;
    const Y = (t) => ((t - v.view.oy) / v.view.sy) * v.ch;
    const toPath = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(' ') + (pts.length === 1 ? ' l0.01 0' : '');
    const width = (r) => (2 * r * v.cw) / v.view.sx;
    const nodes = (item.settings.heal ?? []).map((stroke) =>
      svg('path', { d: toPath(stroke.points), class: 'heal-done', 'stroke-width': width(stroke.r) }),
    );
    if (painting) nodes.push(svg('path', { d: toPath(painting), class: 'heal-live', 'stroke-width': width(brush) }));
    healSvg.replaceChildren(...nodes);
  }

  const brushInput = h('input', {
    type: 'range',
    className: 'range',
    min: '0.003',
    max: '0.08',
    step: '0.001',
    value: String(brush),
    'aria-label': 'Brush size',
    onInput: () => (brush = Number(brushInput.value)),
  });
  const healCount = h('span', { className: 'crop-size' });
  const healBar = h(
    'div',
    { className: 'crop-bar' },
    h('span', { className: 'heal-hint' }, 'Paint over what to remove'),
    h('label', { className: 'heal-size' }, 'Brush', brushInput),
    healCount,
    h('div', { className: 'vsep' }),
    h('button', { className: 'btn primary', onClick: () => endHeal() }, 'Done'),
  );
  const startHeal = () => {
    cropping = false;
    healing = true;
    sync();
  };
  const endHeal = () => {
    healing = false;
    painting = null;
    sync();
  };

  // ---- Rating and flags for the photo in view (applies to the whole selection) ----
  const pickBtn = h('button', { className: 'rate-btn pick', title: 'Pick (P)', 'aria-label': 'Pick', onClick: () => st().setFlag('pick') }, icon('flag', 16));
  const rejectBtn = h('button', { className: 'rate-btn reject', title: 'Reject (X)', 'aria-label': 'Reject', onClick: () => st().setFlag('reject') }, icon('close', 16));
  const starBtns = [1, 2, 3, 4, 5].map((n) =>
    h(
      'button',
      {
        className: 'rate-btn star',
        title: `${n} star${n === 1 ? '' : 's'} (${n}) · click again to clear`,
        'aria-label': `${n} star${n === 1 ? '' : 's'}`,
        onClick: () => st().setRating(item?.rating === n ? 0 : n),
      },
      '★',
    ),
  );
  const rateBar = h('div', { className: 'rate-bar' }, pickBtn, rejectBtn, h('span', { className: 'rate-sep' }), starBtns);

  const fileName = h('span', { className: 'preview-name' });
  const compareBadge = h('span', { className: 'compare-badge' }, 'Original');
  const tools = h(
    'div',
    { className: 'preview-tools' },
    h('div', { className: 'preview-left' }, fileName, rateBar),
    h(
      'button',
      {
        className: 'btn floating',
        'data-action': 'compare',
        title: 'Hold to see the photo without your edits',
        onPointerDown: () => setCompare(true),
        onPointerUp: () => setCompare(false),
        onPointerLeave: () => setCompare(false),
        onKeyDown: (e) => (e.key === ' ' || e.key === 'Enter') && setCompare(true),
        onKeyUp: () => setCompare(false),
      },
      icon('compare'),
      'Hold to see original',
    ),
    h('div', { className: 'zoom-group' }, zoomBadge, zoom100),
  );

  const aspectBtns = ASPECTS.map((a) =>
    h(
      'button',
      {
        className: 'btn',
        onClick: () => {
          aspect = a.value;
          if (a.value !== null && engine) {
            const ratio = a.value === 0 ? engine.imgWidth / engine.imgHeight : a.value;
            draft = fitAspect(draft, ratio, engine.imgWidth, engine.imgHeight);
          }
          sync();
        },
      },
      a.label,
    ),
  );
  const cropSize = h('span', { className: 'crop-size' });
  const cropBar = h(
    'div',
    { className: 'crop-bar' },
    aspectBtns,
    cropSize,
    h('div', { className: 'vsep' }),
    h(
      'button',
      {
        className: 'btn',
        onClick: () => {
          draft = FULL_RECT;
          aspect = null;
          sync();
        },
      },
      'Reset',
    ),
    h('button', { className: 'btn', onClick: endCrop }, 'Cancel'),
    h('button', { className: 'btn primary', onClick: applyCrop }, 'Apply'),
  );

  // ---- Gradient mask handles ----
  // Geometry is stored in full-image uv; the overlay covers the canvas, whose
  // visible window into the image is v.view.
  const maskSvg = svg('svg', { class: 'mask-svg' });
  const maskOverlay = h('div', { className: 'mask-overlay' }, maskSvg);
  let lastView = null;

  const activeGradient = () => {
    const s = st();
    if (!item || cropping || healing || compare || !s.activeMaskId || !s.maskOutline) return null;
    const m = item.settings.masks?.find((x) => x.id === s.activeMaskId);
    return m && (m.type === 'linear' || m.type === 'radial') ? m : null;
  };

  /** Drag a handle: `apply(du, dv, startGeo)` returns the geo patch for a move in uv units. */
  const onHandle = (mask, apply) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const v = lastView;
    if (!v) return;
    const rect = maskOverlay.getBoundingClientRect();
    const start = { ...mask.geo };
    const x0 = e.clientX;
    const y0 = e.clientY;
    drag((ev) => {
      const du = ((ev.clientX - x0) / rect.width) * v.view.sx;
      const dv = ((ev.clientY - y0) / rect.height) * v.view.sy;
      st().updateMask(mask.id, { geo: apply(du, dv, start) });
    });
  };

  /** Numbered badges on each face while a face mask is being edited; click one to toggle it. */
  const placeFaceBadges = (v) => {
    const s = st();
    const mask = !item || cropping || healing || compare || !s.maskOutline ? null : item.settings.masks?.find((m) => m.id === s.activeMaskId);
    const faces = mask && isFaceMask(mask.type) ? getFaces(item.id) : null;
    if (!faces || faces.faces < 2) return false;
    maskOverlay.style.width = `${v.cw}px`;
    maskOverlay.style.height = `${v.ch}px`;
    maskSvg.setAttribute('viewBox', `0 0 ${v.cw} ${v.ch}`);
    const nodes = faces.boxes.map((b, i) => {
      const on = mask.faces == null || mask.faces.includes(i);
      const x = (((b.x0 + b.x1) / 2 - v.view.ox) / v.view.sx) * v.cw;
      const y = ((b.y0 - v.view.oy) / v.view.sy) * v.ch - 16;
      const g = svg('g', { class: on ? 'face-badge on' : 'face-badge', transform: `translate(${x} ${Math.max(14, y)})` });
      g.append(svg('circle', { r: 12 }));
      const t = svg('text', { 'text-anchor': 'middle', dy: '0.35em' });
      t.textContent = String(i + 1);
      const title = svg('title');
      title.textContent = on ? `Face ${i + 1} (included): click to leave it out` : `Face ${i + 1}: click to include it`;
      g.append(t, title);
      g.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const all = mask.faces == null;
        const next = all ? [i] : mask.faces.includes(i) ? mask.faces.filter((f) => f !== i) : [...mask.faces, i];
        st().setMaskFaces(mask.id, next.length ? next : null);
      });
      return g;
    });
    maskSvg.replaceChildren(...nodes);
    return true;
  };

  function placeMaskHandles(v) {
    lastView = v;
    if (placeFaceBadges(v)) {
      maskOverlay.hidden = false;
      return;
    }
    const mask = activeGradient();
    maskOverlay.hidden = !mask;
    if (!mask) return;
    maskOverlay.style.width = `${v.cw}px`;
    maskOverlay.style.height = `${v.ch}px`;
    maskSvg.setAttribute('viewBox', `0 0 ${v.cw} ${v.ch}`);
    const X = (u) => ((u - v.view.ox) / v.view.sx) * v.cw;
    const Y = (t) => ((t - v.view.oy) / v.view.sy) * v.ch;
    const g = mask.geo;
    const nodes = [];
    const handle = (cx, cy, cls, title, apply) => {
      const c = svg('circle', { cx, cy, r: 7, class: `mask-handle ${cls}` });
      const t = svg('title');
      t.textContent = title;
      c.append(t);
      c.addEventListener('pointerdown', onHandle(mask, apply));
      nodes.push(c);
    };
    if (mask.type === 'linear') {
      const ax = X(g.x0);
      const ay = Y(g.y0);
      const bx = X(g.x1);
      const by = Y(g.y1);
      // Lines across the frame at both ends, perpendicular to the gradient.
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const px = (-(by - ay) / len) * (v.cw + v.ch);
      const py = ((bx - ax) / len) * (v.cw + v.ch);
      for (const [x, y, cls] of [[ax, ay, 'start'], [bx, by, 'end']]) {
        nodes.push(svg('line', { x1: x - px, y1: y - py, x2: x + px, y2: y + py, class: `mask-line ${cls}` }));
      }
      nodes.push(svg('line', { x1: ax, y1: ay, x2: bx, y2: by, class: 'mask-line axis' }));
      handle((ax + bx) / 2, (ay + by) / 2, 'move', 'Drag to move', (du, dv, s0) => ({
        x0: s0.x0 + du, y0: s0.y0 + dv, x1: s0.x1 + du, y1: s0.y1 + dv,
      }));
      handle(ax, ay, 'start', 'Full effect starts here', (du, dv, s0) => ({ x0: s0.x0 + du, y0: s0.y0 + dv }));
      handle(bx, by, 'end', 'Effect fades out by here', (du, dv, s0) => ({ x1: s0.x1 + du, y1: s0.y1 + dv }));
    } else {
      const cx = X(g.cx);
      const cy = Y(g.cy);
      const rx = (g.rx / v.view.sx) * v.cw;
      const ry = (g.ry / v.view.sy) * v.ch;
      const inner = Math.max(0, 1 - g.feather);
      nodes.push(svg('ellipse', { cx, cy, rx, ry, class: 'mask-line' }));
      if (inner > 0) nodes.push(svg('ellipse', { cx, cy, rx: rx * inner, ry: ry * inner, class: 'mask-line inner' }));
      handle(cx, cy, 'move', 'Drag to move', (du, dv, s0) => ({ cx: s0.cx + du, cy: s0.cy + dv }));
      handle(cx + rx, cy, 'edge', 'Drag to resize sideways', (du, dv, s0) => ({ rx: Math.max(0.01, s0.rx + du) }));
      handle(cx, cy + ry, 'edge', 'Drag to resize up and down', (du, dv, s0) => ({ ry: Math.max(0.01, s0.ry + dv) }));
    }
    maskSvg.replaceChildren(...nodes);
  }

  const el = h(
    'div',
    { className: 'preview' },
    errorState,
    canvas,
    overlay,
    maskOverlay,
    healOverlay,
    rawTag,
    compareBadge,
    loadingEl,
    tools,
    cropBar,
    healBar,
  );

  /** Bring every element in line with the current state, then re-render. */
  function sync() {
    const hasImages = st().images.length > 0;
    const showImage = hasImages && !decodeError;
    errorState.hidden = !hasImages || !decodeError;
    errorText.textContent = decodeError ?? '';
    canvas.hidden = !showImage;
    canvas.className = [
      zoom === 'fit' || cropping ? '' : panning ? 'grabbing' : 'grab',
      shown()?.bgRemoved && !compare ? 'bg-checker' : '',
    ]
      .filter(Boolean)
      .join(' ');
    canvas.title = pickingFocus
      ? 'Click what should be in focus'
      : cropping
        ? ''
        : 'Scroll to zoom · double-click for 100% · drag to pan';
    canvas.classList.toggle('picking', pickingFocus);

    overlay.hidden = !(showImage && cropping);
    Object.assign(cropRect.style, {
      left: `${draft.x * 100}%`,
      top: `${draft.y * 100}%`,
      width: `${draft.w * 100}%`,
      height: `${draft.h * 100}%`,
    });

    rawTag.hidden = !(showImage && item?.isRaw);
    zoomBadge.textContent = zoom === 'fit' ? 'Fit' : `${Math.round(zoom * dpr * 100)}%`;
    zoom100.classList.toggle('active', zoom !== 'fit' && Math.abs(zoom * dpr - 1) < 0.01);
    zoomBadge.classList.toggle('active', !zoom100.classList.contains('active'));
    compareBadge.hidden = !(showImage && compare);
    fileName.textContent = item?.name ?? '';
    pickBtn.classList.toggle('on', item?.flag === 'pick');
    rejectBtn.classList.toggle('on', item?.flag === 'reject');
    starBtns.forEach((b, i) => b.classList.toggle('on', (item?.rating ?? 0) > i));
    loadingEl.hidden = !(hasImages && loading);
    loadingEl.textContent = `Decoding${item?.isRaw ? ' RAW' : ''}…`;

    tools.hidden = !(item && showImage && !cropping && !healing);
    cropBar.hidden = !(item && showImage && cropping);
    healBar.hidden = !(item && showImage && healing);
    const spots = item?.settings.heal?.length ?? 0;
    healCount.textContent = spots ? `${spots} healed · Ctrl+Z to undo` : '';
    ASPECTS.forEach((a, i) => (aspectBtns[i].className = aspect === a.value ? 'btn active' : 'btn'));
    cropSize.textContent =
      engine && engine.hasImage
        ? `${Math.round(draft.w * engine.imgWidth)} × ${Math.round(draft.h * engine.imgHeight)}`
        : '';

    scheduleRender();
  }

  bind(
    (s) => [selectedImage(s), s.images.length],
    ([next]) => {
      if (next?.id !== item?.id) {
        healing = false;
        // Reset the view when a different photo is selected
        zoom = 'fit';
        center = { x: 0.5, y: 0.5 };
        cropping = false;
      }
      item = next;
      loadIfNeeded();
      sync();
    },
  );

  // Mask editing state and newly computed mattes only need a re-render.
  bind(
    (s) => [s.activeMaskId, s.maskOverlay, s.maskOutline, s.matteVersion],
    () => scheduleRender(),
  );

  // "Pick focus on the photo": the next click on the canvas sets the focus.
  bind(
    (s) => s.focusPickRequest,
    (n) => {
      if (!n || !item) return;
      pickingFocus = true;
      healing = false;
      cropping = false;
      sync();
    },
  );

  // The panel's Heal button asks for brush mode the same way.
  bind(
    (s) => s.healRequest,
    (n) => {
      if (n && item && !decodeError) startHeal();
    },
  );

  // The panel's Crop button asks for crop mode through the store.
  bind(
    (s) => s.cropRequest,
    (n) => {
      if (n && item && !decodeError) startCrop();
    },
  );

  // Leave room for the toolbar under the photo.
  new ResizeObserver(() => {
    box = { w: el.clientWidth - 48, h: el.clientHeight - 128 };
    scheduleRender();
  }).observe(el);

  // Wheel zoom, anchored on the image point under the cursor
  el.addEventListener(
    'wheel',
    (e) => {
      const size = frameSize();
      if (!size || cropping) return;
      e.preventDefault();
      const zFit = fitZoom();
      const current = zoom === 'fit' ? zFit : zoom;
      const next = Math.min(8, current * Math.exp(-e.deltaY * 0.0016));
      if (next <= zFit * 1.02) return setZoom('fit');
      // Cursor position in cropped-frame coordinates
      const v = viewFor();
      const rect = canvas.getBoundingClientRect();
      const mx = clamp01((e.clientX - rect.left) / rect.width);
      const my = clamp01((e.clientY - rect.top) / rect.height);
      const uvX = v ? (v.view.ox - v.frame.ox + mx * v.view.sx) / v.frame.sx : 0.5;
      const uvY = v ? (v.view.oy - v.frame.oy + my * v.view.sy) / v.frame.sy : 0.5;
      const sx = Math.max(1, box.w) / next / size.w;
      const sy = Math.max(1, box.h) / next / size.h;
      setZoom(next, { x: uvX - mx * sx + sx / 2, y: uvY - my * sy + sy / 2 });
    },
    { passive: false },
  );

  // Enter applies the crop, Escape leaves it untouched
  window.addEventListener('keydown', (e) => {
    if (pickingFocus && e.key === 'Escape') {
      pickingFocus = false;
      sync();
      return;
    }
    if (healing && (e.key === 'Escape' || e.key === 'Enter')) {
      e.preventDefault();
      endHeal();
      return;
    }
    if (!cropping) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      endCrop();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      applyCrop();
    }
  });

  return el;
}
