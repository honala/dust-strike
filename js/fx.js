/* =========================================================================
 * DUST STRIKE — particle / decal effects (CS.fx)
 *
 * Implements CONTRACT.md §6: tracer, impact, muzzle, blood, shell,
 * update / render / clear. Rendered exclusively through the CS.gl renderer
 * (drawSprite / drawBeam / drawBox / drawDecal), so it stays a pure classic
 * script with zero assets.
 *
 * - Particle hard cap = 300 (oldest recycled first).
 * - Bullet holes: max 80, 8s lifetime, fade out at the end.
 * - No renderer / no WebGL: everything silently no-ops (never throws).
 *
 * CONTRACT-GAP: bullet holes are surface aligned. CS.gl.drawSprite is a
 * camera billboard, so we use the optional extra renderer.drawDecal() when
 * present and fall back to a thin dark box otherwise.
 * ========================================================================= */
(function () {
  'use strict';

  var CS = window.CS = window.CS || {};
  var M = CS.math;
  var TAU = Math.PI * 2;

  var MAX_PARTICLES = 300;
  var MAX_DECALS = 80;
  var MAX_TRACERS = 32;

  var renderer = null;
  var particles = [];
  var decals = [];
  var tracers = [];

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function norm3(v) {
    var l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (l < 1e-6) return [0, 0, 1];
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function basis(n) {
    var up = Math.abs(n[1]) < 0.95 ? [0, 1, 0] : [0, 0, 1];
    var t = norm3(cross(up, n));
    var b = cross(n, t);
    return [t, b];
  }

  function addParticle(p) {
    if (particles.length >= MAX_PARTICLES) particles.shift();
    particles.push(p);
  }

  /* Add an unlit billboard particle. */
  function addSprite(tex, x, y, z, vx, vy, vz, life, size0, size1, r, g, b, a0, add, grav, drag, rot, fadePow) {
    addParticle({
      kind: 'sprite', tex: tex,
      x: x, y: y, z: z, vx: vx, vy: vy, vz: vz,
      life: life, maxLife: life,
      size0: size0, size1: size1,
      r: r, g: g, b: b, a0: a0,
      add: !!add, grav: grav || 0, drag: drag || 0,
      rot: rot || 0, fade: fadePow === undefined ? 1.05 : fadePow
    });
  }

  function addDecal(point, n) {
    if (decals.length >= MAX_DECALS) decals.shift();
    decals.push({
      x: point[0], y: point[1], z: point[2],
      nx: n[0], ny: n[1], nz: n[2],
      size: rnd(0.13, 0.19),
      life: 8, maxLife: 8,
      rot: rnd(0, TAU)
    });
  }

  /* ======================================================================
   * public API
   * ==================================================================== */
  var fx = CS.fx = CS.fx || {};

  fx.init = function (r) {
    /* main.js may pass the renderer directly or the whole game object. */
    if (r && r.drawSprite) renderer = r;
    else if (r && r.renderer && r.renderer.drawSprite) renderer = r.renderer;
    else if (!r) renderer = null;
    return fx;
  };

  /** Tracer: short bright line fading over 0.08s. */
  fx.tracer = function (from, to, color) {
    if (!from || !to) return;
    var dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    if (dx * dx + dy * dy + dz * dz < 1e-6) return;
    var c = color || [1.0, 0.86, 0.58];
    var cr = c[0], cg = c[1], cb = c[2];
    if (cr > 1.001 || cg > 1.001 || cb > 1.001) { cr /= 255; cg /= 255; cb /= 255; }
    if (tracers.length >= MAX_TRACERS) tracers.shift();
    tracers.push({
      ax: from[0], ay: from[1], az: from[2],
      bx: to[0], by: to[1], bz: to[2],
      life: 0.08, maxLife: 0.08,
      r: cr, g: cg, b: cb,
      w: rnd(0.026, 0.04)
    });
  };

  /** Bullet impact: sparks + dust + a bullet hole decal. */
  fx.impact = function (point, normal, material) {
    if (!point) return;
    var n = normal ? norm3([normal[0] || 0, normal[1] || 0, normal[2] || 0]) : [0, 0, 1];
    var mat = typeof material === 'string' ? material.toLowerCase() : '';
    var isMetal = mat.indexOf('metal') >= 0;
    var isWood = mat.indexOf('wood') >= 0 || mat.indexOf('crate') >= 0;
    var isSand = mat.indexOf('sand') >= 0 || mat.indexOf('floor') >= 0;
    var base = basis(n);
    var t = base[0], b = base[1];
    var px = point[0] + n[0] * 0.02, py = point[1] + n[1] * 0.02, pz = point[2] + n[2] * 0.02;
    var i, ang, sp, dx, dy, dz;

    var sparkCount = isMetal ? 9 : (isWood ? 4 : 6);
    for (i = 0; i < sparkCount; i++) {
      ang = rnd(0, TAU);
      sp = rnd(2.2, isMetal ? 7.5 : 5.2);
      var ca = Math.cos(ang), sa = Math.sin(ang);
      dx = n[0] * rnd(0.6, 1.9) + (t[0] * ca + b[0] * sa) * rnd(0.4, 1.5);
      dy = n[1] * rnd(0.6, 1.9) + (t[1] * ca + b[1] * sa) * rnd(0.4, 1.5) + 0.35;
      dz = n[2] * rnd(0.6, 1.9) + (t[2] * ca + b[2] * sa) * rnd(0.4, 1.5);
      var dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      var hot = isMetal ? [1.0, 0.86, 0.48] : [1.0, 0.74, 0.34];
      addSprite('spark', px, py, pz,
        dx / dl * sp, dy / dl * sp, dz / dl * sp,
        rnd(0.1, isMetal ? 0.32 : 0.24),
        rnd(0.035, 0.075), rnd(0.012, 0.03),
        hot[0], hot[1], hot[2], 0.95, true, 7.5, 1.6, rnd(0, TAU), 0.85);
    }

    /* dust / debris cloud */
    var dustR = 0.80, dustG = 0.72, dustB = 0.56;
    if (isWood) { dustR = 0.70; dustG = 0.55; dustB = 0.34; }
    else if (isMetal) { dustR = 0.66; dustG = 0.65; dustB = 0.62; }
    else if (isSand) { dustR = 0.84; dustG = 0.76; dustB = 0.60; }
    var dustCount = isMetal ? 3 : 5;
    for (i = 0; i < dustCount; i++) {
      ang = rnd(0, TAU);
      var u = rnd(0.3, 1.2);
      var vx = t[0] * Math.cos(ang) * u + b[0] * Math.sin(ang) * u + n[0] * rnd(0.2, 0.9);
      var vy = t[1] * Math.cos(ang) * u + b[1] * Math.sin(ang) * u + n[1] * rnd(0.2, 0.9) + 0.35;
      var vz = t[2] * Math.cos(ang) * u + b[2] * Math.sin(ang) * u + n[2] * rnd(0.2, 0.9);
      addSprite('smoke', px, py, pz, vx, vy, vz,
        rnd(0.32, 0.62),
        rnd(0.08, 0.16), rnd(0.35, 0.62),
        dustR, dustG, dustB, 0.42, false, -0.25, 2.4, rnd(0, TAU), 1.25);
    }
    /* one brighter flash puff for metal */
    if (isMetal) {
      addSprite('spark', px, py, pz, n[0] * 0.6, n[1] * 0.6 + 0.4, n[2] * 0.6,
        0.07, 0.22, 0.12, 1.0, 0.92, 0.6, 0.8, true, 2, 2, 0, 0.6);
    }
    addDecal(point, n);
  };

  /** Muzzle flash: short additive flash + a little smoke. */
  fx.muzzle = function (pos, dir, scale) {
    if (!pos) return;
    var s = (scale === undefined || !isFinite(scale) || scale <= 0) ? 1 : +scale;
    var d = dir ? norm3([dir[0] || 0, dir[1] || 0, dir[2] || 0]) : [0, 0, -1];
    var fx0 = pos[0] + d[0] * 0.1, fy0 = pos[1] + d[1] * 0.1, fz0 = pos[2] + d[2] * 0.1;
    /* flash is very short (contract: 0.05s) */
    addSprite('muzzle', fx0, fy0, fz0, d[0] * 0.8, d[1] * 0.8, d[2] * 0.8,
      0.05, rnd(0.38, 0.52) * s, rnd(0.2, 0.3) * s,
      1.0, 0.93, 0.72, 1.0, true, 0, 0, rnd(0, TAU), 0.45);
    addSprite('muzzle', fx0, fy0, fz0, 0, 0, 0,
      0.035, rnd(0.24, 0.34) * s, 0.14 * s,
      1.0, 0.98, 0.86, 0.9, true, 0, 0, rnd(0, TAU), 0.3);
    /* little smoke puff drifting forward */
    addSprite('smoke', fx0 + d[0] * 0.08, fy0 + d[1] * 0.08, fz0 + d[2] * 0.08,
      d[0] * rnd(0.5, 1.2), d[1] * rnd(0.5, 1.2) + 0.25, d[2] * rnd(0.5, 1.2),
      rnd(0.18, 0.3),
      rnd(0.1, 0.16) * s, rnd(0.32, 0.46) * s,
      0.82, 0.78, 0.70, 0.24, false, -0.4, 2.8, rnd(0, TAU), 1.2);
    /* couple of sparks */
    for (var i = 0; i < 2; i++) {
      addSprite('spark', fx0, fy0, fz0,
        d[0] * rnd(1, 2.4) + rnd(-0.5, 0.5), d[1] * rnd(1, 2.4) + rnd(0, 0.8), d[2] * rnd(1, 2.4) + rnd(-0.5, 0.5),
        rnd(0.07, 0.14), rnd(0.03, 0.05), 0.01,
        1.0, 0.8, 0.42, 0.9, true, 5, 1.2, 0, 0.9);
    }
  };

  /** Blood spray. dir = bullet travel direction (spray goes backwards). */
  fx.blood = function (point, dir) {
    if (!point) return;
    var d = dir ? norm3([dir[0] || 0, dir[1] || 0, dir[2] || 0]) : [0, 1, 0];
    for (var i = 0; i < 11; i++) {
      var back = rnd(0.6, 3.0);
      addSprite('blood', point[0], point[1], point[2],
        -d[0] * back + rnd(-1.4, 1.4),
        -d[1] * back + rnd(-0.4, 1.8) + 0.6,
        -d[2] * back + rnd(-1.4, 1.4),
        rnd(0.28, 0.5),
        rnd(0.06, 0.15), rnd(0.03, 0.09),
        rnd(0.66, 0.9), rnd(0.06, 0.14), rnd(0.06, 0.12),
        0.9, false, 9.5, 0.7, rnd(0, TAU), 0.85);
    }
    /* one dark mist puff */
    addSprite('smoke', point[0], point[1], point[2],
      -d[0] * 0.5, -d[1] * 0.5 + 0.5, -d[2] * 0.5,
      0.4, 0.14, 0.4,
      0.4, 0.08, 0.07, 0.3, false, -0.2, 2.2, rnd(0, TAU), 1.4);
  };

  /** Shell casing: tiny brass box with gravity + floor bounce. */
  fx.shell = function (pos, dir) {
    if (!pos) return;
    var d = dir ? norm3([dir[0] || 0, dir[1] || 0, dir[2] || 0]) : [1, 0.4, 0];
    addParticle({
      kind: 'shell',
      x: pos[0], y: pos[1], z: pos[2],
      vx: d[0] * rnd(1.6, 3.0) + rnd(-0.4, 0.4),
      vy: Math.abs(d[1]) * rnd(0.6, 1.6) + rnd(2.0, 3.2),
      vz: d[2] * rnd(1.6, 3.0) + rnd(-0.4, 0.4),
      life: 0.8, maxLife: 0.8,
      sx: rnd(0.016, 0.022), sy: rnd(0.016, 0.022), sz: rnd(0.036, 0.048),
      rotX: rnd(0, TAU), rotY: rnd(0, TAU), rotZ: rnd(0, TAU),
      spinX: rnd(-16, 16), spinY: rnd(-16, 16), spinZ: rnd(-10, 10),
      r: 0.78, g: 0.63, b: 0.28
    });
  };

  fx.update = function (dt) {
    if (!isFinite(dt) || dt <= 0) return;
    if (dt > 0.1) dt = 0.1;
    var i, p;
    for (i = particles.length - 1; i >= 0; i--) {
      p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      if (p.kind === 'shell') {
        p.vy -= 16 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.y < 0.02) {
          p.y = 0.02;
          p.vy = -p.vy * 0.32;
          p.vx *= 0.62; p.vz *= 0.62;
          p.spinX *= 0.55; p.spinY *= 0.55; p.spinZ *= 0.55;
        }
        p.rotX += p.spinX * dt; p.rotY += p.spinY * dt; p.rotZ += p.spinZ * dt;
      } else {
        p.vy -= p.grav * dt;
        var dr = 1 - p.drag * dt;
        if (dr < 0) dr = 0;
        p.vx *= dr; p.vy *= dr; p.vz *= dr;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.y < 0.02 && p.vy < 0) { p.y = 0.02; p.vy = 0; p.vx *= 0.7; p.vz *= 0.7; }
      }
    }
    for (i = decals.length - 1; i >= 0; i--) {
      decals[i].life -= dt;
      if (decals[i].life <= 0) decals.splice(i, 1);
    }
    for (i = tracers.length - 1; i >= 0; i--) {
      tracers[i].life -= dt;
      if (tracers[i].life <= 0) tracers.splice(i, 1);
    }
  };

  fx.render = function (r) {
    var R = r || renderer;
    if (!R || typeof R.drawSprite !== 'function') return;
    renderer = R;
    var i, p, t, size, alpha;

    /* bullet holes (surface aligned) */
    for (i = 0; i < decals.length; i++) {
      var d = decals[i];
      alpha = clamp01(d.life / 1.2) * 0.92;
      if (typeof R.drawDecal === 'function') {
        R.drawDecal('decalhole', [d.x, d.y, d.z], [d.nx, d.ny, d.nz], d.size, [1, 1, 1], alpha, d.rot);
      } else {
        R.drawBox('white', decalMatrix(d, R), [0.09, 0.07, 0.05, 1], 1);
      }
    }

    /* tracers -> additive beams */
    for (i = 0; i < tracers.length; i++) {
      t = tracers[i];
      var ta = Math.pow(clamp01(t.life / t.maxLife), 0.55);
      R.drawBeam([t.ax, t.ay, t.az], [t.bx, t.by, t.bz], t.w, [t.r, t.g, t.b, ta]);
    }

    /* particles */
    for (i = 0; i < particles.length; i++) {
      p = particles[i];
      t = 1 - clamp01(p.life / p.maxLife);
      if (p.kind === 'shell') {
        alpha = clamp01(p.life / 0.18);
        if (M && M.M4) {
          var m = M.M4.multiply(M.M4.translation(p.x, p.y, p.z), M.M4.multiply(M.M4.rotationY(p.rotY),
            M.M4.multiply(M.M4.rotationX(p.rotX), M.M4.rotationZ(p.rotZ))));
          m = M.M4.multiply(m, M.M4.scaling(p.sx, p.sy, p.sz));
          R.drawBox('white', m, [p.r, p.g, p.b, 1], 1);
        } else {
          R.drawBox('white', matrixOf(p), [p.r, p.g, p.b], 1);
        }
        continue;
      }
      size = p.size0 + (p.size1 - p.size0) * t;
      alpha = clamp01(p.a0 * Math.pow(1 - t, p.fade));
      if (alpha < 0.004) continue;
      R.drawSprite(p.tex, [p.x, p.y, p.z], size, [p.r, p.g, p.b, alpha], p.add, p.rot);
    }
  };

  /* Build a world matrix for the fallback decal (flat box on the surface). */
  function decalMatrix(d, R) {
    var n = norm3([d.nx, d.ny, d.nz]);
    var up = Math.abs(n[1]) < 0.95 ? [0, 1, 0] : [0, 0, 1];
    var t = norm3(cross(up, n));
    var b = cross(n, t);
    var cs = Math.cos(d.rot), sn = Math.sin(d.rot);
    var tx = t[0] * cs + b[0] * sn, ty = t[1] * cs + b[1] * sn, tz = t[2] * cs + b[2] * sn;
    var bx = b[0] * cs - t[0] * sn, by = b[1] * cs - t[1] * sn, bz = b[2] * cs - t[2] * sn;
    var s = d.size;
    var m = new Float32Array(16);
    m[0] = tx * s; m[1] = ty * s; m[2] = tz * s; m[3] = 0;
    m[4] = bx * s; m[5] = by * s; m[6] = bz * s; m[7] = 0;
    m[8] = n[0] * 0.01; m[9] = n[1] * 0.01; m[10] = n[2] * 0.01; m[11] = 0;
    m[12] = d.x + n[0] * 0.006; m[13] = d.y + n[1] * 0.006; m[14] = d.z + n[2] * 0.006; m[15] = 1;
    return m;
  }
  function matrixOf(p) {
    var m = new Float32Array(16);
    m[0] = p.sx; m[5] = p.sy; m[10] = p.sz;
    m[12] = p.x; m[13] = p.y; m[14] = p.z; m[15] = 1;
    return m;
  }

  fx.clear = function () {
    particles.length = 0;
    decals.length = 0;
    tracers.length = 0;
  };

  /* debug helpers (not required by the contract) */
  fx.count = function () { return particles.length; };
  fx.setRenderer = function (r) { renderer = r || null; };
})();
