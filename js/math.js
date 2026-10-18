/* =========================================================================
 * DUST STRIKE — shared math library
 * Vec3: plain arrays [x,y,z]. Mat4: column-major Float32Array(16) (WebGL).
 * Angle convention: yaw 0 faces -Z, +yaw turns right (+X), +pitch looks up.
 * ========================================================================= */
(function () {
  'use strict';
  var CS = window.CS = window.CS || {};
  var M = CS.math = CS.math || {};
  var PI = Math.PI, TAU = PI * 2;

  M.PI = PI;
  M.TAU = TAU;
  M.clamp = function (x, a, b) { return x < a ? a : (x > b ? b : x); };
  M.lerp = function (a, b, t) { return a + (b - a) * t; };
  M.deg = function (r) { return r * 180 / PI; };
  M.rad = function (d) { return d * PI / 180; };
  M.rand = function (a, b) { return a + Math.random() * (b - a); };
  M.randInt = function (a, b) { return Math.floor(a + Math.random() * (b - a)); };
  M.choice = function (arr) { return arr[(Math.random() * arr.length) | 0]; };
  M.sign = function (x) { return x < 0 ? -1 : (x > 0 ? 1 : 0); };
  M.smoothstep = function (t) { t = M.clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  M.dist = function (a, b) {
    var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  M.dist2D = function (ax, az, bx, bz) {
    var dx = ax - bx, dz = az - bz;
    return Math.sqrt(dx * dx + dz * dz);
  };

  /* wrap angle into (-PI, PI] */
  M.normalizeAngle = function (a) {
    a = (a + PI) % TAU;
    if (a < 0) a += TAU;
    return a - PI;
  };
  /* shortest delta from a to b */
  M.angleDiff = function (a, b) { return M.normalizeAngle(b - a); };
  /* move angle a toward b by at most maxStep radians */
  M.moveAngle = function (a, b, maxStep) {
    var d = M.normalizeAngle(b - a);
    if (Math.abs(d) <= maxStep) return M.normalizeAngle(b);
    return M.normalizeAngle(a + M.sign(d) * maxStep);
  };
  /* exponential-ish approach for scalars */
  M.approach = function (cur, tgt, rate, dt) {
    var d = tgt - cur;
    var step = Math.max(Math.abs(d) * rate, 0.0001) * dt;
    if (Math.abs(d) <= step) return tgt;
    return cur + M.sign(d) * step;
  };

  /* ------------------------------- Vec3 -------------------------------- */
  var V3 = M.V3 = {};
  V3.of = function (x, y, z) { return [x || 0, y || 0, z || 0]; };
  V3.clone = function (a) { return [a[0], a[1], a[2]]; };
  V3.add = function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; };
  V3.sub = function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; };
  V3.mul = function (a, b) { return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]; };
  V3.scale = function (a, s) { return [a[0] * s, a[1] * s, a[2] * s]; };
  V3.dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
  V3.cross = function (a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  };
  V3.len = function (a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); };
  V3.norm = function (a) {
    var l = V3.len(a);
    if (l < 1e-9) return [0, 0, 0];
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  V3.lerp = function (a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  };
  V3.dist = M.dist;
  V3.transformMat4 = function (v, m) {
    var x = v[0], y = v[1], z = v[2], w = v.length > 3 ? v[3] : 1;
    var rx = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    var ry = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    var rz = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    var rw = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
    if (Math.abs(rw - 1) > 1e-9 && Math.abs(rw) > 1e-9) { rx /= rw; ry /= rw; rz /= rw; }
    return [rx, ry, rz];
  };

  /* ------------------------------ Mat4 --------------------------------- */
  var M4 = M.M4 = {};
  M4.identity = function () {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  };
  M4.clone = function (m) { return new Float32Array(m); };
  /* out = a * b (column major, so mathematically out = A*B) */
  M4.multiply = function (a, b, out) {
    out = out || new Float32Array(16);
    var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    var a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    var b0, b1, b2, b3;
    b0 = b[0]; b1 = b[1]; b2 = b[2]; b3 = b[3];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    return out;
  };
  M4.translation = function (x, y, z) {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  };
  M4.scaling = function (x, y, z) {
    if (y === undefined) { y = x; z = x; }
    return new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
  };
  /* right-handed rotation about X: y' = c y - s z, z' = s y + c z */
  M4.rotationX = function (r) {
    var c = Math.cos(r), s = Math.sin(r);
    return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
  };
  /* right-handed rotation about Y: x' = c x + s z, z' = -s x + c z */
  M4.rotationY = function (r) {
    var c = Math.cos(r), s = Math.sin(r);
    return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
  };
  M4.rotationZ = function (r) {
    var c = Math.cos(r), s = Math.sin(r);
    return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  };
  M4.perspective = function (fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    var nf = 1 / (near - far);
    var out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
  };
  M4.lookAt = function (eye, target, up) {
    up = up || [0, 1, 0];
    var zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    var zl = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    var xx = up[1] * zz - up[2] * zy;
    var xy = up[2] * zx - up[0] * zz;
    var xz = up[0] * zy - up[1] * zx;
    var xl = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy;
    var yy = zz * xx - zx * xz;
    var yz = zx * xy - zy * xx;
    return new Float32Array([
      xx, xy, xz, 0,
      yx, yy, yz, 0,
      zx, zy, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
      1
    ]);
  };
  M4.invert = function (m, out) {
    out = out || new Float32Array(16);
    var a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    var a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    var a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    var a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    var b00 = a00 * a11 - a01 * a10;
    var b01 = a00 * a12 - a02 * a10;
    var b02 = a00 * a13 - a03 * a10;
    var b03 = a01 * a12 - a02 * a11;
    var b04 = a01 * a13 - a03 * a11;
    var b05 = a02 * a13 - a03 * a12;
    var b06 = a20 * a31 - a21 * a30;
    var b07 = a20 * a32 - a22 * a30;
    var b08 = a20 * a33 - a23 * a30;
    var b09 = a21 * a32 - a22 * a31;
    var b10 = a21 * a33 - a23 * a31;
    var b11 = a22 * a33 - a23 * a32;
    var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return M4.identity();
    det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  };
  M4.transpose = function (m, out) {
    out = out || new Float32Array(16);
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) out[i * 4 + j] = m[j * 4 + i];
    }
    return out;
  };
  /* world matrix of the camera: T(eye) * Ry(-yaw) * Rx(pitch) */
  M4.cameraWorld = function (eye, yaw, pitch) {
    var rot = M4.multiply(M4.rotationY(-yaw), M4.rotationX(pitch));
    rot[12] = eye[0]; rot[13] = eye[1]; rot[14] = eye[2];
    return rot;
  };
  M4.cameraView = function (eye, yaw, pitch) {
    return M4.invert(M4.cameraWorld(eye, yaw, pitch));
  };
  M4.transformPoint = function (m, v) {
    return V3.transformMat4([v[0], v[1], v[2], 1], m);
  };

  /* --------------------------- camera basis ---------------------------- */
  M.cameraForward = function (yaw, pitch) {
    var cp = Math.cos(pitch);
    return [Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  };
  M.cameraRight = function (yaw) {
    return [Math.cos(yaw), 0, Math.sin(yaw)];
  };
  M.cameraUp = function (yaw, pitch) {
    var f = M.cameraForward(yaw, pitch);
    var r = M.cameraRight(yaw);
    /* up = cross(right, forward) */
    return [
      r[1] * f[2] - r[2] * f[1],
      r[2] * f[0] - r[0] * f[2],
      r[0] * f[1] - r[1] * f[0]
    ];
  };

  /* ---------------------- ray / AABB helpers --------------------------- */
  /* Ray vs axis-aligned box. Returns entry distance or -1. */
  M.rayAABB = function (origin, dir, min, max, maxDist) {
    var tmin = 0, tmax = maxDist === undefined ? 1e9 : maxDist;
    var o, d, mn, mx, inv, t1, t2;
    for (var i = 0; i < 3; i++) {
      o = origin[i]; d = dir[i]; mn = min[i]; mx = max[i];
      if (Math.abs(d) < 1e-9) {
        if (o < mn || o > mx) return -1;
      } else {
        inv = 1 / d;
        t1 = (mn - o) * inv;
        t2 = (mx - o) * inv;
        if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return -1;
      }
    }
    return tmin;
  };
  /* Ray vs sphere; returns hit distance or -1 */
  M.raySphere = function (origin, dir, center, radius, maxDist) {
    var ox = origin[0] - center[0], oy = origin[1] - center[1], oz = origin[2] - center[2];
    var b = ox * dir[0] + oy * dir[1] + oz * dir[2];
    var c = ox * ox + oy * oy + oz * oz - radius * radius;
    var disc = b * b - c;
    if (disc < 0) return -1;
    var sq = Math.sqrt(disc);
    var t = -b - sq;
    if (t < 0) t = -b + sq;
    if (t < 0 || t > (maxDist === undefined ? 1e9 : maxDist)) return -1;
    return t;
  };
  /* Segment (a->b) vs AABB, returns true if it intersects (ignoring start-end inside) */
  M.segmentAABB = function (a, b, min, max) {
    var dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    var len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    if (len < 1e-9) return false;
    dir[0] /= len; dir[1] /= len; dir[2] /= len;
    var t = M.rayAABB(a, dir, min, max, len - 1e-4);
    return t >= 0;
  };

  CS.math = M;
})();
