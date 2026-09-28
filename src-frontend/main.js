import './theme.js'; // applies the saved theme before the first paint
import { App } from './App.js';
import { backend } from './backend.js';

const smokeErrors = [];
window.addEventListener('error', (e) => smokeErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) =>
  smokeErrors.push(String(e.reason)),
);

document.getElementById('root').append(App());

// Smoke-test hook: exercises the full pipeline (import → auto enhance →
// export) when SABATTIER_SMOKE_IMPORT is set, then reports to the Rust backend.
// smokeConfig() is null unless SABATTIER_SMOKE=1, so this is a no-op in normal runs.
async function smokeFlow(info, smoke) {
  const { store } = await import('./state/store.js');
  const importPaths = smoke.importPath.split(';').filter(Boolean);
  const selected = () => {
    const st = store.getState();
    return st.images.find((i) => i.id === st.selectedId);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await store.getState().importPaths(importPaths);
  for (let i = 0; i < 200; i++) {
    const images = store.getState().images;
    if (images.length && images.every((im) => im.status !== 'pending')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  info.push(`import:${store.getState().images.map((i) => i.status).join(',')}`);
  for (const im of store.getState().images) {
    if (im.status === 'error') info.push(`import-error[${im.name}]:${im.error}`);
  }

  // Shift-click straight after import: the range must start at the
  // auto-selected first photo, via a real click on the thumbnail.
  {
    const thumbs = document.querySelectorAll('.filmstrip .thumb');
    const last = thumbs[thumbs.length - 1];
    last?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    const st = store.getState();
    const ok = thumbs.length > 1 && st.selectedIds.length === st.images.length;
    info.push(`shift-range:${ok ? 'ok' : 'FAIL'} (${st.selectedIds.length}/${st.images.length})`);
    st.select(st.images[0].id);
  }

  await store.getState().autoEnhanceAll();
  for (const item of store.getState().images) {
    const st = item.settings;
    info.push(
      `auto[${item.name}]:${JSON.stringify({
        t: +st.temperature.toFixed(2),
        ti: +st.tint.toFixed(2),
        exp: +st.exposure.toFixed(2),
        br: +st.brightness.toFixed(2),
        hi: +st.highlights.toFixed(2),
        sh: +st.shadows.toFixed(2),
        bp: +st.blackPoint.toFixed(2),
        con: +st.contrast.toFixed(2),
        vib: +st.vibrance.toFixed(2),
      })}`,
    );
  }

  // Background removal: run the ML cutout on the selected photo, then make
  // sure undo restores the flag and redo brings the cutout back.
  await store.getState().removeBackgroundSelected();
  const bgOn = selected().settings.bgRemoved;
  store.getState().undo();
  const bgUndone = selected().settings.bgRemoved;
  store.getState().redo();
  const bgRedone = selected().settings.bgRemoved;
  info.push(`bg-remove:${bgOn && !bgUndone && bgRedone ? 'ok' : 'FAIL'} (${bgOn}/${bgUndone}/${bgRedone})`);

  // Crop: undo/redo of the rectangle, and the cropped render size end-to-end.
  const rect = { x: 0.25, y: 0.1, w: 0.5, h: 0.6 };
  store.getState().updateSettings({ crop: rect });
  const cropSet = JSON.stringify(selected().settings.crop) === JSON.stringify(rect);
  store.getState().undo();
  const cropUndone = selected().settings.crop === null;
  store.getState().redo();
  info.push(`crop-undo:${cropSet && cropUndone && selected().settings.crop ? 'ok' : 'FAIL'}`);
  {
    const { getFullBitmap } = await import('./state/store.js');
    const { renderToBlob } = await import('./engine/export.js');
    const bmp = await getFullBitmap(selected());
    const blob = await renderToBlob(bmp, selected().settings, 0.9);
    const out = await createImageBitmap(blob);
    const expW = Math.round(rect.w * bmp.width);
    const expH = Math.round(rect.h * bmp.height);
    const ok = Math.abs(out.width - expW) <= 1 && Math.abs(out.height - expH) <= 1;
    info.push(`crop-render:${ok ? 'ok' : 'FAIL'} (${out.width}x${out.height} vs ${expW}x${expH})`);
    out.close();
  }

  // Export pipeline: resized + suffixed, then again to prove collision-safe naming.
  if (smoke.exportPath) {
    const opts = { dir: smoke.exportPath, quality: 0.9, maxDim: 512, suffix: '-s' };
    await store.getState().exportAll(opts);
    await store.getState().exportAll(opts);
    info.push('export:2 runs (512px, -s suffix)');
  }

  // Preset round-trip: save from the selected photo, bulk-apply, delete.
  await store.getState().savePreset('smoke-preset');
  store.getState().applyPresetToAll('smoke-preset');
  const applied = store.getState().images;
  // bgRemoved and crop are per-photo and survive preset application by design.
  const comparable = (s) =>
    JSON.stringify({ ...s, bgRemoved: false, crop: null, masks: [] });
  const firstSettings = comparable(applied[0]?.settings);
  info.push(
    `preset-bulk:${applied.every((i) => comparable(i.settings) === firstSettings)}`,
  );
  // Multi-select: Cmd-click two of three photos, apply a preset to just those.
  const all = store.getState().images;
  if (all.length >= 3) {
    const st = store.getState();
    st.select(all[0].id);
    st.updateSettings({ exposure: 0.3 });
    await st.savePreset('smoke-multi'); // saved from photo 1: exposure 0.3
    for (const im of [all[1], all[2]]) {
      st.setSettings(im.id, { ...store.getState().images.find((i) => i.id === im.id).settings, exposure: -0.5 });
    }
    st.select(all[2].id, 'toggle');
    const sel = store.getState().selectedIds.join(',');
    const before = store.getState().images.map((i) => i.settings.exposure);
    store.getState().applyPreset('smoke-multi');
    const after = store.getState().images.map((i) => i.settings.exposure);
    store.getState().undo();
    const undone = store.getState().images.map((i) => i.settings.exposure);
    const ok =
      sel === `${all[0].id},${all[2].id}` &&
      after[1] === -0.5 &&
      after[2] === 0.3 &&
      JSON.stringify(undone) === JSON.stringify(before);
    info.push(`multi-select-preset:${ok ? 'ok' : 'FAIL'} (${before} -> ${after} -> ${undone})`);
    await store.getState().deletePreset('smoke-multi');
    store.getState().select(all[0].id);
    await sleep(200); // let the panel re-render for the selection before the checks below
  }
  await store.getState().deletePreset('smoke-preset');

  // Edit list: unticking an edit stops it rendering but keeps its value,
  // ticking brings it back, the red button removes it. Driven through the DOM.
  {
    const { effectiveSettings } = await import('./engine/types.js');
    store.getState().updateSettings({ contrast: 0.4 });
    await sleep(100);
    const box = () => document.querySelector('#edit-contrast');
    box()?.click();
    await sleep(100);
    const off = selected().settings.contrast === 0.4 && effectiveSettings(selected().settings).contrast === 0;
    box()?.click();
    await sleep(100);
    const on = effectiveSettings(selected().settings).contrast === 0.4;
    // The red button asks first (default setting); confirm in the dialog.
    box()?.closest('li')?.querySelector('.edit-delete')?.click();
    await sleep(100);
    const asked = !!document.querySelector('.confirm-dialog:not([hidden])') && selected().settings.contrast === 0.4;
    document.querySelector('[data-action="confirm-remove"]')?.click();
    await sleep(100);
    const gone = selected().settings.contrast === 0 && !box();
    info.push(`edit-list:${off && on && asked && gone ? 'ok' : 'FAIL'} (${off}/${on}/${asked}/${gone})`);
  }

  // Presets folder: switching to an empty folder copies the presets there.
  if (smoke.exportPath) {
    const dir = `${smoke.exportPath}/presets-test`;
    const before = store.getState().presets.length;
    await store.getState().setPresetsDir(dir);
    const exists = await backend.presetsExist(dir);
    await store.getState().setPresetsDir(null);
    info.push(`presets-dir:${exists && store.getState().presets.length === before ? 'ok' : 'FAIL'} (${exists})`);
  }
  info.push(`preset-deleted:${!store.getState().presets.some((p) => p.name === 'smoke-preset')}`);

  // Histogram scrubbing: synthetic drag in the exposure zone must change the slider.
  // The histogram lives on the panel's Fine-tune tab.
  document.querySelector('[data-mode="fine"]')?.click();
  await sleep(100);
  const histCanvas = document.querySelector('.hist-canvas');
  if (histCanvas) {
    const before = selected().settings.exposure;
    const r = histCanvas.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const x0 = r.left + r.width * 0.6; // inside the Exposure band
    const opts = { bubbles: true, pointerId: 1, isPrimary: true };
    histCanvas.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x0, clientY: y }));
    await new Promise((res) => setTimeout(res, 60));
    window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x0 + 40, clientY: y }));
    await new Promise((res) => setTimeout(res, 60));
    window.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x0 + 40, clientY: y }));
    const after = selected().settings.exposure;
    info.push(`hist-drag:${before.toFixed(2)}->${after.toFixed(2)}:${after > before ? 'ok' : 'FAIL'}`);

    // Undo/redo: the drag was one history step; undo restores, redo reapplies.
    store.getState().undo();
    const undone = selected().settings.exposure;
    store.getState().redo();
    const redone = selected().settings.exposure;
    info.push(
      `undo-redo:${after.toFixed(2)}->${undone.toFixed(2)}->${redone.toFixed(2)}:${
        undone === before && redone === after ? 'ok' : 'FAIL'
      }`,
    );
  } else {
    info.push('hist-drag:no-canvas');
  }

  // Zoom: a wheel-up over the preview must enlarge the canvas and show a % badge.
  const previewCanvas = document.querySelector('.preview canvas');
  if (previewCanvas) {
    const sizeOf = () => `${previewCanvas.style.width}×${previewCanvas.style.height}`;
    const sizeBefore = sizeOf();
    const r = previewCanvas.getBoundingClientRect();
    previewCanvas.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -800,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
    await sleep(200);
    const badge = document.querySelector('.zoom-badge')?.textContent ?? '?';
    const ok = badge.endsWith('%') && sizeOf() !== sizeBefore;
    info.push(`zoom:${sizeBefore}->${sizeOf()} badge:${badge}:${ok ? 'ok' : 'FAIL'}`);
  }

  // Back to Fit before the overlay checks below.
  (document.querySelector('.zoom-badge'))?.click();
  await sleep(200);

  // Compare must show the *original* pixels: on a background-removed photo the
  // transparent area has to disappear while the button is held.
  const transparentFraction = () => {
    const c = document.querySelector('.preview canvas');
    if (!c) return -1;
    const off = new OffscreenCanvas(c.width, c.height);
    const ctx = off.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, off.width, off.height);
    ctx.drawImage(c, 0, 0);
    const data = ctx.getImageData(0, 0, off.width, off.height).data;
    let clear = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 8) clear++;
    return clear / (data.length / 4);
  };
  const compareBtn = document.querySelector('[data-action="compare"]');
  if (compareBtn) {
    const cutout = transparentFraction();
    const pOpts = { bubbles: true, pointerId: 2, isPrimary: true };
    compareBtn.dispatchEvent(new PointerEvent('pointerdown', pOpts));
    await sleep(400);
    const original = transparentFraction();
    compareBtn.dispatchEvent(new PointerEvent('pointerup', pOpts));
    await sleep(300);
    const restored = transparentFraction();
    const ok = cutout > 0.05 && original < 0.01 && restored > 0.05;
    info.push(
      `compare-bg:${ok ? 'ok' : 'FAIL'} (${cutout.toFixed(2)}/${original.toFixed(2)}/${restored.toFixed(2)})`,
    );
  } else {
    info.push('compare-bg:no-button');
  }

  // Crop overlay: open it, drag the SE handle inward, apply, and check the rect.
  // Crop is a one-click fix on the panel's Quick tab.
  document.querySelector('[data-mode="quick"]')?.click();
  const cropBtn = document.querySelector('[data-action="crop"]');
  if (cropBtn) {
    cropBtn.click();
    await sleep(200);
    const overlay = document.querySelector('.crop-overlay');
    const handle = document.querySelector('.crop-handle.se');
    if (overlay && handle) {
      const or = overlay.getBoundingClientRect();
      const hr = handle.getBoundingClientRect();
      const opts = { bubbles: true, pointerId: 3, isPrimary: true };
      const x0 = hr.left + hr.width / 2;
      const y0 = hr.top + hr.height / 2;
      handle.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x0, clientY: y0 }));
      await sleep(60);
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          ...opts,
          clientX: x0 - or.width * 0.25,
          clientY: y0 - or.height * 0.25,
        }),
      );
      await sleep(60);
      window.dispatchEvent(new PointerEvent('pointerup', { ...opts }));
      await sleep(60);
      const rectEl = document.querySelector('.crop-rect');
      const dragged = rectEl.style.width;
      (
        [...document.querySelectorAll('.crop-bar .btn')].find(
          (b) => b.textContent === 'Apply',
        )
      ).click();
      await sleep(250);
      const c = selected().settings.crop;
      // Started from the rect applied above (0.5 x 0.6), dragged in by a quarter
      // of the full frame in each direction.
      const ok = Math.abs(c.w - 0.25) < 0.02 && Math.abs(c.h - 0.35) < 0.02;
      info.push(`crop-ui:${ok ? 'ok' : 'FAIL'} (${dragged} -> ${c.w.toFixed(2)}x${c.h.toFixed(2)})`);
    } else {
      info.push('crop-ui:no-overlay');
    }
  }

  await newFeatureChecks(info, smoke, selected, sleep);
  await roundTwoChecks(info, selected, sleep);
}

/** Deselect all, mask outlines, masks in copies, the ratings catalog, healing. */
async function roundTwoChecks(info, selected, sleep) {
  const { store, getFullBitmap, getMatte } = await import('./state/store.js');
  const st = store.getState;
  const images = () => st().images;

  // Select all ⇄ Deselect all
  {
    const btn = [...document.querySelectorAll('.filmstrip-head .link-btn')].find((b) => /select all/i.test(b.textContent));
    st().setFilter('all');
    st().select(images()[0].id);
    btn.click();
    await sleep(50);
    const all = st().selectedIds.length === images().length && btn.textContent === 'Deselect all';
    btn.click();
    await sleep(50);
    const one = st().selectedIds.length === 1 && st().selectedIds[0] === images()[0].id && btn.textContent === 'Select all';
    info.push(`deselect-all:${all && one ? 'ok' : 'FAIL'} (${all}/${one})`);
  }

  // Ratings saved in an earlier session come back on import (catalog stub
  // was seeded with IMG_2372 = 4 stars, pick), and new ones are written.
  {
    const seeded = images().find((i) => i.name === 'IMG_2372.jpeg');
    const loaded = seeded?.rating === 4 && seeded?.flag === 'pick';
    st().select(images()[1].id);
    st().setRating(2);
    await sleep(50);
    const written = window.__CATALOG?.[images()[1].path]?.rating === 2;
    st().setRating(0);
    if (st().images[1].flag) st().setFlag(st().images[1].flag); // same flag again clears it
    await sleep(50);
    const cleared = !window.__CATALOG?.[images()[1].path];
    info.push(`catalog:${loaded && written && cleared ? 'ok' : 'FAIL'} (${loaded}/${written}/${cleared})`);
  }

  // Subject outline: drawn on the preview while the mask is selected and
  // "Show outline" is on; gone when switched off.
  {
    st().select(images()[0].id);
    await sleep(300);
    await st().addMask('subject');
    await sleep(400);
    const grab = () => {
      const c = document.querySelector('.preview canvas');
      const off = new OffscreenCanvas(c.width, c.height);
      const ctx = off.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(c, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    st().setMaskOutline(true);
    await sleep(300);
    const on = grab();
    st().setMaskOutline(false);
    await sleep(300);
    const off = grab();
    let diff = 0;
    for (let i = 0; i < on.length; i += 4) if (Math.abs(on[i] - off[i]) > 40) diff++;
    const toggle = document.querySelector('#mask-outline');
    info.push(`mask-outline:${diff > 100 && toggle ? 'ok' : 'FAIL'} (${diff} px on the edge)`);
    st().setMaskOutline(true);
  }

  // Masks travel with "Copy these edits to all"; subject mattes are computed
  // for the photos that get a subject mask.
  {
    st().applyToAll();
    for (let i = 0; i < 100 && images().some((im) => !getMatte(im.id)); i++) await sleep(100);
    const ok = images().every((im) => im.settings.masks?.some((m) => m.type === 'subject') && getMatte(im.id));
    info.push(`masks-copy:${ok ? 'ok' : 'FAIL'}`);
    st().undo(); // copy
    st().undo(); // mask
  }

  // Healing, driven through the UI: Remove spots → paint a stroke → patched pixels.
  {
    st().select(images()[0].id);
    document.querySelector('[data-mode="quick"]')?.click();
    await sleep(300);
    document.querySelector('[data-action="heal"]')?.click();
    await sleep(300);
    const overlay = document.querySelector('.heal-overlay');
    const visible = overlay && !overlay.hidden;
    const r = overlay.getBoundingClientRect();
    const opts = { bubbles: true, pointerId: 7, isPrimary: true, button: 0 };
    const at = (fx, fy) => ({ ...opts, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy });
    const before = window.__INPAINTS ?? 0;
    const pre = await getFullBitmap(selected()); // may be a cutout from the earlier steps
    overlay.dispatchEvent(new PointerEvent('pointerdown', at(0.4, 0.3)));
    for (let k = 1; k <= 5; k++) window.dispatchEvent(new PointerEvent('pointermove', at(0.4 + k * 0.04, 0.3)));
    window.dispatchEvent(new PointerEvent('pointerup', at(0.6, 0.3)));
    for (let i = 0; i < 50 && !selected().settings.heal?.length; i++) await sleep(100);
    const stroke = selected().settings.heal?.[0];
    const ran = (window.__INPAINTS ?? 0) === before + 1;
    // The healed source differs from the pre-stroke source under the stroke only.
    const healed = await getFullBitmap(selected());
    const sample = (bmp, fx, fy) => {
      const c = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      c.drawImage(bmp, Math.floor(bmp.width * fx), Math.floor(bmp.height * fy), 1, 1, 0, 0, 1, 1);
      return [...c.getImageData(0, 0, 1, 1).data];
    };
    const same = (a, b, fx, fy) => sample(a, fx, fy).every((v, i) => v === sample(b, fx, fy)[i]);
    // Stroke centre in image coordinates (the overlay covers the cropped frame).
    const [cu, cv] = stroke.points[Math.floor(stroke.points.length / 2)];
    const under = !same(pre, healed, cu, cv);
    const far = same(pre, healed, 0.02, 0.98) && same(pre, healed, 0.98, 0.02);
    st().undo();
    const undone = !selected().settings.heal?.length && same(await getFullBitmap(selected()), pre, cu, cv);
    st().redo();
    const again = selected().settings.heal?.length === 1 && (window.__INPAINTS ?? 0) === before + 1; // cached, no re-run
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await sleep(100);
    info.push(
      `heal:${visible && stroke?.points.length > 2 && ran && under && far && undone && again ? 'ok' : 'FAIL'} ` +
        `(${visible}/${stroke?.points.length}/${ran}/${under}/${far}/${undone}/${again})`,
    );
  }

  // Lens blur through the UI: amount → depth measured once → pick focus by clicking.
  {
    const { getDepth } = await import('./state/store.js');
    st().select(images()[0].id);
    await sleep(200);
    st().updateSettings({ lensBlur: 0.5, lensEnabled: true });
    st().prepareModels();
    for (let i = 0; i < 50 && !getDepth(selected().id); i++) await sleep(100);
    const measured = !!getDepth(selected().id) && window.__DEPTHS >= 1;
    st().requestFocusPick();
    await sleep(100);
    const c = document.querySelector('.preview canvas');
    const r = c.getBoundingClientRect();
    // Near the top of the frame: the stand-in depth there is far (small).
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + 3, button: 0 }));
    await sleep(100);
    const focus = selected().settings.lensFocus;
    const runs = window.__DEPTHS;
    st().updateSettings({ lensBlur: 0.7 }); // more changes: no new depth run
    st().prepareModels();
    await sleep(200);
    const cached = window.__DEPTHS === runs;
    info.push(`lens-ui:${measured && focus !== null && focus < 0.35 && cached ? 'ok' : 'FAIL'} (${measured}/${focus?.toFixed(2)}/${cached})`);
    st().updateSettings({ lensBlur: 0, lensFocus: null });
  }

  // AI upscale on export: 4× where it fits under 8192 px, else 2×.
  {
    const saved = structuredClone(st().exportPrefs);
    st().setExportPrefs({ format: 'jpeg', upscale: 4, watermark: { enabled: false } });
    await st().exportAll({ dir: '/out/upscaled', quality: 0.9, maxDim: 1024, suffix: '-up', onlyShown: false });
    st().setExportPrefs(saved);
    const outs = Object.entries(window.__FS).filter(([p]) => p.startsWith('/out/upscaled/'));
    const ok = outs.length === images().length && outs.every(([, f]) => f.factor >= 2 && Math.max(f.w, f.h) <= 8192);
    info.push(`upscale-export:${ok ? 'ok' : 'FAIL'} ${JSON.stringify(outs.map(([, f]) => `${f.factor}x ${f.w}x${f.h}`))}`);
  }

  // Backup → change things → restore through the Settings UI → all back.
  {
    const { saveBackup } = await import('./state/backup.js');
    const photo = images()[0];
    st().select(photo.id);
    st().setRating(5);
    st().updateSettings({ exposure: 0.21 });
    await st().savePreset('backup-look');
    st().setExportPrefs({ format: 'webp' });
    st().setConfirmEditDelete(false);
    window.__DIALOG = { save: '/backups/b.json', open: '/backups/b.json' };
    const path = await saveBackup();
    const written = !!window.__FS[path]?.data;
    // Change everything the backup covers.
    await st().deletePreset('backup-look');
    st().setRating(0);
    st().setExportPrefs({ format: 'tiff' });
    st().setConfirmEditDelete(true);
    // Restore via the UI.
    st().setSettingsOpen(true);
    await sleep(200);
    document.querySelector('[data-action="restore"]').click();
    await sleep(300);
    const asked = !document.querySelector('.backup-confirm').hidden && /1 rated|rated or flagged/.test(document.querySelector('.backup-summary').textContent);
    document.querySelector('[data-action="confirm-restore"]').click();
    for (let i = 0; i < 30 && !st().presets.some((p) => p.name === 'backup-look'); i++) await sleep(100);
    const s2 = st();
    const restored =
      s2.presets.some((p) => p.name === 'backup-look') &&
      s2.images.find((i) => i.id === photo.id).rating === 5 &&
      s2.exportPrefs.format === 'webp' &&
      s2.confirmEditDelete === false;
    // A file that isn't a backup is refused with a message, nothing changes.
    window.__FS['/backups/bad.json'] = { data: new TextEncoder().encode('{"hello":1}') };
    window.__DIALOG.open = '/backups/bad.json';
    document.querySelector('[data-action="restore"]').click();
    await sleep(300);
    const refused = document.querySelector('.backup-confirm').hidden && /not a Sabattier backup/.test(document.querySelector('[data-action="restore"]').closest('.settings-group').querySelector('[role=status]').textContent);
    st().setSettingsOpen(false);
    info.push(`backup-restore:${written && asked && restored && refused ? 'ok' : 'FAIL'} (${written}/${asked}/${restored}/${refused})`);
    await st().deletePreset('backup-look');
    st().setRating(0);
    st().setConfirmEditDelete(true);
    window.__DIALOG = null;
  }

  // Settings lists the models.
  {
    st().setSettingsOpen(true);
    await sleep(300);
    const rows = document.querySelectorAll('.model-list .dialog-row').length;
    // License links open the bundled license; Escape closes only the viewer.
    document.querySelector('[data-license="esrgan"]')?.click();
    for (let i = 0; i < 20 && !/Xintao Wang/.test(document.querySelector('.license-text')?.textContent ?? ''); i++) await sleep(100);
    const text = document.querySelector('.license-text')?.textContent ?? '';
    const bsd = /BSD 3-Clause/.test(text) && /Copyright \(c\) 2021, Xintao Wang/.test(text);
    // Like a real key press: aimed at the focused element (the viewer's close button).
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(100);
    const viewerClosed = !document.querySelector('.license-dialog');
    const settingsStill = st().settingsOpen;
    let allLoad = true;
    for (const btn of document.querySelectorAll('.license-link')) {
      btn.click();
      await sleep(150);
      const t = document.querySelector('.license-text')?.textContent ?? '';
      if (!/License/.test(t) || /couldn't be loaded/.test(t)) allLoad = false;
      document.querySelector('.license-dialog .icon-btn')?.click();
    }
    info.push(`licenses:${bsd && viewerClosed && settingsStill && allLoad ? 'ok' : 'FAIL'} (${bsd}/${viewerClosed}/${settingsStill}/${allLoad})`);

    // Open-source licenses: crates (Tauri, rawler's LGPL), ONNX Runtime; Escape peels one layer.
    {
      const esc = () =>
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.querySelector('[data-action="open-source"]').click();
      for (let i = 0; i < 30 && document.querySelectorAll('.oss-group').length < 50; i++) await sleep(100);
      const groups = document.querySelectorAll('.oss-group').length;
      const filterBox = document.querySelector('.oss-dialog input[type=search]');
      filterBox.value = 'tauri';
      filterBox.dispatchEvent(new Event('input'));
      const tauri = [...document.querySelectorAll('.oss-crates')].some((e) => /\btauri 2\.12\.0\b/.test(e.textContent));
      filterBox.value = 'rawler';
      filterBox.dispatchEvent(new Event('input'));
      const lgplBtn = [...document.querySelectorAll('[data-license-group]')].find((b) => /LGPL/.test(b.dataset.licenseGroup));
      lgplBtn?.click();
      await sleep(200);
      const lgpl = /GNU LESSER GENERAL PUBLIC LICENSE/.test(document.querySelector('.license-dialog .license-text')?.textContent ?? '');
      esc();
      await sleep(100);
      const peeled = !document.querySelector('.license-dialog') && !!document.querySelector('.oss-dialog');
      [...document.querySelectorAll('.oss-dialog .license-link')].find((b) => b.textContent === 'Third-party notices')?.click();
      for (let i = 0; i < 20 && !/THIRD PARTY SOFTWARE NOTICES/.test(document.querySelector('.license-dialog .license-text')?.textContent ?? ''); i++) await sleep(100);
      const ort = /THIRD PARTY SOFTWARE NOTICES/.test(document.querySelector('.license-dialog .license-text')?.textContent ?? '');
      esc();
      await sleep(100);
      esc();
      await sleep(100);
      const allClosed = !document.querySelector('.oss-dialog') && st().settingsOpen;
      info.push(`open-source:${groups >= 50 && tauri && lgpl && peeled && ort && allClosed ? 'ok' : 'FAIL'} (${groups}/${tauri}/${lgpl}/${peeled}/${ort}/${allClosed})`);
    }
    st().setSettingsOpen(false);
    info.push(`models-list:${rows >= 2 ? 'ok' : 'FAIL'} (${rows})`);
  }

  // HDR merge from the filmstrip: pick two, press the button, both go to the
  // backend as edited frames and a new photo arrives selected.
  {
    const before = images().length;
    st().select(images()[0].id);
    st().select(images()[1].id, 'toggle');
    await sleep(100);
    const btn = document.querySelector('[data-action="merge-hdr"]');
    const shown = btn && !btn.hidden;
    btn?.click();
    for (let i = 0; i < 50 && images().length === before; i++) await sleep(100);
    const added = images().length === before + 1 && selected().name === 'merged-HDR.jpg';
    const sent = window.__MERGED?.length === 2;
    st().select(images()[0].id);
    await sleep(100);
    const hiddenAgain = btn.hidden;
    info.push(`hdr-merge:${shown && added && sent && hiddenAgain ? 'ok' : 'FAIL'} (${shown}/${added}/${sent}/${hiddenAgain})`);
  }

  // Settings → Use all CPU cores: the switch reaches the backend and is remembered.
  {
    st().setSettingsOpen(true);
    await sleep(100);
    const box = document.querySelector('#setting-multicore');
    const wasOn = box?.checked === true && st().multicore === true;
    box?.click();
    await sleep(50);
    const off = st().multicore === false && localStorage.getItem('sabattier.multicore') === 'false';
    box?.click();
    await sleep(50);
    const on = st().multicore === true && localStorage.getItem('sabattier.multicore') === 'true';
    st().setSettingsOpen(false);
    info.push(`multicore:${wasOn && off && on ? 'ok' : 'FAIL'} (${wasOn}/${off}/${on})`);
  }

  // Portrait: real face analysis of MediaPipe's test portrait → face texture
  // channels land on the right features; Smooth skin changes only the face.
  {
    const { getFaces } = await import('./state/store.js');
    const faceData = await (await fetch('/img/portrait-faces.json')).json();
    const lm = faceData.faces[0].landmarks;
    // A photo with no faces says so and adds nothing.
    st().select(images()[0].id);
    const before = selected().settings.masks.length;
    await st().portraitAction('smooth');
    const noFace = selected().settings.masks.length === before && /No faces/.test(st().toast?.text ?? '');

    await st().importPaths(['/img/portrait.jpg']);
    for (let i = 0; i < 50 && images().at(-1).status === 'pending'; i++) await sleep(100);
    const portrait = images().find((i) => i.name === 'portrait.jpg');
    st().select(portrait.id);
    await sleep(400);
    const grab = () => {
      const c = document.querySelector('.preview canvas');
      const ctx = new OffscreenCanvas(c.width, c.height).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(c, 0, 0);
      return { w: c.width, h: c.height, d: ctx.getImageData(0, 0, c.width, c.height).data };
    };
    const plain = grab();
    await st().portraitAction('smooth');
    await sleep(500);
    const faces = getFaces(portrait.id);
    const at = (p, ch) => {
      const x = Math.floor((p[0] / faceData.width) * faces.width);
      const y = Math.floor((p[1] / faceData.height) * faces.height);
      return faces.data[(y * faces.width + x) * 4 + ch];
    };
    const cheek = [(lm[33][0] + lm[61][0]) / 2, (lm[33][1] + lm[61][1]) / 2 + 10];
    const channels = {
      skinCheek: at(cheek, 0), skinPupil: at(lm[468], 0), skinLip: at(lm[17], 0),
      eyePupil: at(lm[468], 1), eyeCheek: at(cheek, 1), lipLower: at(lm[17], 2), lipCheek: at(cheek, 2),
    };
    const regionsOk =
      channels.skinCheek > 180 && channels.skinPupil < 60 && channels.skinLip < 60 &&
      channels.eyePupil > 150 && channels.eyeCheek < 30 && channels.lipLower > 120 && channels.lipCheek < 30;
    const smoothed = grab();
    // Changed pixels should all sit on the skin mask (nothing where it is empty).
    let changed = 0;
    let outside = 0;
    for (let y = 0; y < smoothed.h; y++) for (let x = 0; x < smoothed.w; x++) {
      const i = (y * smoothed.w + x) * 4;
      if (Math.abs(smoothed.d[i] - plain.d[i]) + Math.abs(smoothed.d[i + 1] - plain.d[i + 1]) <= 6) continue;
      changed++;
      if (at([((x + 0.5) / smoothed.w) * faceData.width, ((y + 0.5) / smoothed.h) * faceData.height], 0) < 8) outside++;
    }
    const mask = selected().settings.masks.at(-1);
    const actionOk = mask?.type === 'skin' && mask.adj.texture < 0 && changed > 200 && outside / changed < 0.02;
    info.push(
      `portrait:${noFace && faces?.faces === 1 && regionsOk && actionOk ? 'ok' : 'FAIL'} ` +
        `(${noFace}/${faces?.faces}/${JSON.stringify(channels)}/${changed} changed, ${outside} outside)`,
    );
  }

  // Picking faces: the portrait twice side by side; a face mask on all faces,
  // then on face 2 only (the right one — faces are numbered left to right).
  {
    const { getFaces } = await import('./state/store.js');
    const src = await createImageBitmap(await (await fetch('/img/portrait.jpg')).blob());
    const two = new OffscreenCanvas(1640, 1024);
    const c2 = two.getContext('2d');
    c2.drawImage(src, 0, 0);
    c2.drawImage(src, 820, 0);
    const bytes = new Uint8Array(await (await two.convertToBlob({ type: 'image/jpeg', quality: 0.92 })).arrayBuffer());
    window.__FS['/img/two-faces.jpg'] = { data: bytes };
    await st().importPaths(['/img/two-faces.jpg']);
    for (let i = 0; i < 50 && images().at(-1).status === 'pending'; i++) await sleep(100);
    const photo = images().find((i) => i.name === 'two-faces.jpg');
    st().select(photo.id);
    document.querySelector('[data-mode="fine"]')?.click();
    await sleep(400);
    const grab = () => {
      const c = document.querySelector('.preview canvas');
      const ctx = new OffscreenCanvas(c.width, c.height).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(c, 0, 0);
      return { w: c.width, h: c.height, d: ctx.getImageData(0, 0, c.width, c.height).data };
    };
    // Mean brightness on a cheek of the left (fx 0.23) and right (fx 0.73) face.
    const cheek = (g, fx) => {
      let sum = 0;
      for (let y = Math.floor(g.h * 0.22); y < g.h * 0.26; y++) for (let x = Math.floor(g.w * (fx - 0.01)); x < g.w * (fx + 0.01); x++) sum += g.d[(y * g.w + x) * 4 + 1];
      return sum;
    };
    st().setMaskOutline(false);
    await sleep(200);
    const plain = grab();
    const mask = await st().addMask('skin', { exposure: 0.35 });
    await sleep(500);
    const faces = getFaces(photo.id);
    const both = grab();
    st().setMaskOutline(true);
    await sleep(200);
    const chips = document.querySelectorAll('.face-chip').length;
    const badges = document.querySelectorAll('.face-badge').length;
    // Pick face 2 by clicking its badge on the photo.
    document.querySelectorAll('.face-badge')[1]?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await sleep(200);
    const picked = JSON.stringify(selected().settings.masks.find((m) => m.id === mask.id).faces);
    st().setMaskOutline(false);
    await sleep(300);
    const right = grab();
    const d = (a, b, fx) => (cheek(a, fx) - cheek(b, fx)) / Math.max(1, cheek(b, fx));
    const allOk = d(both, plain, 0.23) > 0.05 && d(both, plain, 0.73) > 0.05;
    const pickOk = Math.abs(d(right, plain, 0.23)) < 0.005 && d(right, plain, 0.73) > 0.05;
    const label = document.querySelector('.mask-row.active')?.textContent ?? '';
    // Copy to all: the pick stays here, becomes "every face" on other photos.
    st().applyToAll();
    const here = JSON.stringify(images().find((i) => i.id === photo.id).settings.masks.find((m) => m.id === mask.id).faces);
    const there = images().find((i) => i.id !== photo.id).settings.masks.find((m) => m.id === mask.id)?.faces;
    st().undo();
    info.push(
      `face-picks:${faces?.faces === 2 && chips === 3 && badges === 2 && picked === '[1]' && allOk && pickOk && /face 2/.test(label) && here === '[1]' && there === null ? 'ok' : 'FAIL'} ` +
        `(${faces?.faces}/${chips}/${badges}/${picked}/${allOk}/${pickOk}/${label}/${here}/${there})`,
    );
    st().setMaskOutline(true);
  }
}

/**
 * Checks for the tone curve, mixer, effects, masks, culling and the export
 * formats/watermark. Effects are verified on the pixels of a synthetic image
 * with known content; speed is measured on a synthetic 24 MP frame.
 */
async function newFeatureChecks(info, smoke, selected, sleep) {
  const { store, visibleImages, getMatte } = await import('./state/store.js');
  const { renderFrame } = await import('./engine/export.js');
  const { GLEngine } = await import('./engine/gl.js');
  const { defaultSettings, newMask } = await import('./engine/types.js');

  // Synthetic scene: top half a gray ramp, bottom half four color bars, and a
  // fine checker patch for detail measurements.
  const W = 640;
  const H = 400;
  const scene = new OffscreenCanvas(W, H);
  {
    const c = scene.getContext('2d');
    const ramp = c.createLinearGradient(0, 0, W, 0);
    ramp.addColorStop(0, '#101010');
    ramp.addColorStop(1, '#e8e8e8');
    c.fillStyle = ramp;
    c.fillRect(0, 0, W, H / 2);
    ['#c83c32', '#3caa46', '#3c5ac8', '#d2be3c'].forEach((col, i) => {
      c.fillStyle = col;
      c.fillRect((i * W) / 4, H / 2, W / 4, H / 2);
    });
    for (let y = 20; y < 80; y += 2) for (let x = 20; x < 140; x += 2) {
      c.fillStyle = (x + y) % 4 === 0 ? '#9a9a9a' : '#6a6a6a';
      c.fillRect(x, y, 2, 2);
    }
  }
  const bmp = scene.transferToImageBitmap();
  const S = (patch) => ({ ...defaultSettings(), ...patch });
  const pixelsOf = async (settings, extra = {}) => {
    const canvas = await renderFrame(bmp, settings, extra);
    const off = new OffscreenCanvas(canvas.width, canvas.height);
    const ctx = off.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const region = (px, x0, y0, x1, y1, fn) => {
    let acc = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      acc += fn(px[i], px[i + 1], px[i + 2], px, i);
      n++;
    }
    return acc / n;
  };
  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);
  // Mean absolute difference to the right-hand neighbor: fine-detail energy.
  const hf = (r, g, b, px, i) => Math.abs(luma(r, g, b) - luma(px[i + 4], px[i + 5], px[i + 6]));
  const lumaStd = (px, x0, y0, x1, y1) => {
    const m = region(px, x0, y0, x1, y1, luma);
    return Math.sqrt(region(px, x0, y0, x1, y1, (r, g, b) => (luma(r, g, b) - m) ** 2));
  };
  const base = await pixelsOf(S({}));
  const results = [];
  const check = (name, ok, detail) => results.push(`${name}:${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`);
  const f2 = (v) => v.toFixed(1);

  {
    const px = await pixelsOf(S({ whites: 0.5 }));
    const a = region(base, 0, 100, W, 180, luma);
    const b = region(px, 0, 100, W, 180, luma);
    check('whites', b > a + 5, `${f2(a)}->${f2(b)}`);
  }
  {
    const curve = { ...defaultSettings().curve, rgb: [[0, 0], [0.25, 0.12], [0.75, 0.88], [1, 1]] };
    const px = await pixelsOf(S({ curve }));
    const a = lumaStd(base, 0, 100, W, 180);
    const b = lumaStd(px, 0, 100, W, 180);
    check('tone-curve', b > a * 1.1, `std ${f2(a)}->${f2(b)}`);
  }
  {
    const m = defaultSettings().mixer;
    const mixer = { ...m, sat: m.sat.map((v, i) => (i === 0 ? -1 : 0)) };
    const px = await pixelsOf(S({ mixer }));
    const red = [region(base, 10, 210, 150, 390, sat), region(px, 10, 210, 150, 390, sat)];
    const blue = [region(base, 330, 210, 470, 390, sat), region(px, 330, 210, 470, 390, sat)];
    check('mixer-red-sat', red[1] < red[0] * 0.3 && Math.abs(blue[1] - blue[0]) < 3, `red ${f2(red[0])}->${f2(red[1])}, blue ${f2(blue[0])}->${f2(blue[1])}`);
  }
  for (const [name, patch, measure, want] of [
    ['sharpen', { sharpen: 1 }, 'hf', 'up'],
    ['texture+', { texture: 1, fxEnabled: true }, 'hf', 'up'],
    ['texture-', { texture: -1, fxEnabled: true }, 'hf', 'down'],
    ['clarity+', { clarity: 1, fxEnabled: true }, 'std', 'up'],
    ['clarity-', { clarity: -1, fxEnabled: true }, 'std', 'down'],
    ['grain', { grain: 1, fxEnabled: true }, 'flat', 'up'],
  ]) {
    const px = await pixelsOf(S(patch));
    const m = (p) =>
      measure === 'hf' ? region(p, 22, 22, 138, 78, hf) : measure === 'std' ? lumaStd(p, 10, 10, 150, 90) : region(p, 400, 120, 600, 190, hf);
    const a = m(base);
    const b = m(px);
    check(name, want === 'up' ? b > a * 1.05 + 0.2 : b < a * 0.95, `${f2(a)}->${f2(b)}`);
  }
  {
    const px = await pixelsOf(S({ dehaze: 1, fxEnabled: true }));
    const a = lumaStd(base, 0, 0, W, H);
    const b = lumaStd(px, 0, 0, W, H);
    const finite = region(px, 0, 0, W, H, luma);
    check('dehaze', b > a && Number.isFinite(finite), `std ${f2(a)}->${f2(b)}`);
  }
  {
    // Linear gradient mask, full effect at the top: exposure up only there.
    const mask = { ...newMask('linear', 't1'), geo: { x0: 0.5, y0: 0, x1: 0.5, y1: 0.3 } };
    mask.adj.exposure = 0.3;
    const px = await pixelsOf(S({ masks: [mask] }));
    const top = region(px, 0, 0, W, 30, luma) - region(base, 0, 0, W, 30, luma);
    const bottom = region(px, 0, 300, W, 400, luma) - region(base, 0, 300, W, 400, luma);
    check('mask-linear', top > 10 && Math.abs(bottom) < 1, `top +${f2(top)}, bottom ${f2(bottom)}`);
    const radial = { ...newMask('radial', 't2'), geo: { cx: 0.5, cy: 0.25, rx: 0.1, ry: 0.1, feather: 0.2 } };
    radial.adj.exposure = -0.3;
    const px2 = await pixelsOf(S({ masks: [radial] }));
    const inside = region(px2, 310, 95, 330, 105, luma) - region(base, 310, 95, 330, 105, luma);
    const outside = region(px2, 0, 0, 40, 40, luma) - region(base, 0, 0, 40, 40, luma);
    check('mask-radial', inside < -10 && Math.abs(outside) < 1, `inside ${f2(inside)}, outside ${f2(outside)}`);
  }
  {
    // Lens blur: left half far, right half near; focus near → only the left blurs.
    const dw = 70;
    const dh = 42;
    const data = new Uint8Array(dw * dh);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) data[y * dw + x] = x < dw / 2 ? 0 : 255;
    const depth = { data, width: dw, height: dh, autoFocus: 1 };
    const px = await pixelsOf(S({ lensBlur: 1, lensFocus: 1, lensRange: 0.1 }), { depth });
    const detailFar = [region(base, 22, 22, 138, 78, hf), region(px, 22, 22, 138, 78, hf)];
    let nearSame = true;
    for (let y = 100; y < 180 && nearSame; y++) for (let x = 420; x < 600; x++) {
      const i = (y * W + x) * 4;
      if (Math.abs(px[i] - base[i]) > 1) { nearSame = false; break; }
    }
    check('lens-blur', detailFar[1] < detailFar[0] * 0.3 && nearSame, `far detail ${f2(detailFar[0])}->${f2(detailFar[1])}, near unchanged ${nearSame}`);
  }
  {
    const wm = { enabled: true, kind: 'text', text: 'SMOKE ©', position: 'br', size: 0.6, opacity: 1, color: 'white' };
    const px = await pixelsOf(S({}), { watermark: wm });
    // Changed pixels, and how many of them sit in the bottom-right quarter.
    let changed = 0;
    let corner = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i] - base[i]) + Math.abs(px[i + 2] - base[i + 2]) <= 30) continue;
      changed++;
      const p = i / 4;
      if (p % W >= W / 2 && p / W >= H / 2) corner++;
    }
    check('watermark', changed > 200 && corner / changed > 0.95, `${changed} px changed, ${Math.round((100 * corner) / Math.max(1, changed))}% bottom-right`);
  }
  bmp.close();
  info.push(`effects: ${results.join(' ')}`);

  // ---- Speed: synthetic 6000×4000 frame, preview-size and full-size renders ----
  {
    const big = new OffscreenCanvas(6000, 4000);
    const c = big.getContext('2d');
    const g = c.createLinearGradient(0, 0, 6000, 4000);
    g.addColorStop(0, '#203050');
    g.addColorStop(0.5, '#c0a080');
    g.addColorStop(1, '#f0f0e0');
    c.fillStyle = g;
    c.fillRect(0, 0, 6000, 4000);
    for (let i = 0; i < 400; i++) {
      c.fillStyle = `hsl(${i * 37} 60% 50%)`;
      c.fillRect((i * 1733) % 6000, (i * 977) % 4000, 180, 120);
    }
    const bigBmp = big.transferToImageBitmap();
    const engine = new GLEngine(new OffscreenCanvas(1600, 1067));
    engine.setImage(bigBmp);
    const gl = engine.gl;
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    const time = (settings, n = 20) => {
      engine.render(settings);
      sync(); // warm up (and build the blur buffer once)
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        engine.render({ ...settings, exposure: (i % 2) * 0.01 });
        sync();
      }
      return (performance.now() - t0) / n;
    };
    const neutral = time(S({}));
    const lin = { ...newMask('linear', 'p1'), adj: { ...newMask('linear', 'p1').adj, exposure: 0.2 } };
    const all = S({
      whites: 0.2,
      curve: { ...defaultSettings().curve, rgb: [[0, 0], [0.3, 0.25], [0.7, 0.78], [1, 1]] },
      mixer: { ...defaultSettings().mixer, hue: [0.2, 0, 0, -0.3, 0, 0.2, 0, 0] },
      fxEnabled: true,
      texture: 0.4,
      clarity: 0.4,
      dehaze: 0.3,
      vignette: 0.3,
      grain: 0.3,
      sharpen: 0.5,
      cbEnabled: true,
      masks: [lin, { ...newMask('radial', 'p2'), adj: { ...lin.adj, saturation: 0.3 } }],
    });
    engine.setImage(bigBmp); // fresh image: first render pays for the blur buffer
    const t0 = performance.now();
    engine.render(all);
    sync();
    const firstBlur = performance.now() - t0;
    const fakeDepth = { data: new Uint8Array(518 * 346).map((_, i) => (i % 518) / 2), width: 518, height: 346, autoFocus: 0.9 };
    engine.setDepth(fakeDepth);
    const everything = time(all);
    const lens = { ...all, lensBlur: 0.6 };
    const withLens = time(lens);
    engine.canvas.width = 6000;
    engine.canvas.height = 4000;
    const fullNeutral = time(S({}), 3);
    const fullAll = time(all, 3);
    const fullLens = time(lens, 3);
    engine.dispose();
    bigBmp.close();
    info.push(
      `perf-24MP: preview 1600px neutral ${f2(neutral)}ms, all-tools ${f2(everything)}ms (first render incl. blur build ${f2(firstBlur)}ms); ` +
        `full-res neutral ${f2(fullNeutral)}ms, all-tools ${f2(fullAll)}ms; ` +
        `+lens blur: preview ${f2(withLens)}ms, full-res ${f2(fullLens)}ms`,
    );
  }

  // ---- Culling: keys on the selected photo, filter, stepping ----
  {
    const st = store.getState;
    st().setFilter('all');
    st().select(st().images[0].id);
    const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('3');
    key('p');
    await sleep(50);
    const first = st().images[0];
    const rated = first.rating === 3 && first.flag === 'pick';
    const stars = document.querySelector('.filmstrip .thumb .stars')?.textContent === '★★★';
    st().setFilter('picks');
    const picks = st().images.filter((i) => i.flag === 'pick').length;
    const onlyPicks = picks >= 1 && visibleImages(st()).length === picks && document.querySelectorAll('.filmstrip .thumb').length === picks;
    st().setFilter('all');
    key('ArrowRight');
    const stepped = st().selectedId === st().images[1]?.id;
    key('x'); // reject photo 2 …
    st().setFilter('no-rejects'); // … and hide it: the selection moves on
    const moved = st().selectedId !== st().images[1]?.id;
    st().setFilter('all');
    info.push(`culling:${rated && stars && onlyPicks && stepped && moved ? 'ok' : 'FAIL'} (${rated}/${stars}/${onlyPicks}/${stepped}/${moved})`);
    st().select(st().images[0].id);
  }

  // ---- Subject mask on a real photo (the model ran for background removal) ----
  {
    const st = store.getState;
    const item = selected();
    await st().addMask('subject');
    const m = selected().settings.masks?.[0];
    st().updateMask(m?.id, { adj: { exposure: 0.2 } });
    const ok = !!m && !!getMatte(item.id) && selected().settings.masks[0].adj.exposure === 0.2 && st().activeMaskId === m.id;
    st().undo();
    st().undo();
    info.push(`mask-subject:${ok && !selected().settings.masks.length ? 'ok' : 'FAIL'}`);
  }

  // ---- Export formats + watermark, into their own folder ----
  if (smoke.exportPath) {
    const { backend } = await import('./backend.js');
    const st = store.getState;
    const saved = structuredClone(st().exportPrefs);
    const dir = `${smoke.exportPath}/formats`;
    const counts = {};
    for (const format of ['tiff', 'webp', 'png']) {
      st().setExportPrefs({ format, watermark: { enabled: true, kind: 'text', text: 'Sabattier smoke', position: 'br' } });
      await st().exportAll({ dir, quality: 0.9, maxDim: 800, suffix: `-${format}`, onlyShown: false });
      const files = await backend.listImages(dir);
      counts[format] = files.filter((f) => f.includes(`-${format}.`)).length;
    }
    st().setExportPrefs(saved);
    const n = st().images.filter((i) => i.status !== 'error').length;
    const ok = Object.values(counts).every((c) => c === n);
    info.push(`export-formats:${ok ? 'ok' : 'FAIL'} ${JSON.stringify(counts)} of ${n}`);
  }
}

setTimeout(async () => {
  const smoke = await backend.smokeConfig().catch(() => null);
  if (!smoke) return;
  const info = [`webgl2:${!!document.createElement('canvas').getContext('webgl2')}`];
  if (smoke.importPath) {
    try {
      await smokeFlow(info, smoke);
    } catch (err) {
      smokeErrors.push(`smoke flow: ${String(err)}`);
    }
  }
  backend.smokeReady({ errors: smokeErrors, info }).catch(() => {});
}, 1500);
