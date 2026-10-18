/* =========================================================================
 * DUST STRIKE — WebGL renderer core (CS.gl)
 *
 * Pure classic script (no modules / no external assets). Implements the
 * renderer API from CONTRACT.md §5:
 *   CS.gl.init / CS.gl.createMesh
 *   renderer: gl, resize, setCamera, camera, beginFrame, drawMesh, drawBox,
 *             drawBeam, drawSprite, drawShadow, drawGroundDecal, endFrame
 *
 * Visual target: dust2 style desert — warm sun from upper-left-front, sky
 * gradient (grey-blue top -> sandy horizon), distance haze, procedural
 * 256x256 tileable textures made with canvas 2D (noise / brick joints /
 * wood grain), simple opaque+transparent sorted passes.
 *
 * CONTRACT-GAP decisions (things the contract leaves open):
 *  - setCamera(eye, yaw, pitch, fovDeg): fovDeg is treated as HORIZONTAL fov
 *    (CSGO convention, game.settings.fov = 90) and converted to the vertical
 *    fov consumed by M4.perspective. camera.fov = vertical fov in radians,
 *    camera.fovDeg = the requested horizontal value.
 *  - Extra (optional) helpers on the renderer, safe for callers to ignore:
 *      renderer.drawDecal(texName, pos, normal, size, color, alpha, rotation)
 *        surface-aligned quad — bullet holes must NOT be camera billboards.
 *      renderer.drawSprite(..., additive, rotation) optional 6th argument.
 *    fx.js feature-detects drawDecal and falls back to drawBox/drawSprite.
 *  - Colors accept [r,g,b] / [r,g,b,a], values 0..1 or 0..255, or "#rrggbb".
 *  - drawGroundDecal draws an annulus + a faint translucent disc (site mark).
 *  - Unknown texture name -> magenta/black checkerboard (typo catcher).
 *  - Transparent commands are sorted far->near but grouped by texture at flush
 *    time; strict cross-texture ordering is traded for fewer draw calls
 *    (visually irrelevant for sparse additive/alpha FX).
 *  - No-GL fallback: init() returns an inert renderer whose methods are no-ops
 *    so a missing WebGL context never throws or blacks out the page.
 * ========================================================================= */
(function () {
  'use strict';

  var CS = window.CS = window.CS || {};
  var M = CS.math || {};
  var PI = Math.PI, TAU = PI * 2;

  /* ======================================================================
   * 0. small helpers
   * ==================================================================== */
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function smoothstep01(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h === undefined ? w : h;
    return c;
  }
  function ctxOf(cv) { return cv.getContext('2d'); }

  /* Accept [r,g,b(,a)] in 0..1 or 0..255, "#rgb"/"#rrggbb", or a number. */
  function toColor(c, dr, dg, db, da) {
    if (c === undefined || c === null) return [dr, dg, db, da === undefined ? 1 : da];
    if (typeof c === 'number') {
      if (c > 1) c = c / 255;
      return [clamp01(c), clamp01(c), clamp01(c), da === undefined ? 1 : da];
    }
    if (typeof c === 'string') {
      var s = c.trim();
      if (s.charAt(0) === '#') s = s.slice(1);
      if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
      if (s.length >= 6) {
        var r = parseInt(s.slice(0, 2), 16), g = parseInt(s.slice(2, 4), 16), b = parseInt(s.slice(4, 6), 16);
        var a = s.length >= 8 ? parseInt(s.slice(6, 8), 16) / 255 : (da === undefined ? 1 : da);
        if (isFinite(r) && isFinite(g) && isFinite(b)) return [r / 255, g / 255, b / 255, a];
      }
      return [dr, dg, db, da === undefined ? 1 : da];
    }
    var rr = c[0], gg = c[1], bb = c[2];
    if (rr > 1.001 || gg > 1.001 || bb > 1.001) { rr /= 255; gg /= 255; bb /= 255; }
    var aa = (c.length > 3 && c[3] !== undefined) ? c[3] : (da === undefined ? 1 : da);
    if (aa > 1.001) aa /= 255;
    return [clamp01(rr), clamp01(gg), clamp01(bb), clamp01(aa)];
  }
  function norm3(x, y, z) {
    var l = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / l, y / l, z / l];
  }

  /* ======================================================================
   * 1. tileable procedural noise
   * ==================================================================== */
  /* Value noise on a wrapping `cells x cells` grid, bilinear + smoothstep. */
  function tileNoise(size, cells, rand) {
    if (cells < 1) cells = 1;
    var g = new Float32Array(cells * cells);
    var i;
    for (i = 0; i < g.length; i++) g[i] = rand();
    var out = new Float32Array(size * size);
    var sc = cells / size;
    for (var y = 0; y < size; y++) {
      var fy = y * sc, y0 = fy | 0, ty = fy - y0, y1 = (y0 + 1) % cells;
      var sy = ty * ty * (3 - 2 * ty);
      var r0 = y0 * cells, r1 = y1 * cells;
      for (var x = 0; x < size; x++) {
        var fx = x * sc, x0 = fx | 0, tx = fx - x0, x1 = (x0 + 1) % cells;
        var sx = tx * tx * (3 - 2 * tx);
        var a = g[r0 + x0], b = g[r0 + x1], c = g[r1 + x0], d = g[r1 + x1];
        var top = a + (b - a) * sx, bot = c + (d - c) * sx;
        out[y * size + x] = top + (bot - top) * sy;
      }
    }
    return out;
  }

  /* Fractal sum of tileable value noise, normalised to 0..1. */
  function fbm(size, rand, octaves, cells, gain) {
    var out = new Float32Array(size * size);
    var amp = 1, tot = 0, c = cells, o, i;
    for (o = 0; o < octaves; o++) {
      var n = tileNoise(size, c, rand);
      for (i = 0; i < out.length; i++) out[i] += n[i] * amp;
      tot += amp; amp *= gain; c *= 2;
    }
    var inv = 1 / tot;
    for (i = 0; i < out.length; i++) out[i] *= inv;
    return out;
  }

  /* Shared overlay canvases (fine grain + large grunge), reused by textures. */
  var grainCv = null, grungeCv = null;
  function buildSharedOverlays() {
    var S = 256, i, d;
    var rng = mulberry32(9001);
    grainCv = makeCanvas(S);
    var gc = ctxOf(grainCv);
    var gi = gc.createImageData(S, S); d = gi.data;
    for (i = 0; i < S * S; i++) {
      var v = 96 + ((rng() * 78) | 0);
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    gc.putImageData(gi, 0, 0);

    grungeCv = makeCanvas(S);
    var rc = ctxOf(grungeCv);
    var n = fbm(S, mulberry32(9002), 4, 3, 0.55);
    var ri = rc.createImageData(S, S); d = ri.data;
    for (i = 0; i < S * S; i++) {
      var v2 = 96 + n[i] * 128;
      d[i * 4] = v2; d[i * 4 + 1] = v2 * 0.96; d[i * 4 + 2] = v2 * 0.9; d[i * 4 + 3] = 255;
    }
    rc.putImageData(ri, 0, 0);
  }
  function overlayGrain(ctx, size, alpha, mode) {
    if (!grainCv) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = mode || 'overlay';
    ctx.drawImage(grainCv, 0, 0, size, size);
    ctx.restore();
  }
  function overlayGrunge(ctx, size, alpha, mode) {
    if (!grungeCv) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = mode || 'soft-light';
    ctx.drawImage(grungeCv, 0, 0, size, size);
    ctx.restore();
  }
  function blob(ctx, x, y, r, rgba) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba);
    g.addColorStop(1, rgba.replace(/[\d.]+\)$/, '0)'));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  /* ======================================================================
   * 2. procedural textures (dust2 palette)
   * ==================================================================== */
  var TEX_PUBLIC = ['white', 'sandfloor', 'wall', 'wall2', 'brick', 'crate',
    'metal', 'concrete', 'wood', 'shadow', 'spark', 'smoke', 'muzzle', 'blood'];

  /* ---- solid white (tinted geometry) ---- */
  function texWhite() {
    var cv = makeCanvas(16), ctx = ctxOf(cv);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 16, 16);
    return cv;
  }

  /* ---- sand floor: warm sand, wind ripples, pebbles ---- */
  function texSandfloor() {
    var S = 256, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(101);
    var large = fbm(S, rand, 4, 3, 0.55);
    var med = fbm(S, rand, 3, 9, 0.5);
    var fine = tileNoise(S, 96, rand);
    var img = ctx.createImageData(S, S), d = img.data;
    var dR = 132, dG = 106, dB = 72;   /* shadowed sand */
    var lR = 234, lG = 212, lB = 168;  /* sunlit sand */
    for (var y = 0; y < S; y++) {
      var v = y / S;
      for (var x = 0; x < S; x++) {
        var i = y * S + x, u = x / S;
        var n = large[i] * 0.62 + med[i] * 0.38;
        var ripple = Math.sin(TAU * (2 * v) + TAU * u + n * 6.0);
        var t = clamp01(n * 1.02 + ripple * 0.085 - 0.03);
        var r = dR + (lR - dR) * t;
        var g = dG + (lG - dG) * t;
        var b = dB + (lB - dB) * t;
        var gr = (fine[i] - 0.5) * 24;
        d[i * 4] = r + gr; d[i * 4 + 1] = g + gr * 0.92; d[i * 4 + 2] = b + gr * 0.82; d[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    var k, px, py, rr, a;
    for (k = 0; k < 560; k++) {
      px = rand() * S; py = rand() * S; rr = 0.45 + rand() * 1.6; a = 0.05 + rand() * 0.16;
      ctx.fillStyle = 'rgba(78,61,41,' + a.toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(px, py, rr, 0, TAU); ctx.fill();
    }
    for (k = 0; k < 420; k++) {
      px = rand() * S; py = rand() * S; rr = 0.4 + rand() * 1.2; a = 0.05 + rand() * 0.15;
      ctx.fillStyle = 'rgba(240,228,199,' + a.toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(px, py, rr, 0, TAU); ctx.fill();
    }
    /* sparse darker streaks / scuffs */
    for (k = 0; k < 7; k++) {
      px = rand() * S; py = rand() * S;
      ctx.strokeStyle = 'rgba(92,72,48,0.08)';
      ctx.lineWidth = 2 + rand() * 4;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + 20 + rand() * 30, py + (rand() - 0.5) * 20, px + 44 + rand() * 40, py + (rand() - 0.5) * 24);
      ctx.stroke();
    }
    overlayGrain(ctx, S, 0.16, 'overlay');
    return cv;
  }

  /* ---- sand plaster wall ---- */
  function texWall() {
    var S = 256, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(202);
    var large = fbm(S, rand, 4, 4, 0.55);
    var med = fbm(S, rand, 3, 12, 0.5);
    var fine = tileNoise(S, 80, rand);
    var img = ctx.createImageData(S, S), d = img.data;
    var dR = 158, dG = 132, dB = 96;
    var lR = 240, lG = 224, lB = 190;
    for (var y = 0; y < S; y++) {
      var v = y / S;
      for (var x = 0; x < S; x++) {
        var i = y * S + x;
        var n = large[i] * 0.62 + med[i] * 0.38;
        /* soft horizontal weathering bands (tileable) */
        var band = Math.sin(TAU * (2 * v) + large[i] * 3.0) * 0.5 + 0.5;
        var t = clamp01(n * 0.86 + band * 0.12 + 0.04);
        var r = dR + (lR - dR) * t;
        var g = dG + (lG - dG) * t;
        var b = dB + (lB - dB) * t;
        /* patchy fresh plaster: brighter irregular areas from the low-freq map */
        if (large[i] > 0.64) {
          var pm = (large[i] - 0.64) * 22;
          r += pm * 1.6; g += pm * 1.5; b += pm * 1.2;
        }
        var gr = (fine[i] - 0.5) * 20;
        d[i * 4] = r + gr; d[i * 4 + 1] = g + gr; d[i * 4 + 2] = b + gr * 0.9; d[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    /* faint horizontal trowel smears */
    var k;
    for (k = 0; k < 14; k++) {
      var sy = rand() * S;
      var grd = ctx.createLinearGradient(0, sy, S, sy + (rand() - 0.5) * 8);
      grd.addColorStop(0, 'rgba(255,245,220,0)');
      grd.addColorStop(0.5, 'rgba(255,245,220,0.10)');
      grd.addColorStop(1, 'rgba(255,245,220,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, sy - 2 - rand() * 3, S, 3 + rand() * 5);
    }
    /* lighter repair patches of fresh plaster */
    for (k = 0; k < 7; k++) {
      blob(ctx, rand() * S, rand() * S, 18 + rand() * 44, 'rgba(246,234,206,0.13)');
    }
    for (k = 0; k < 4; k++) {
      blob(ctx, rand() * S, rand() * S, 24 + rand() * 50, 'rgba(120,94,60,0.09)');
    }
    /* hairline cracks */
    ctx.strokeStyle = 'rgba(92,72,46,0.32)';
    ctx.lineWidth = 1;
    for (k = 0; k < 4; k++) {
      var cx = rand() * S, cy = rand() * S, ang = rand() * TAU;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      var segs = 6 + (rand() * 8) | 0;
      for (var s = 0; s < segs; s++) {
        ang += (rand() - 0.5) * 0.9;
        cx += Math.cos(ang) * (5 + rand() * 12);
        cy += Math.sin(ang) * (5 + rand() * 12);
        ctx.lineTo(cx, cy);
      }
      ctx.stroke();
    }
    /* pockmarks / small chips */
    for (k = 0; k < 220; k++) {
      ctx.fillStyle = 'rgba(104,82,54,' + (0.04 + rand() * 0.09).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(rand() * S, rand() * S, 0.5 + rand() * 1.6, 0, TAU);
      ctx.fill();
    }
    overlayGrain(ctx, S, 0.2, 'overlay');
    overlayGrunge(ctx, S, 0.1, 'soft-light');
    return cv;
  }

  /* ---- light ashlar stone wall ---- */
  function texWall2() {
    var S = 256, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(303);
    ctx.fillStyle = '#c3b291';
    ctx.fillRect(0, 0, S, S);
    var rows = 2, cols = 3, bh = S / rows, bw = S / cols, gap = 4;
    for (var row = 0; row < rows; row++) {
      var off = (row % 2) ? bw * 0.5 : 0;
      for (var col = -1; col <= cols; col++) {
        var x = col * bw + off;
        var base = 206 + (rand() * 24 - 12);
        var r = base, g = base * 0.94, b = base * 0.80;
        ctx.fillStyle = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
        ctx.fillRect(x + gap, row * bh + gap, bw - gap * 2, bh - gap * 2);
        /* bevel: light top-left, dark bottom-right */
        ctx.fillStyle = 'rgba(255,250,235,0.28)';
        ctx.fillRect(x + gap, row * bh + gap, bw - gap * 2, 2);
        ctx.fillRect(x + gap, row * bh + gap, 2, bh - gap * 2);
        ctx.fillStyle = 'rgba(72,60,42,0.22)';
        ctx.fillRect(x + gap, row * bh + bh - gap - 2, bw - gap * 2, 2);
        ctx.fillRect(x + bw - gap - 2, row * bh + gap, 2, bh - gap * 2);
        /* mortar shading + weathering blotches on every block */
        blob(ctx, x + bw * 0.5, row * bh + bh * 0.5, bw * 0.42, 'rgba(120,102,74,0.10)');
      }
    }
    overlayGrain(ctx, S, 0.24, 'overlay');
    overlayGrunge(ctx, S, 0.16, 'soft-light');
    return cv;
  }

  /* ---- mud brick wall ---- */
  function texBrick() {
    var S = 256, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(404);
    ctx.fillStyle = '#8b7355';
    ctx.fillRect(0, 0, S, S);
    var rows = 8, cols = 4, bw = S / cols, bh = S / rows, gap = 3;
    for (var row = 0; row < rows; row++) {
      var off = (row % 2) ? bw * 0.5 : 0;
      for (var col = -1; col <= cols; col++) {
        var x = col * bw + off;
        var v = rand();
        var r = 172 + v * 26, g = 126 + v * 24, b = 92 + v * 20;
        if (rand() < 0.16) { r += 10; g += 8; b += 6; }
        if (rand() < 0.12) { r -= 16; g -= 13; b -= 9; }
        ctx.fillStyle = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
        ctx.fillRect(x + gap, row * bh + gap, bw - gap * 2, bh - gap * 2);
        ctx.fillStyle = 'rgba(255,228,190,0.10)';
        ctx.fillRect(x + gap, row * bh + gap, bw - gap * 2, 2);
        ctx.fillStyle = 'rgba(56,38,22,0.16)';
        ctx.fillRect(x + gap, row * bh + bh - gap - 2, bw - gap * 2, 2);
        /* pitting on brick face */
        for (var k = 0; k < 4; k++) {
          ctx.fillStyle = 'rgba(70,48,28,' + (0.05 + rand() * 0.12).toFixed(3) + ')';
          ctx.beginPath();
          ctx.arc(x + gap + rand() * (bw - gap * 2), row * bh + gap + rand() * (bh - gap * 2), 0.6 + rand() * 1.6, 0, TAU);
          ctx.fill();
        }
      }
    }
    /* sand dust accumulated in the joints */
    overlayGrunge(ctx, S, 0.34, 'multiply');
    overlayGrain(ctx, S, 0.3, 'overlay');
    return cv;
  }

  /* ---- wooden crate with frame + planks ---- */
  function texCrate() {
    var S = 256, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(505);
    /* inner planks */
    var m = 24, inner = S - m * 2, planks = 4, pw = inner / planks;
    ctx.fillStyle = '#5d4223';
    ctx.fillRect(0, 0, S, S);
    for (var p = 0; p < planks; p++) {
      var x = m + p * pw;
      var v = rand();
      var r = 176 + v * 34, g = 134 + v * 28, b = 82 + v * 22;
      ctx.fillStyle = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
      ctx.fillRect(x + 1, m, pw - 2, inner);
      /* vertical grain */
      for (var k = 0; k < 9; k++) {
        ctx.strokeStyle = 'rgba(84,56,26,' + (0.08 + rand() * 0.14).toFixed(3) + ')';
        ctx.lineWidth = 0.6 + rand() * 1.3;
        ctx.beginPath();
        var gx = x + 3 + rand() * (pw - 6), gy = m + 2;
        ctx.moveTo(gx, gy);
        while (gy < m + inner - 4) {
          gy += 8 + rand() * 18;
          gx += (rand() - 0.5) * 3;
          ctx.lineTo(gx, gy);
        }
        ctx.stroke();
      }
      if (rand() < 0.6) {
        var kx = x + 6 + rand() * (pw - 12), ky = m + 18 + rand() * (inner - 36);
        ctx.strokeStyle = 'rgba(70,46,20,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(kx, ky, 3 + rand() * 3, 2 + rand() * 2, rand(), 0, TAU); ctx.stroke();
      }
    }
    /* outer frame boards */
    var fr = 24;
    ctx.fillStyle = '#9a7140';
    ctx.fillRect(0, 0, S, fr);
    ctx.fillRect(0, S - fr, S, fr);
    ctx.fillRect(0, 0, fr, S);
    ctx.fillRect(S - fr, 0, fr, S);
    /* frame grain + bevels */
    for (var f = 0; f < 60; f++) {
      ctx.strokeStyle = 'rgba(72,48,22,' + (0.06 + rand() * 0.1).toFixed(3) + ')';
      ctx.lineWidth = 0.7;
      var horizontal = rand() < 0.5;
      ctx.beginPath();
      if (horizontal) {
        var yy = rand() * S, xx = rand() * S;
        ctx.moveTo(xx, yy); ctx.lineTo(xx + 18 + rand() * 40, yy + (rand() - 0.5) * 2);
      } else {
        var xx2 = rand() * S, yy2 = rand() * S;
        ctx.moveTo(xx2, yy2); ctx.lineTo(xx2 + (rand() - 0.5) * 2, yy2 + 18 + rand() * 40);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(52,34,15,0.45)';
    ctx.lineWidth = 2;
    ctx.strokeRect(fr, fr, S - fr * 2, S - fr * 2);
    ctx.strokeStyle = 'rgba(255,226,170,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(1, 1, S - 2, S - 2);
    /* corner metal brackets + nails */
    var corners = [[0, 0], [S - 34, 0], [0, S - 34], [S - 34, S - 34]];
    for (var c = 0; c < 4; c++) {
      ctx.fillStyle = 'rgba(96,94,86,0.85)';
      ctx.fillRect(corners[c][0], corners[c][1], 34, 34);
      ctx.strokeStyle = 'rgba(40,40,36,0.6)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(corners[c][0] + 1, corners[c][1] + 1, 32, 32);
      ctx.fillStyle = '#3c3a34';
      for (var n = 0; n < 4; n++) {
        ctx.beginPath();
        ctx.arc(corners[c][0] + 8 + (n % 2) * 18, corners[c][1] + 8 + ((n / 2) | 0) * 18, 2.2, 0, TAU);
        ctx.fill();
      }
    }
    overlayGrain(ctx, S, 0.34, 'overlay');
    overlayGrunge(ctx, S, 0.14, 'multiply');
    return cv;
  }

  /* ---- brushed metal ---- */
  function texMetal() {
    var S = 256, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(606);
    var large = fbm(S, rand, 3, 4, 0.55);
    var img = ctx.createImageData(S, S), d = img.data;
    for (var y = 0; y < S; y++) {
      var band = Math.sin(y * 0.55) * 2.0;
      for (var x = 0; x < S; x++) {
        var i = y * S + x;
        var n = large[i];
        var t = 0.40 + n * 0.26 + band * 0.01 + (rand() - 0.5) * 0.045;
        var r = 112 * t * 2.4, g = 119 * t * 2.4, b = 126 * t * 2.4;
        d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    /* horizontal brushed streaks */
    for (var k = 0; k < 520; k++) {
      var yy = rand() * S, xx = rand() * S, len = 8 + rand() * 60;
      ctx.strokeStyle = rand() < 0.5
        ? 'rgba(230,236,242,' + (0.015 + rand() * 0.05).toFixed(3) + ')'
        : 'rgba(40,44,50,' + (0.015 + rand() * 0.05).toFixed(3) + ')';
      ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx + len, yy + (rand() - 0.5) * 0.8); ctx.stroke();
    }
    /* rust blooms near random spots */
    for (k = 0; k < 7; k++) {
      var bx = rand() * S, by = rand() * S, br = 12 + rand() * 40;
      blob(ctx, bx, by, br, 'rgba(122,66,32,0.13)');
      blob(ctx, bx + (rand() - 0.5) * 10, by + (rand() - 0.5) * 10, br * 0.5, 'rgba(94,46,20,0.14)');
    }
    /* rivets along the top and bottom */
    for (var rx = 16; rx < S; rx += 32) {
      for (var ry = 0; ry < 2; ry++) {
        var cy = ry === 0 ? 12 : S - 12;
        ctx.fillStyle = '#5a6167';
        ctx.beginPath(); ctx.arc(rx, cy, 4, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(232,238,244,0.45)';
        ctx.beginPath(); ctx.arc(rx - 1.2, cy - 1.2, 1.7, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(30,32,36,0.45)';
        ctx.beginPath(); ctx.arc(rx + 1.4, cy + 1.4, 2.1, 0, TAU); ctx.fill();
      }
    }
    /* scratches */
    for (k = 0; k < 40; k++) {
      ctx.strokeStyle = 'rgba(226,232,238,0.10)';
      ctx.lineWidth = 0.8;
      var sx = rand() * S, sy = rand() * S, sa = (rand() - 0.5) * 0.8;
      ctx.beginPath(); ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.cos(sa) * (10 + rand() * 34), sy + Math.sin(sa) * (10 + rand() * 34));
      ctx.stroke();
    }
    overlayGrain(ctx, S, 0.14, 'overlay');
    return cv;
  }

  /* ---- concrete ---- */
  function texConcrete() {
    var S = 256, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(707);
    var large = fbm(S, rand, 4, 3, 0.55);
    var med = fbm(S, rand, 3, 11, 0.5);
    var fine = tileNoise(S, 110, rand);
    var img = ctx.createImageData(S, S), d = img.data;
    var dR = 140, dG = 136, dB = 126;
    var lR = 208, lG = 204, lB = 192;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var i = y * S + x;
        var n = large[i] * 0.58 + med[i] * 0.42;
        var t = clamp01(n * 0.85 + 0.08);
        var r = dR + (lR - dR) * t, g = dG + (lG - dG) * t, b = dB + (lB - dB) * t;
        var gr = (fine[i] - 0.5) * 22;
        d[i * 4] = r + gr; d[i * 4 + 1] = g + gr; d[i * 4 + 2] = b + gr; d[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    /* aggregate speckles */
    for (var k = 0; k < 1400; k++) {
      ctx.fillStyle = rand() < 0.6
        ? 'rgba(72,70,64,' + (0.05 + rand() * 0.13).toFixed(3) + ')'
        : 'rgba(222,219,208,' + (0.04 + rand() * 0.1).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(rand() * S, rand() * S, 0.4 + rand() * 1.3, 0, TAU);
      ctx.fill();
    }
    /* stains */
    for (k = 0; k < 6; k++) {
      blob(ctx, rand() * S, rand() * S, 20 + rand() * 50, 'rgba(88,84,74,0.10)');
    }
    /* formwork seams (wraps by tiling) */
    ctx.fillStyle = 'rgba(82,80,72,0.18)';
    ctx.fillRect(0, 0, S, 2);
    ctx.fillRect(0, S - 2, S, 2);
    /* cracks */
    ctx.strokeStyle = 'rgba(64,62,56,0.4)';
    ctx.lineWidth = 1.1;
    for (k = 0; k < 4; k++) {
      var cx = rand() * S, cy = rand() * S, ang = rand() * TAU;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      var segs = 5 + ((rand() * 7) | 0);
      for (var s = 0; s < segs; s++) {
        ang += (rand() - 0.5) * 0.9;
        cx += Math.cos(ang) * (6 + rand() * 14);
        cy += Math.sin(ang) * (6 + rand() * 14);
        ctx.lineTo(cx, cy);
      }
      ctx.stroke();
    }
    overlayGrain(ctx, S, 0.2, 'overlay');
    return cv;
  }

  /* ---- wooden planks ---- */
  function texWood() {
    var S = 256, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(808);
    var rows = 5, bh = S / rows;
    ctx.fillStyle = '#6b4c28';
    ctx.fillRect(0, 0, S, S);
    for (var row = 0; row < rows; row++) {
      var y = row * bh;
      var v = rand();
      var r = 188 + v * 40, g = 146 + v * 32, b = 90 + v * 26;
      ctx.fillStyle = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
      ctx.fillRect(0, y + 2, S, bh - 4);
      /* horizontal grain */
      for (var k = 0; k < 14; k++) {
        ctx.strokeStyle = 'rgba(78,52,24,' + (0.06 + rand() * 0.16).toFixed(3) + ')';
        ctx.lineWidth = 0.7 + rand() * 1.4;
        var gy = y + 4 + rand() * (bh - 8);
        ctx.beginPath();
        ctx.moveTo(-4, gy);
        for (var gx = 0; gx <= S + 8; gx += 24) {
          gy += (rand() - 0.5) * 1.6;
          ctx.lineTo(gx, gy);
        }
        ctx.stroke();
      }
      /* knots */
      if (rand() < 0.7) {
        var kx = rand() * S, ky = y + 8 + rand() * (bh - 16);
        for (var ring = 0; ring < 3; ring++) {
          ctx.strokeStyle = 'rgba(72,46,20,' + (0.22 - ring * 0.05).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.ellipse(kx, ky, 3 + ring * 2.6, 1.6 + ring * 1.5, rand() * 0.4, 0, TAU);
          ctx.stroke();
        }
      }
      /* plank separation shadow */
      ctx.fillStyle = 'rgba(40,26,12,0.45)';
      ctx.fillRect(0, y + bh - 2, S, 2);
      ctx.fillStyle = 'rgba(255,224,170,0.10)';
      ctx.fillRect(0, y + 2, S, 1);
    }
    /* nails at plank ends */
    for (var n = 0; n < rows; n++) {
      for (var s = 0; s < 2; s++) {
        var nx = s === 0 ? 10 : S - 10;
        var ny = n * bh + bh * 0.5;
        ctx.fillStyle = '#3f3d36';
        ctx.beginPath(); ctx.arc(nx, ny, 2.1, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(220,218,205,0.35)';
        ctx.beginPath(); ctx.arc(nx - 0.6, ny - 0.6, 0.9, 0, TAU); ctx.fill();
      }
    }
    overlayGrain(ctx, S, 0.3, 'overlay');
    overlayGrunge(ctx, S, 0.12, 'multiply');
    return cv;
  }

  /* ---- soft round shadow (black + alpha falloff) ---- */
  function texShadow() {
    var S = 256, cv = makeCanvas(S), ctx = ctxOf(cv);
    var g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0.0, 'rgba(0,0,0,0.92)');
    g.addColorStop(0.42, 'rgba(0,0,0,0.62)');
    g.addColorStop(0.72, 'rgba(0,0,0,0.24)');
    g.addColorStop(0.9, 'rgba(0,0,0,0.05)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return cv;
  }

  /* ---- spark: hot core + rays (additive) ---- */
  function texSpark() {
    var S = 128, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(1001);
    var c = S / 2;
    var g = ctx.createRadialGradient(c, c, 0, c, c, S * 0.5);
    g.addColorStop(0, 'rgba(255,255,250,1)');
    g.addColorStop(0.14, 'rgba(255,238,180,0.95)');
    g.addColorStop(0.34, 'rgba(255,168,60,0.55)');
    g.addColorStop(0.65, 'rgba(226,96,20,0.14)');
    g.addColorStop(1, 'rgba(180,60,10,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(c, c, S * 0.5, 0, TAU); ctx.fill();
    for (var k = 0; k < 7; k++) {
      var ang = (k / 7) * TAU + rand() * 0.4;
      var len = S * (0.28 + rand() * 0.2), wid = 2.2 + rand() * 2.4;
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(ang);
      var lg = ctx.createLinearGradient(0, 0, len, 0);
      lg.addColorStop(0, 'rgba(255,246,210,0.85)');
      lg.addColorStop(0.5, 'rgba(255,190,90,0.35)');
      lg.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(0, -wid); ctx.lineTo(len, 0); ctx.lineTo(0, wid); ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    return cv;
  }

  /* ---- smoke puff (alpha) ---- */
  function texSmoke() {
    var S = 128, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(1102);
    var c = S / 2;
    for (var k = 0; k < 14; k++) {
      var ang = rand() * TAU, rad = rand() * S * 0.22;
      var x = c + Math.cos(ang) * rad, y = c + Math.sin(ang) * rad;
      var r = S * (0.13 + rand() * 0.19);
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      var a = 0.08 + rand() * 0.7;
      g.addColorStop(0, 'rgba(238,233,222,' + a.toFixed(3) + ')');
      g.addColorStop(0.55, 'rgba(210,202,188,' + (a * 0.45).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(190,182,168,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }
    return cv;
  }

  /* ---- muzzle flash star (additive) ---- */
  function texMuzzle() {
    var S = 128, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(1203);
    var c = S / 2;
    /* horizontal flare */
    var lg = ctx.createLinearGradient(0, c, S, c);
    lg.addColorStop(0, 'rgba(255,180,70,0)');
    lg.addColorStop(0.32, 'rgba(255,214,120,0.35)');
    lg.addColorStop(0.5, 'rgba(255,250,225,0.95)');
    lg.addColorStop(0.68, 'rgba(255,214,120,0.35)');
    lg.addColorStop(1, 'rgba(255,180,70,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(0, c - 5, S, 10);
    /* spikes */
    for (var k = 0; k < 9; k++) {
      var ang = (k / 9) * TAU + rand() * 0.3;
      var len = S * (0.22 + rand() * 0.26), wid = 3 + rand() * 4;
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(ang);
      var rl = ctx.createLinearGradient(0, 0, len, 0);
      rl.addColorStop(0, 'rgba(255,252,235,0.95)');
      rl.addColorStop(0.45, 'rgba(255,222,130,0.5)');
      rl.addColorStop(1, 'rgba(255,160,50,0)');
      ctx.fillStyle = rl;
      ctx.beginPath();
      ctx.moveTo(0, -wid); ctx.lineTo(len, 0); ctx.lineTo(0, wid); ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    /* core */
    var g = ctx.createRadialGradient(c, c, 0, c, c, S * 0.34);
    g.addColorStop(0, 'rgba(255,255,252,1)');
    g.addColorStop(0.28, 'rgba(255,246,205,0.95)');
    g.addColorStop(0.62, 'rgba(255,196,95,0.5)');
    g.addColorStop(1, 'rgba(255,150,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(c, c, S * 0.34, 0, TAU); ctx.fill();
    return cv;
  }

  /* ---- blood splat (red) ---- */
  function texBlood() {
    var S = 128, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(1304);
    var c = S / 2;
    var g = ctx.createRadialGradient(c, c, 0, c, c, S * 0.34);
    g.addColorStop(0, 'rgba(176,18,16,0.95)');
    g.addColorStop(0.4, 'rgba(130,10,10,0.72)');
    g.addColorStop(0.75, 'rgba(86,6,6,0.28)');
    g.addColorStop(1, 'rgba(70,4,4,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(c, c, S * 0.34, 0, TAU); ctx.fill();
    for (var k = 0; k < 16; k++) {
      var ang = rand() * TAU, rad = S * (0.14 + rand() * 0.26);
      var x = c + Math.cos(ang) * rad, y = c + Math.sin(ang) * rad;
      var r = 1.4 + rand() * 6;
      var gg = ctx.createRadialGradient(x, y, 0, x, y, r);
      gg.addColorStop(0, 'rgba(150,12,12,0.85)');
      gg.addColorStop(1, 'rgba(90,6,6,0)');
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }
    return cv;
  }

  /* ---- beam/tracer strip (internal, 64x16) ---- */
  function texBeam() {
    var W = 64, H = 16, cv = makeCanvas(W, H), ctx = ctxOf(cv);
    var img = ctx.createImageData(W, H), d = img.data;
    for (var y = 0; y < H; y++) {
      var v = y / (H - 1);
      var prof = Math.pow(1 - Math.abs(v * 2 - 1), 1.5);
      for (var x = 0; x < W; x++) {
        var u = x / (W - 1);
        var end = Math.min(1, Math.min(u, 1 - u) / 0.14);
        end = smoothstep01(end);
        var a = prof * end * 255;
        var i = (y * W + x) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  /* ---- bullet hole decal (internal) ---- */
  function texDecalHole() {
    var S = 128, cv = makeCanvas(S), ctx = ctxOf(cv);
    var rand = mulberry32(1405);
    var c = S / 2;
    /* dust halo */
    var halo = ctx.createRadialGradient(c, c, S * 0.08, c, c, S * 0.5);
    halo.addColorStop(0, 'rgba(118,104,84,0.10)');
    halo.addColorStop(0.6, 'rgba(118,104,84,0.05)');
    halo.addColorStop(1, 'rgba(118,104,84,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, S, S);
    /* chipped rim */
    ctx.strokeStyle = 'rgba(206,192,166,0.22)';
    ctx.lineWidth = 3;
    for (var k = 0; k < 5; k++) {
      var a0 = rand() * TAU, a1 = a0 + 0.5 + rand() * 1.4;
      ctx.beginPath(); ctx.arc(c, c, 11 + rand() * 3, a0, a1); ctx.stroke();
    }
    /* hole */
    var g = ctx.createRadialGradient(c, c, 0, c, c, 12);
    g.addColorStop(0, 'rgba(14,11,9,0.98)');
    g.addColorStop(0.45, 'rgba(26,21,16,0.95)');
    g.addColorStop(0.75, 'rgba(40,32,24,0.62)');
    g.addColorStop(1, 'rgba(48,40,30,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(c, c, 12, 0, TAU); ctx.fill();
    /* radial cracks */
    ctx.strokeStyle = 'rgba(38,30,22,0.45)';
    for (k = 0; k < 8; k++) {
      var ang = rand() * TAU, len = 8 + rand() * 20;
      ctx.lineWidth = 0.6 + rand() * 1.4;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(ang) * 8, c + Math.sin(ang) * 8);
      var px = c, py = c;
      for (var s = 0; s < 3; s++) {
        ang += (rand() - 0.5) * 0.6;
        px += Math.cos(ang) * (len / 3);
        py += Math.sin(ang) * (len / 3);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    return cv;
  }

  /* ---- missing texture: magenta checkerboard ---- */
  function texMissing() {
    var S = 64, cv = makeCanvas(S), ctx = ctxOf(cv);
    var cell = 8;
    for (var y = 0; y < S / cell; y++) {
      for (var x = 0; x < S / cell; x++) {
        ctx.fillStyle = ((x + y) & 1) ? '#ff00ff' : '#140014';
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    return cv;
  }

  var TEX_GEN = {
    white: texWhite,
    sandfloor: texSandfloor,
    wall: texWall,
    wall2: texWall2,
    brick: texBrick,
    crate: texCrate,
    metal: texMetal,
    concrete: texConcrete,
    wood: texWood,
    shadow: texShadow,
    spark: texSpark,
    smoke: texSmoke,
    muzzle: texMuzzle,
    blood: texBlood
  };
  var TEX_INTERNAL = {
    beam: texBeam,
    decalhole: texDecalHole,
    __missing: texMissing
  };
  var TEX_REPEAT = {
    white: true, sandfloor: true, wall: true, wall2: true, brick: true,
    crate: true, metal: true, concrete: true, wood: true
  };

  /* ======================================================================
   * 3. shaders
   * ==================================================================== */
  var VS_MAIN = [
    'attribute vec3 aPos;',
    'attribute vec3 aNormal;',
    'attribute vec2 aUV;',
    'attribute vec4 aColor;',
    'uniform mat4 uViewProj;',
    'uniform mat4 uModel;',
    'varying vec3 vWorld;',
    'varying vec3 vNormal;',
    'varying vec2 vUV;',
    'varying vec4 vColor;',
    'void main(){',
    '  vec4 wp = uModel * vec4(aPos, 1.0);',
    '  vWorld = wp.xyz;',
    '  vNormal = mat3(uModel) * aNormal;',
    '  vUV = aUV;',
    '  vColor = aColor;',
    '  gl_Position = uViewProj * wp;',
    '}'
  ].join('\n');

  var FS_MAIN = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform sampler2D uTex;',
    'uniform vec3 uSunDir;',
    'uniform vec3 uSunColor;',
    'uniform vec3 uAmbSky;',
    'uniform vec3 uAmbGround;',
    'uniform vec3 uFogColor;',
    'uniform float uFogNear;',
    'uniform float uFogFar;',
    'uniform vec3 uCamPos;',
    'varying vec3 vWorld;',
    'varying vec3 vNormal;',
    'varying vec2 vUV;',
    'varying vec4 vColor;',
    'void main(){',
    '  vec3 base = texture2D(uTex, vUV).rgb;',
    '  vec3 n = vNormal;',
    '  float nl = length(n);',
    '  n = nl > 0.0001 ? n / nl : vec3(0.0, 1.0, 0.0);',
    '  float ndl = max(dot(n, uSunDir), 0.0);',
    '  vec3 amb = mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5);',
    '  vec3 light = amb + uSunColor * ndl;',
    '  vec3 col = base * vColor.rgb * light;',
    '  float d = length(vWorld - uCamPos);',
    '  float f = clamp((d - uFogNear) / max(uFogFar - uFogNear, 0.001), 0.0, 1.0);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  col = mix(col, uFogColor, f);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var VS_FX = [
    'attribute vec3 aPos;',
    'attribute vec2 aUV;',
    'attribute vec4 aColor;',
    'uniform mat4 uViewProj;',
    'varying vec2 vUV;',
    'varying vec4 vColor;',
    'varying vec3 vWorld;',
    'void main(){',
    '  vUV = aUV;',
    '  vColor = aColor;',
    '  vWorld = aPos;',
    '  gl_Position = uViewProj * vec4(aPos, 1.0);',
    '}'
  ].join('\n');

  var FS_FX = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform sampler2D uTex;',
    'uniform vec3 uCamPos;',
    'uniform float uFogNear;',
    'uniform float uFogFar;',
    'varying vec2 vUV;',
    'varying vec4 vColor;',
    'varying vec3 vWorld;',
    'void main(){',
    '  vec4 tex = texture2D(uTex, vUV);',
    '  vec4 c = tex * vColor;',
    '  float d = length(vWorld - uCamPos);',
    '  float f = clamp((d - uFogNear) / max(uFogFar - uFogNear, 0.001), 0.0, 1.0);',
    '  c.a *= 1.0 - f * 0.85;',
    '  if (c.a < 0.004) discard;',
    '  gl_FragColor = c;',
    '}'
  ].join('\n');

  var VS_SKY = [
    'attribute vec2 aPos;',
    'varying vec2 vNdc;',
    'void main(){',
    '  vNdc = aPos;',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FS_SKY = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'varying vec2 vNdc;',
    'uniform mat4 uInvViewProj;',
    'uniform vec3 uCamPos;',
    'uniform vec3 uSkyTop;',
    'uniform vec3 uSkyHorizon;',
    'uniform vec3 uSkyGround;',
    'uniform vec3 uSunDir;',
    'uniform vec3 uSunColor;',
    'void main(){',
    '  vec4 p = uInvViewProj * vec4(vNdc, 1.0, 1.0);',
    '  vec3 dir = normalize(p.xyz / p.w - uCamPos);',
    '  float h = dir.y;',
    '  float up = smoothstep(-0.015, 0.55, h);',
    '  vec3 col = mix(uSkyHorizon, uSkyTop, pow(up, 0.8));',
    '  col = mix(uSkyGround, col, smoothstep(-0.30, -0.005, h));',
    '  float sd = max(dot(dir, uSunDir), 0.0);',
    '  col += uSunColor * 0.09 * exp(-abs(h) * 11.0) * (0.4 + 0.6 * pow(sd, 4.0));',
    '  col += uSunColor * (pow(sd, 2600.0) * 1.9 + pow(sd, 22.0) * 0.16 + pow(sd, 3.0) * 0.03);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* ======================================================================
   * 4. renderer implementation
   * ==================================================================== */
  var IDENT = M.M4 ? M.M4.identity() : new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  var SUN_DIR = norm3(-0.42, 0.60, -0.68);
  var SUN_COLOR = [0.55, 0.46, 0.30];
  var AMB_SKY = [0.85, 0.87, 0.90];
  var AMB_GROUND = [0.62, 0.55, 0.44];
  var SUN_SKY = [1.0, 0.86, 0.62];
  var DEFAULT_SKY_TOP = [0.40, 0.53, 0.68];
  var DEFAULT_SKY_BOTTOM = [0.93, 0.85, 0.67];
  var DEFAULT_FOG = [0.80, 0.73, 0.59];

  var CUBE_V = (function () {
    /* 36 verts (6 per face, two triangles per face); stride 8. */
    var v = new Float32Array(36 * 8);
    var o = 0;
    var UV = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
    function face(nx, ny, nz, p0, p1, p2, p3) {
      var pts = [p0, p1, p2, p0, p2, p3];
      for (var i = 0; i < 6; i++) {
        v[o++] = pts[i][0]; v[o++] = pts[i][1]; v[o++] = pts[i][2];
        v[o++] = nx; v[o++] = ny; v[o++] = nz;
        v[o++] = UV[i][0]; v[o++] = UV[i][1];
      }
    }
    var h = 0.5;
    face(0, 0, 1, [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]);
    face(0, 0, -1, [h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]);
    face(1, 0, 0, [h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]);
    face(-1, 0, 0, [-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]);
    face(0, 1, 0, [-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]);
    face(0, -1, 0, [-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]);
    return v;
  })();

  /* growable float buffer */
  function FloatBuf(cap) {
    this.a = new Float32Array(cap || 1024);
    this.n = 0;
  }
  FloatBuf.prototype.reserve = function (count) {
    var need = this.n + count;
    if (need > this.a.length) {
      var cap = this.a.length;
      while (cap < need) cap <<= 1;
      var b = new Float32Array(cap);
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
    var o = this.n;
    this.n = need;
    return o;
  };
  FloatBuf.prototype.reset = function () { this.n = 0; };

  /* Emit a textured quad (6 verts, stride 9: x,y,z,u,v,r,g,b,a). */
  function pushQuad(buf, x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, r, g, b, a) {
    var A = buf.a, o = buf.reserve(54);
    A[o++] = x0; A[o++] = y0; A[o++] = z0; A[o++] = 0; A[o++] = 0; A[o++] = r; A[o++] = g; A[o++] = b; A[o++] = a;
    A[o++] = x1; A[o++] = y1; A[o++] = z1; A[o++] = 1; A[o++] = 0; A[o++] = r; A[o++] = g; A[o++] = b; A[o++] = a;
    A[o++] = x2; A[o++] = y2; A[o++] = z2; A[o++] = 1; A[o++] = 1; A[o++] = r; A[o++] = g; A[o++] = b; A[o++] = a;
    A[o++] = x0; A[o++] = y0; A[o++] = z0; A[o++] = 0; A[o++] = 0; A[o++] = r; A[o++] = g; A[o++] = b; A[o++] = a;
    A[o++] = x2; A[o++] = y2; A[o++] = z2; A[o++] = 1; A[o++] = 1; A[o++] = r; A[o++] = g; A[o++] = b; A[o++] = a;
    A[o++] = x3; A[o++] = y3; A[o++] = z3; A[o++] = 0; A[o++] = 1; A[o++] = r; A[o++] = g; A[o++] = b; A[o++] = a;
    buf.n = o;
  }
  /* Emit one fx vertex. */
  function pushVert(A, o, x, y, z, u, v, r, g, b, a) {
    A[o++] = x; A[o++] = y; A[o++] = z;
    A[o++] = u; A[o++] = v;
    A[o++] = r; A[o++] = g; A[o++] = b; A[o++] = a;
    return o;
  }

  function compileShader(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('shader compile failed: ' + log);
    }
    return s;
  }
  function linkProgram(gl, vsSrc, fsSrc) {
    var p = gl.createProgram();
    var vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('program link failed: ' + log);
    }
    return p;
  }

  function getGL(canvas) {
    var attrs = {
      alpha: false, depth: true, stencil: false, antialias: true,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    };
    var gl = null;
    try {
      gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    } catch (e) { gl = null; }
    if (!gl) {
      try {
        gl = canvas.getContext('webgl', { alpha: false, depth: true, antialias: false }) ||
          canvas.getContext('experimental-webgl', { alpha: false, depth: true });
      } catch (e2) { gl = null; }
    }
    return gl;
  }

  function createGLRenderer(canvas) {
    var gl = getGL(canvas);
    if (!gl) return null;

    var R = {
      gl: gl,
      canvas: canvas,
      isNull: false,
      width: 1,
      height: 1,
      dpr: 1,
      stats: { draws: 0, tris: 0, objects: 0 },
      texNames: TEX_PUBLIC.slice(),
      camera: null
    };

    /* ---------------- programs / locations ---------------- */
    var progMain = linkProgram(gl, VS_MAIN, FS_MAIN);
    var progFx = linkProgram(gl, VS_FX, FS_FX);
    var progSky = linkProgram(gl, VS_SKY, FS_SKY);

    function attrLocs(prog, names) {
      var o = {};
      for (var i = 0; i < names.length; i++) o[names[i]] = gl.getAttribLocation(prog, names[i]);
      return o;
    }
    function uniLocs(prog, names) {
      var o = {};
      for (var i = 0; i < names.length; i++) o[names[i]] = gl.getUniformLocation(prog, names[i]);
      return o;
    }
    var aMain = attrLocs(progMain, ['aPos', 'aNormal', 'aUV', 'aColor']);
    var uMain = uniLocs(progMain, ['uViewProj', 'uModel', 'uTex', 'uSunDir', 'uSunColor',
      'uAmbSky', 'uAmbGround', 'uFogColor', 'uFogNear', 'uFogFar', 'uCamPos']);
    var aFx = attrLocs(progFx, ['aPos', 'aUV', 'aColor']);
    var uFx = uniLocs(progFx, ['uViewProj', 'uTex', 'uCamPos', 'uFogNear', 'uFogFar']);
    var aSky = attrLocs(progSky, ['aPos']);
    var uSky = uniLocs(progSky, ['uInvViewProj', 'uCamPos', 'uSkyTop', 'uSkyHorizon',
      'uSkyGround', 'uSunDir', 'uSunColor']);

    /* ---------------- static GL objects ---------------- */
    var skyQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, skyQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);

    var meshDynBuf = gl.createBuffer();
    var fxDynBuf = gl.createBuffer();

    /* ---------------- textures ---------------- */
    var anisoExt = gl.getExtension('EXT_texture_filter_anisotropic') ||
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    var maxAniso = 1;
    if (anisoExt) {
      try { maxAniso = Math.min(8, gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1); } catch (e) { maxAniso = 1; }
    }
    var texMap = Object.create(null);
    function uploadTex(name, cv, repeat) {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      var wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      if (anisoExt && repeat && maxAniso > 1) {
        gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, maxAniso);
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      var entry = { key: name, tex: t, repeat: !!repeat };
      texMap[name] = entry;
      return entry;
    }
    var missingEnt = null;
    function buildTextures() {
      var name, cv, i;
      buildSharedOverlays();
      for (i = 0; i < TEX_PUBLIC.length; i++) {
        name = TEX_PUBLIC[i];
        cv = TEX_GEN[name]();
        uploadTex(name, cv, !!TEX_REPEAT[name]);
      }
      for (name in TEX_INTERNAL) {
        if (!Object.prototype.hasOwnProperty.call(TEX_INTERNAL, name)) continue;
        cv = TEX_INTERNAL[name]();
        uploadTex(name, cv, !!TEX_REPEAT[name]);
      }
      missingEnt = texMap.__missing;
    }
    buildTextures();

    var unknownWarned = Object.create(null);
    function resolveTex(name) {
      if (name === undefined || name === null || name === '') name = 'white';
      var t = texMap[name];
      if (t) return t;
      if (!unknownWarned[name]) {
        unknownWarned[name] = true;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[CS.gl] unknown texture "' + name + '" -> using magenta checker');
        }
      }
      return missingEnt;
    }

    /* ---------------- camera ---------------- */
    var cam = R.camera = {
      eye: [0, 1.62, 0],
      yaw: 0,
      pitch: 0,
      fov: 1.0,          /* vertical fov (rad) */
      fovDeg: 90,        /* requested horizontal fov */
      aspect: 1,
      near: 0.05,
      far: 320,
      view: null,
      proj: null,
      viewProj: null,
      invView: null,
      invViewProj: null,
      forward: [0, 0, -1],
      right: [1, 0, 0],
      up: [0, 1, 0]
    };

    function updateCamera() {
      if (!M.M4) {
        cam.view = IDENT; cam.proj = IDENT; cam.viewProj = IDENT;
        return;
      }
      var aspect = Math.max(0.0001, R.width / R.height);
      var fovH = cam.fovDeg * PI / 180;
      var fovV = 2 * Math.atan(Math.tan(fovH * 0.5) / aspect);
      fovV = clamp(fovV, 0.2, 2.4);
      cam.fov = fovV;
      cam.aspect = aspect;
      cam.view = M.M4.cameraView(cam.eye, cam.yaw, cam.pitch);
      cam.proj = M.M4.perspective(fovV, aspect, cam.near, cam.far);
      cam.viewProj = M.M4.multiply(cam.proj, cam.view);
      cam.invView = M.M4.cameraWorld(cam.eye, cam.yaw, cam.pitch);
      cam.invViewProj = null;
      cam.forward = M.cameraForward(cam.yaw, cam.pitch);
      cam.right = M.cameraRight(cam.yaw);
      cam.up = M.cameraUp(cam.yaw, cam.pitch);
    }

    R.setCamera = function (eye, yaw, pitch, fovDeg) {
      if (eye) {
        cam.eye[0] = +eye[0] || 0;
        cam.eye[1] = +eye[1] || 0;
        cam.eye[2] = +eye[2] || 0;
      }
      if (isFinite(yaw)) cam.yaw = +yaw;
      if (isFinite(pitch)) cam.pitch = +pitch;
      if (isFinite(fovDeg) && fovDeg > 1) cam.fovDeg = +fovDeg;
      updateCamera();
    };

    /* ---------------- resize ---------------- */
    R.resize = function () {
      var cw = canvas.clientWidth || canvas.width || 800;
      var ch = canvas.clientHeight || canvas.height || 450;
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      if (!(dpr > 0)) dpr = 1;
      var w = Math.max(1, Math.floor(cw * dpr));
      var h = Math.max(1, Math.floor(ch * dpr));
      R.dpr = dpr;
      if (w !== R.width || h !== R.height || canvas.width !== w || canvas.height !== h) {
        R.width = w; R.height = h;
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, R.width, R.height);
      updateCamera();
    };

    /* ---------------- frame state ---------------- */
    var frameId = 0;
    var opaqueMeshes = [];
    var opaqueGroups = [];       /* persistent per-texture batches */
    var opaqueMap = Object.create(null);
    var opaqueOrder = [];
    var fxGroups = [];
    var fxMap = Object.create(null);
    var fxOrder = [];
    var transCmds = [];

    var curSkyTop = DEFAULT_SKY_TOP.slice();
    var curSkyBottom = DEFAULT_SKY_BOTTOM.slice();
    var curSkyGround = [0.72, 0.65, 0.53];
    var curFogColor = DEFAULT_FOG.slice();
    /* Lead feedback: keep 30-50m clearly readable; haze mostly for the far
       side of the map / menu orbit camera. */
    var curFogNear = 24;
    var curFogFar = 122;

    function getOpaqueGroup(texEnt) {
      var g = opaqueMap[texEnt.key];
      if (!g) {
        g = { key: texEnt.key, texEnt: texEnt, buf: new FloatBuf(4096), frame: -1 };
        opaqueMap[texEnt.key] = g;
        opaqueGroups.push(g);
      }
      if (g.frame !== frameId) {
        g.frame = frameId;
        g.buf.reset();
        opaqueOrder.push(g);
      }
      return g;
    }
    function getFxGroup(texEnt, additive, ground) {
      var key = texEnt.key + '|' + (additive ? 1 : 0) + '|' + (ground ? 1 : 0);
      var g = fxMap[key];
      if (!g) {
        g = {
          key: key, texEnt: texEnt, add: !!additive, ground: !!ground,
          buf: new FloatBuf(4096), frame: -1
        };
        fxMap[key] = g;
        fxGroups.push(g);
      }
      if (g.frame !== frameId) {
        g.frame = frameId;
        g.buf.reset();
        fxOrder.push(g);
      }
      return g;
    }

    /* ---------------- beginFrame ---------------- */
    R.beginFrame = function (opts) {
      var o = opts || {};
      /* Options are optional and do NOT persist: every frame starts from the
         default dusty-sand sky/haze, then applies whatever the caller passes. */
      curSkyTop = DEFAULT_SKY_TOP.slice();
      curSkyBottom = DEFAULT_SKY_BOTTOM.slice();
      curFogColor = DEFAULT_FOG.slice();
      curFogNear = 24;
      curFogFar = 122;
      if (o.skyTop !== undefined) {
        var st = toColor(o.skyTop, DEFAULT_SKY_TOP[0], DEFAULT_SKY_TOP[1], DEFAULT_SKY_TOP[2], 1);
        curSkyTop = [st[0], st[1], st[2]];
      }
      if (o.skyBottom !== undefined) {
        var sb = toColor(o.skyBottom, DEFAULT_SKY_BOTTOM[0], DEFAULT_SKY_BOTTOM[1], DEFAULT_SKY_BOTTOM[2], 1);
        curSkyBottom = [sb[0], sb[1], sb[2]];
      }
      if (o.fogColor !== undefined) {
        var fc = toColor(o.fogColor, DEFAULT_FOG[0], DEFAULT_FOG[1], DEFAULT_FOG[2], 1);
        curFogColor = [fc[0], fc[1], fc[2]];
      }
      if (isFinite(o.fogNear)) curFogNear = Math.max(0.1, +o.fogNear);
      if (isFinite(o.fogFar)) curFogFar = Math.max(curFogNear + 2, +o.fogFar);
      curSkyGround = [
        curSkyBottom[0] * 0.62 + curFogColor[0] * 0.38,
        curSkyBottom[1] * 0.62 + curFogColor[1] * 0.38,
        curSkyBottom[2] * 0.62 + curFogColor[2] * 0.38
      ];

      frameId++;
      opaqueMeshes.length = 0;
      opaqueOrder.length = 0;
      fxOrder.length = 0;
      transCmds.length = 0;
      R.stats.draws = 0;
      R.stats.tris = 0;
      R.stats.objects = 0;

      if (!cam.viewProj) updateCamera();
      if (!cam.invViewProj) cam.invViewProj = M.M4.invert(cam.viewProj);

      gl.viewport(0, 0, R.width, R.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.clearColor(curFogColor[0], curFogColor[1], curFogColor[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      /* ---- sky dome ---- */
      gl.depthMask(false);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(progSky);
      if (uSky.uInvViewProj) gl.uniformMatrix4fv(uSky.uInvViewProj, false, cam.invViewProj);
      if (uSky.uCamPos) gl.uniform3fv(uSky.uCamPos, cam.eye);
      if (uSky.uSkyTop) gl.uniform3fv(uSky.uSkyTop, curSkyTop);
      if (uSky.uSkyHorizon) gl.uniform3fv(uSky.uSkyHorizon, curSkyBottom);
      if (uSky.uSkyGround) gl.uniform3fv(uSky.uSkyGround, curSkyGround);
      if (uSky.uSunDir) gl.uniform3fv(uSky.uSunDir, SUN_DIR);
      if (uSky.uSunColor) gl.uniform3fv(uSky.uSunColor, SUN_SKY);
      gl.bindBuffer(gl.ARRAY_BUFFER, skyQuad);
      if (aSky.aPos >= 0) {
        gl.enableVertexAttribArray(aSky.aPos);
        gl.vertexAttribPointer(aSky.aPos, 2, gl.FLOAT, false, 0, 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      R.stats.draws++;
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
    };

    /* ---------------- drawMesh ---------------- */
    R.createMesh = function (vertices, indices, textureName) {
      var v = vertices instanceof Float32Array ? vertices : new Float32Array(vertices);
      var idx = indices instanceof Uint16Array ? indices : new Uint16Array(indices);
      var vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
      var ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      return {
        vbo: vbo, ibo: ibo, count: idx.length, tris: idx.length / 3,
        texEnt: resolveTex(textureName), texName: textureName || 'white'
      };
    };

    R.drawMesh = function (mesh) {
      if (!mesh || !mesh.vbo || !mesh.count) return;
      opaqueMeshes.push(mesh);
      R.stats.objects++;
    };

    /* ---------------- drawBox ---------------- */
    R.drawBox = function (texName, matrix, tint, uvScale) {
      if (!matrix) return;
      var us = (uvScale === undefined || uvScale === null) ? 1 : +uvScale;
      if (!isFinite(us) || us <= 0) us = 1;
      var col = toColor(tint, 1, 1, 1, 1);
      var cr = col[0], cg = col[1], cb = col[2];
      var texEnt = resolveTex(texName);
      var g = getOpaqueGroup(texEnt);
      R.stats.objects++;
      var buf = g.buf;
      var m = matrix;
      var o = buf.reserve(36 * 12);
      var A = buf.a;
      var src = CUBE_V;
      for (var v = 0; v < 36; v++) {
        var p = v * 8;
        var x = src[p], y = src[p + 1], z = src[p + 2];
        var nx = src[p + 3], ny = src[p + 4], nz = src[p + 5];
        A[o++] = m[0] * x + m[4] * y + m[8] * z + m[12];
        A[o++] = m[1] * x + m[5] * y + m[9] * z + m[13];
        A[o++] = m[2] * x + m[6] * y + m[10] * z + m[14];
        var tx = m[0] * nx + m[4] * ny + m[8] * nz;
        var ty = m[1] * nx + m[5] * ny + m[9] * nz;
        var tz = m[2] * nx + m[6] * ny + m[10] * nz;
        var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
        A[o++] = tx / tl; A[o++] = ty / tl; A[o++] = tz / tl;
        A[o++] = src[p + 6] * us; A[o++] = src[p + 7] * us;
        A[o++] = cr; A[o++] = cg; A[o++] = cb; A[o++] = 1;
      }
      buf.n = o;
    };

    /* ---------------- helpers to queue transparent commands ---------------- */
    function queueTracer(a, b, width, color) {
      var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-4) return;
      var col = toColor(color, 1.0, 0.86, 0.58, 1);
      var mx = (a[0] + b[0]) * 0.5, my = (a[1] + b[1]) * 0.5, mz = (a[2] + b[2]) * 0.5;
      var ey = cam.eye;
      var vx = ey[0] - mx, vy = ey[1] - my, vz = ey[2] - mz;
      var dirx = dx / len, diry = dy / len, dirz = dz / len;
      /* side = normalize(cross(dir, toCamera)) */
      var sx = diry * vz - dirz * vy;
      var sy = dirz * vx - dirx * vz;
      var sz = dirx * vy - diry * vx;
      var sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (sl < 1e-4) {
        var rr = cam.right;
        sx = rr[0]; sy = rr[1]; sz = rr[2];
      } else {
        sx /= sl; sy /= sl; sz /= sl;
      }
      transCmds.push({
        k: 1, texEnt: resolveTex('beam'),
        ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2],
        sx: sx, sy: sy, sz: sz,
        w: (width === undefined ? 0.035 : Math.max(0.002, +width)) * 0.5,
        r: col[0], g: col[1], b: col[2], a: col[3],
        cx: mx, cy: my, cz: mz, dist: 0
      });
      R.stats.objects++;
    }

    R.drawBeam = function (a, b, width, color) {
      if (!a || !b) return;
      queueTracer(a, b, width, color);
    };

    R.drawSprite = function (texName, pos, size, color, additive, rotation) {
      if (!pos) return;
      var col = toColor(color, 1, 1, 1, 1);
      transCmds.push({
        k: 0, texEnt: resolveTex(texName),
        x: pos[0], y: pos[1], z: pos[2],
        size: Math.max(0.0001, size === undefined ? 0.3 : +size),
        r: col[0], g: col[1], b: col[2], a: col[3],
        add: !!additive, rot: +rotation || 0,
        cx: pos[0], cy: pos[1], cz: pos[2], dist: 0
      });
      R.stats.objects++;
    };

    R.drawShadow = function (pos, radius, alpha) {
      if (!pos) return;
      var a = (alpha === undefined || alpha === null) ? 0.45 : clamp01(+alpha);
      transCmds.push({
        k: 2, texEnt: resolveTex('shadow'),
        x: pos[0], y: (+pos[1] || 0) + 0.012, z: pos[2],
        r: radius === undefined ? 0.5 : Math.max(0.02, +radius),
        a: a, cx: pos[0], cy: pos[1], cz: pos[2], dist: 0
      });
      R.stats.objects++;
    };

    R.drawGroundDecal = function (pos, radius, color) {
      if (!pos) return;
      var col = toColor(color, 1, 0.6, 0.15, 0.8);
      var r = radius === undefined ? 2 : Math.max(0.1, +radius);
      transCmds.push({
        k: 3, texEnt: resolveTex('white'),
        x: pos[0], y: (+pos[1] || 0) + 0.02, z: pos[2],
        r: r,
        r0: col[0], g0: col[1], b0: col[2], a: col[3],
        cx: pos[0], cy: pos[1], cz: pos[2], dist: 0
      });
      R.stats.objects++;
    };

    R.drawDecal = function (texName, pos, normal, size, color, alpha, rotation) {
      if (!pos || !normal) return;
      var col = toColor(color, 1, 1, 1, 1);
      var a = (alpha === undefined || alpha === null) ? 1 : clamp01(+alpha);
      var n = norm3(+normal[0] || 0, +normal[1] || 0, +normal[2] || 0);
      transCmds.push({
        k: 4, texEnt: resolveTex(texName),
        x: pos[0], y: pos[1], z: pos[2],
        nx: n[0], ny: n[1], nz: n[2],
        size: Math.max(0.001, size === undefined ? 0.15 : +size),
        r: col[0], g: col[1], b: col[2], a: col[3] * a,
        rot: +rotation || 0,
        cx: pos[0], cy: pos[1], cz: pos[2], dist: 0
      });
      R.stats.objects++;
    };

    /* ---------------- transparent batch generation ---------------- */
    function genSprite(c, eye) {
      var buf = getFxGroup(c.texEnt, c.add, false).buf;
      var cs = Math.cos(c.rot), sn = Math.sin(c.rot);
      var rr = cam.right, uu = cam.up;
      var rx = rr[0] * cs + uu[0] * sn;
      var ry = rr[1] * cs + uu[1] * sn;
      var rz = rr[2] * cs + uu[2] * sn;
      var ux = uu[0] * cs - rr[0] * sn;
      var uy = uu[1] * cs - rr[1] * sn;
      var uz = uu[2] * cs - rr[2] * sn;
      var h = c.size * 0.5;
      var ax = rx * h, ay = ry * h, az = rz * h;
      var bx = ux * h, by = uy * h, bz = uz * h;
      var x = c.x, y = c.y, z = c.z;
      pushQuad(buf,
        x - ax - bx, y - ay - by, z - az - bz,
        x + ax - bx, y + ay - by, z + az - bz,
        x + ax + bx, y + ay + by, z + az + bz,
        x - ax + bx, y - ay + by, z - az + bz,
        c.r, c.g, c.b, c.a);
    }
    function genBeam(c) {
      var buf = getFxGroup(c.texEnt, true, false).buf;
      var w = c.w;
      var sx = c.sx * w, sy = c.sy * w, sz = c.sz * w;
      /* outer glow */
      pushQuad(buf,
        c.ax - sx, c.ay - sy, c.az - sz,
        c.ax + sx, c.ay + sy, c.az + sz,
        c.bx + sx, c.by + sy, c.bz + sz,
        c.bx - sx, c.by - sy, c.bz - sz,
        c.r, c.g, c.b, c.a);
      /* hot core */
      var cw = w * 0.34;
      var cx2 = c.sx * cw, cy2 = c.sy * cw, cz2 = c.sz * cw;
      var kr = Math.min(1, c.r * 0.4 + 0.55);
      var kg = Math.min(1, c.g * 0.4 + 0.55);
      var kb = Math.min(1, c.b * 0.4 + 0.55);
      pushQuad(buf,
        c.ax - cx2, c.ay - cy2, c.az - cz2,
        c.ax + cx2, c.ay + cy2, c.az + cz2,
        c.bx + cx2, c.by + cy2, c.bz + cz2,
        c.bx - cx2, c.by - cy2, c.bz - cz2,
        kr, kg, kb, Math.min(1, c.a * 0.95));
    }
    function genShadow(c) {
      var buf = getFxGroup(c.texEnt, false, true).buf;
      var r = c.r, x = c.x, y = c.y, z = c.z;
      pushQuad(buf,
        x - r, y, z - r,
        x + r, y, z - r,
        x + r, y, z + r,
        x - r, y, z + r,
        0, 0, 0, c.a);
    }
    function genRing(c) {
      var buf = getFxGroup(c.texEnt, false, true).buf;
      var seg = 40, i;
      var x = c.x, y = c.y, z = c.z, r = c.r;
      var inner = r * 0.88;
      var A = buf.a;
      var o = buf.reserve(seg * 6 * 9);
      for (i = 0; i < seg; i++) {
        var a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
        var c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        var ix0 = x + c0 * inner, iz0 = z + s0 * inner;
        var ox0 = x + c0 * r, oz0 = z + s0 * r;
        var ix1 = x + c1 * inner, iz1 = z + s1 * inner;
        var ox1 = x + c1 * r, oz1 = z + s1 * r;
        o = pushVert(A, o, ix0, y, iz0, 0, 0, c.r0, c.g0, c.b0, c.a);
        o = pushVert(A, o, ox0, y, oz0, 0, 0, c.r0, c.g0, c.b0, c.a);
        o = pushVert(A, o, ox1, y, oz1, 0, 0, c.r0, c.g0, c.b0, c.a);
        o = pushVert(A, o, ix0, y, iz0, 0, 0, c.r0, c.g0, c.b0, c.a);
        o = pushVert(A, o, ox1, y, oz1, 0, 0, c.r0, c.g0, c.b0, c.a);
        o = pushVert(A, o, ix1, y, iz1, 0, 0, c.r0, c.g0, c.b0, c.a);
      }
      buf.n = o;
      /* faint inner disc */
      var o2 = buf.reserve(seg * 3 * 9);
      var dc = c.a * 0.14;
      for (i = 0; i < seg; i++) {
        var aa = (i / seg) * TAU, ab = ((i + 1) / seg) * TAU;
        o2 = pushVert(A, o2, x, y, z, 0, 0, c.r0, c.g0, c.b0, dc);
        o2 = pushVert(A, o2, x + Math.cos(aa) * inner, y, z + Math.sin(aa) * inner, 0, 0, c.r0, c.g0, c.b0, dc);
        o2 = pushVert(A, o2, x + Math.cos(ab) * inner, y, z + Math.sin(ab) * inner, 0, 0, c.r0, c.g0, c.b0, dc);
      }
      buf.n = o2;
    }
    function genDecal(c) {
      var buf = getFxGroup(c.texEnt, false, true).buf;
      var n = [c.nx, c.ny, c.nz];
      var t;
      if (Math.abs(n[1]) < 0.95) {
        /* cross((0,1,0), n) */
        t = [1 * n[2] - 0 * n[1], 0 * n[0] - 0 * n[2], 0 * n[1] - 1 * n[0]];
      } else {
        /* cross((0,0,1), n) */
        t = [0 * n[2] - 1 * n[1], 1 * n[0] - 0 * n[2], 0 * n[1] - 0 * n[0]];
      }
      t = norm3(t[0], t[1], t[2]);
      var bt = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
      var cs = Math.cos(c.rot), sn = Math.sin(c.rot);
      var tx = t[0] * cs + bt[0] * sn, ty = t[1] * cs + bt[1] * sn, tz = t[2] * cs + bt[2] * sn;
      var bx = bt[0] * cs - t[0] * sn, by = bt[1] * cs - t[1] * sn, bz = bt[2] * cs - t[2] * sn;
      var h = c.size * 0.5;
      var ax = tx * h, ay = ty * h, az = tz * h;
      var cx2 = bx * h, cy2 = by * h, cz2 = bz * h;
      var px = c.x + n[0] * 0.006, py = c.y + n[1] * 0.006, pz = c.z + n[2] * 0.006;
      pushQuad(buf,
        px - ax - cx2, py - ay - cy2, pz - az - cz2,
        px + ax - cx2, py + ay - cy2, pz + az - cz2,
        px + ax + cx2, py + ay + cy2, pz + az + cz2,
        px - ax + cx2, py - ay + cy2, pz - az + cz2,
        c.r, c.g, c.b, c.a);
    }

    R.endFrame = function () {
      /* ---------------- opaque ---------------- */
      if (opaqueMeshes.length || opaqueOrder.length) {
        gl.useProgram(progMain);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.disable(gl.CULL_FACE);
        if (uMain.uViewProj) gl.uniformMatrix4fv(uMain.uViewProj, false, cam.viewProj);
        if (uMain.uModel) gl.uniformMatrix4fv(uMain.uModel, false, IDENT);
        if (uMain.uTex) gl.uniform1i(uMain.uTex, 0);
        if (uMain.uSunDir) gl.uniform3fv(uMain.uSunDir, SUN_DIR);
        if (uMain.uSunColor) gl.uniform3fv(uMain.uSunColor, SUN_COLOR);
        if (uMain.uAmbSky) gl.uniform3fv(uMain.uAmbSky, AMB_SKY);
        if (uMain.uAmbGround) gl.uniform3fv(uMain.uAmbGround, AMB_GROUND);
        if (uMain.uFogColor) gl.uniform3fv(uMain.uFogColor, curFogColor);
        if (uMain.uFogNear) gl.uniform1f(uMain.uFogNear, curFogNear);
        if (uMain.uFogFar) gl.uniform1f(uMain.uFogFar, curFogFar);
        if (uMain.uCamPos) gl.uniform3fv(uMain.uCamPos, cam.eye);
        gl.activeTexture(gl.TEXTURE0);

        var i, m;
        /* static meshes (generic color = white) */
        if (opaqueMeshes.length) {
          if (aMain.aPos >= 0) gl.enableVertexAttribArray(aMain.aPos);
          if (aMain.aNormal >= 0) gl.enableVertexAttribArray(aMain.aNormal);
          if (aMain.aUV >= 0) gl.enableVertexAttribArray(aMain.aUV);
          if (aMain.aColor >= 0) {
            gl.disableVertexAttribArray(aMain.aColor);
            gl.vertexAttrib4f(aMain.aColor, 1, 1, 1, 1);
          }
          for (i = 0; i < opaqueMeshes.length; i++) {
            m = opaqueMeshes[i];
            gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
            if (aMain.aPos >= 0) gl.vertexAttribPointer(aMain.aPos, 3, gl.FLOAT, false, 32, 0);
            if (aMain.aNormal >= 0) gl.vertexAttribPointer(aMain.aNormal, 3, gl.FLOAT, false, 32, 12);
            if (aMain.aUV >= 0) gl.vertexAttribPointer(aMain.aUV, 2, gl.FLOAT, false, 32, 24);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
            gl.bindTexture(gl.TEXTURE_2D, m.texEnt.tex);
            gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
            R.stats.draws++;
            R.stats.tris += m.count / 3;
          }
        }
        /* dynamic boxes batched by texture */
        if (opaqueOrder.length) {
          if (aMain.aPos >= 0) gl.enableVertexAttribArray(aMain.aPos);
          if (aMain.aNormal >= 0) gl.enableVertexAttribArray(aMain.aNormal);
          if (aMain.aUV >= 0) gl.enableVertexAttribArray(aMain.aUV);
          if (aMain.aColor >= 0) {
            gl.enableVertexAttribArray(aMain.aColor);
          }
          for (i = 0; i < opaqueOrder.length; i++) {
            var g = opaqueOrder[i];
            if (!g.buf.n) continue;
            gl.bindBuffer(gl.ARRAY_BUFFER, meshDynBuf);
            gl.bufferData(gl.ARRAY_BUFFER, g.buf.a.subarray(0, g.buf.n), gl.DYNAMIC_DRAW);
            if (aMain.aPos >= 0) gl.vertexAttribPointer(aMain.aPos, 3, gl.FLOAT, false, 48, 0);
            if (aMain.aNormal >= 0) gl.vertexAttribPointer(aMain.aNormal, 3, gl.FLOAT, false, 48, 12);
            if (aMain.aUV >= 0) gl.vertexAttribPointer(aMain.aUV, 2, gl.FLOAT, false, 48, 24);
            if (aMain.aColor >= 0) gl.vertexAttribPointer(aMain.aColor, 4, gl.FLOAT, false, 48, 32);
            gl.bindTexture(gl.TEXTURE_2D, g.texEnt.tex);
            gl.drawArrays(gl.TRIANGLES, 0, g.buf.n / 12);
            R.stats.draws++;
            R.stats.tris += g.buf.n / 36;
          }
          if (aMain.aColor >= 0) gl.disableVertexAttribArray(aMain.aColor);
        }
      }

      /* ---------------- transparent ---------------- */
      if (transCmds.length) {
        var n = transCmds.length, j;
        var eye = cam.eye;
        for (j = 0; j < n; j++) {
          var cc = transCmds[j];
          var dx = cc.cx - eye[0], dy = cc.cy - eye[1], dz = cc.cz - eye[2];
          cc.dist = dx * dx + dy * dy + dz * dz;
        }
        if (n > 1) transCmds.sort(function (a, b) { return b.dist - a.dist; });

        for (j = 0; j < n; j++) {
          var c = transCmds[j];
          switch (c.k) {
            case 0: genSprite(c); break;
            case 1: genBeam(c); break;
            case 2: genShadow(c); break;
            case 3: genRing(c); break;
            case 4: genDecal(c); break;
          }
        }

        gl.useProgram(progFx);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        if (uFx.uViewProj) gl.uniformMatrix4fv(uFx.uViewProj, false, cam.viewProj);
        if (uFx.uTex) gl.uniform1i(uFx.uTex, 0);
        if (uFx.uCamPos) gl.uniform3fv(uFx.uCamPos, cam.eye);
        if (uFx.uFogNear) gl.uniform1f(uFx.uFogNear, curFogNear);
        if (uFx.uFogFar) gl.uniform1f(uFx.uFogFar, curFogFar);
        if (aFx.aPos >= 0) gl.enableVertexAttribArray(aFx.aPos);
        if (aFx.aUV >= 0) gl.enableVertexAttribArray(aFx.aUV);
        if (aFx.aColor >= 0) gl.enableVertexAttribArray(aFx.aColor);
        gl.activeTexture(gl.TEXTURE0);

        for (j = 0; j < fxOrder.length; j++) {
          var fg = fxOrder[j];
          if (!fg.buf.n) continue;
          if (fg.add) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
          } else {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          }
          if (fg.ground) {
            gl.enable(gl.POLYGON_OFFSET_FILL);
            gl.polygonOffset(-1.5, -2.0);
          } else {
            gl.disable(gl.POLYGON_OFFSET_FILL);
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, fxDynBuf);
          gl.bufferData(gl.ARRAY_BUFFER, fg.buf.a.subarray(0, fg.buf.n), gl.DYNAMIC_DRAW);
          if (aFx.aPos >= 0) gl.vertexAttribPointer(aFx.aPos, 3, gl.FLOAT, false, 36, 0);
          if (aFx.aUV >= 0) gl.vertexAttribPointer(aFx.aUV, 2, gl.FLOAT, false, 36, 12);
          if (aFx.aColor >= 0) gl.vertexAttribPointer(aFx.aColor, 4, gl.FLOAT, false, 36, 20);
          gl.bindTexture(gl.TEXTURE_2D, fg.texEnt.tex);
          gl.drawArrays(gl.TRIANGLES, 0, fg.buf.n / 9);
          R.stats.draws++;
          R.stats.tris += fg.buf.n / 27;
        }
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(0, 0);
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
    };

    /* initial sizing + camera */
    updateCamera();
    R.resize();
    return R;
  }

  /* ======================================================================
   * 5. inert renderer (no WebGL context available)
   * ==================================================================== */
  function makeNullRenderer(canvas, err) {
    var R = {
      gl: null,
      canvas: canvas,
      isNull: true,
      width: 1,
      height: 1,
      dpr: 1,
      stats: { draws: 0, tris: 0, objects: 0 },
      texNames: TEX_PUBLIC.slice(),
      error: err ? String(err && err.message ? err.message : err) : 'no webgl context',
      camera: {
        eye: [0, 1.62, 0], yaw: 0, pitch: 0, fov: 1.0, fovDeg: 90, aspect: 1,
        near: 0.05, far: 320,
        view: IDENT, proj: IDENT, viewProj: IDENT, invView: IDENT, invViewProj: IDENT,
        forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0]
      }
    };
    R.resize = function () { };
    R.setCamera = function (eye, yaw, pitch, fovDeg) {
      var c = R.camera;
      if (eye) { c.eye = [+eye[0] || 0, +eye[1] || 0, +eye[2] || 0]; }
      if (isFinite(yaw)) c.yaw = +yaw;
      if (isFinite(pitch)) c.pitch = +pitch;
      if (isFinite(fovDeg) && fovDeg > 1) c.fovDeg = +fovDeg;
      if (M.cameraForward) c.forward = M.cameraForward(c.yaw, c.pitch);
      if (M.cameraRight) c.right = M.cameraRight(c.yaw);
      if (M.cameraUp) c.up = M.cameraUp(c.yaw, c.pitch);
      if (M.M4) {
        c.view = M.M4.cameraView(c.eye, c.yaw, c.pitch);
        c.proj = M.M4.perspective(1.0, c.aspect, c.near, c.far);
        c.viewProj = M.M4.multiply(c.proj, c.view);
      }
    };
    R.beginFrame = function () { R.stats.draws = 0; R.stats.tris = 0; R.stats.objects = 0; };
    R.endFrame = function () { };
    R.createMesh = function (vertices, indices, texName) {
      return { vbo: null, ibo: null, count: 0, tris: 0, texEnt: null, texName: texName || 'white' };
    };
    R.drawMesh = function () { };
    R.drawBox = function () { };
    R.drawBeam = function () { };
    R.drawSprite = function () { };
    R.drawShadow = function () { };
    R.drawGroundDecal = function () { };
    R.drawDecal = function () { };
    return R;
  }

  function createRenderer(canvas) {
    if (!canvas) return makeNullRenderer(canvas, new Error('no canvas'));
    try {
      var r = createGLRenderer(canvas);
      if (r) return r;
      return makeNullRenderer(canvas, new Error('WebGL context unavailable'));
    } catch (e) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[CS.gl] renderer init failed:', e);
      }
      return makeNullRenderer(canvas, e);
    }
  }

  /* ======================================================================
   * 6. module API
   * ==================================================================== */
  var active = null;

  CS.gl = {
    init: function (canvas) {
      active = createRenderer(canvas);
      return active;
    },
    createMesh: function (vertices, indices, textureName) {
      if (!active) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[CS.gl] createMesh called before init');
        }
        return { vbo: null, ibo: null, count: 0, tris: 0, texEnt: null, texName: textureName || 'white' };
      }
      return active.createMesh(vertices, indices, textureName);
    },
    get renderer() { return active; },
    texNames: TEX_PUBLIC.slice(),
    /** True if a real WebGL context is active. */
    isReady: function () { return !!(active && !active.isNull); }
  };
})();
