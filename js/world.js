/* =========================================================================
 * DUST STRIKE — world: map geometry, collision, raycast, navigation
 *
 * A compact dust2-flavoured desert map (all axis aligned boxes, flat floor):
 *   - playable bounds x in [-32,32], z in [-34,34], outer walls 8m high
 *   - CT spawn around z = -27, T spawn around z = +27
 *   - mid corridor straight north/south
 *   - long A / long B routes on the west/east sides wrapping to the sites
 *   - A site around (-17,-6), B site around (17,-4)
 *   - CT wings connect CT spawn to both sites
 *   - crates / low concrete walls / arches / a covered tunnel as cover
 *
 * Static geometry is merged per material into meshes (stride 8:
 * x,y,z, nx,ny,nz, u,v) and rendered in world.render(renderer).
 *
 * CONTRACT-GAP notes (see CONTRACT.md §8):
 *  - CS.world is a singleton: CS.world.init(game) builds once and returns
 *    CS.world; a second call is a no-op. CS.gl.createMesh is used if present.
 *    It must therefore be called AFTER CS.gl.init (main.js does this).
 *  - zones[name].points is a convex polygon outline in world XZ; every vertex
 *    is guaranteed walkable. world.inZone(name, x, z) is provided as a helper.
 *  - nav.findPath returns [[x,z], ...] including the exact start point as the
 *    first element (when it is walkable) and the exact destination as the last
 *    element; in-between points are 0.75m grid cell centers, already smoothed.
 *    Passable-space decisions use a square (Chebyshev) expansion of colliders
 *    so the nav grid, A* hop checks and isWalkable() always agree.
 *  - nav.randomPoint()/randomPointInZone() return [x,z] ground positions.
 *  - moveEntity() pos is the FEET position (pos[1] = sole height).
 *  - All walls are solid blocks standing on the floor: no stairs, no ramps.
 *  - Solid wall blocks are closed with flat rooftop caps (and vertical strips
 *    where neighbouring blocks differ in height) so the player can never see
 *    the unlit inside of a wall over a lower block. Rooftop art is generated
 *    from the 1m collision grid; it never affects collision or navigation.
 *  - Site markings use renderer.drawGroundDecal() only (annulus + faint disc),
 *    i.e. they are paint on the floor, never raised slabs that could occlude
 *    bodies or shots.
 *  - world.spawns.ct[0] is the player spawn: it looks straight down the open
 *    CT spawn into the mid corridor (>10m clear line of sight).
 * ========================================================================= */
(function () {
  'use strict';

  var CS = window.CS = window.CS || {};
  var M = CS.math;
  var PI = Math.PI;

  /* ======================================================================
   * 1. map constants / layout data
   * ==================================================================== */
  var MAP = { minX: -32, maxX: 32, minZ: -34, maxZ: 34, floorY: 0 };
  var GW = 64, GH = 68;               /* 1m solid/walkable grid over the map */
  var GRID = 1;
  var PERIMETER_H = 8.0;              /* outer shell walls (contract: >= 6m) */
  var PLAYER_R = 0.32;
  var PLAYER_H = 1.8;
  var NAV_CELL = 0.75;
  var NAV_RADIUS = 0.40;              /* nav clearance radius (> player radius) */
  var EPS = 1e-4;

  /* Open ground rectangles (x0, z0, x1, z1). Their union is the walkable
   * footprint of the map; everything else becomes solid wall blocks. */
  var OPEN_RECTS = [
    ['tSpawn',    -12,  20,  12,  32],
    ['tLinkA',    -29,  24, -12,  28],
    ['longA',     -28,  -4, -22,  26],
    ['siteA',     -28, -16, -10,   2],
    ['catwalkA',  -10,  -8,  -3,  -4],
    ['tLinkB',     12,  24,  28,  28],
    ['longB',      22,  -2,  28,  26],
    ['siteB',      10, -14,  28,   2],
    ['mid',        -3, -22,   3,  20],
    ['ctSpawn',   -12, -31,  12, -19],
    ['ctWingA',   -28, -26, -12, -21],
    ['ctWingA2',  -28, -21, -21, -16],
    ['ctWingB',    12, -26,  28, -21],
    ['ctWingB2',   21, -21,  28, -14],
    ['tunnels',     3,  10,  22,  14]
  ];

  /* Texture name for each material kind (must exist in the renderer). */
  var MAT_UV = {
    wall: 3.0, wall2: 3.2, brick: 2.7, concrete: 2.4,
    crate: 1.35, wood: 2.0, metal: 1.7, sandfloor: 6.0
  };
  var FIT_MATS = { crate: true };     /* crate faces map the whole texture */

  /* ======================================================================
   * 2. tiny geometry accumulator (one vertex/index buffer per material)
   * ==================================================================== */
  var matAcc = {};
  var meshStats = { verts: 0, tris: 0, quads: 0 };

  function accFor(mat) {
    var a = matAcc[mat];
    if (!a) { a = matAcc[mat] = { v: [], idx: [] }; }
    return a;
  }

  function flushMat(mat) {
    var a = matAcc[mat];
    if (!a || a.v.length === 0) return;
    var vcount = a.v.length / 8;
    var tcount = a.idx.length / 3;
    if (CS.gl && typeof CS.gl.createMesh === 'function') {
      var mesh = null;
      try {
        mesh = CS.gl.createMesh(new Float32Array(a.v), new Uint16Array(a.idx), mat);
      } catch (e) {
        if (window.console && console.warn) console.warn('[world] createMesh failed: ' + mat, e);
      }
      if (mesh) {
        world.meshes.push(mesh);
        world.meshInfo.push({ name: mat, verts: vcount, tris: tcount });
      }
    }
    meshStats.verts += vcount;
    meshStats.tris += tcount;
    a.v.length = 0;
    a.idx.length = 0;
  }

  function flushAllMeshes() {
    for (var k in matAcc) {
      if (Object.prototype.hasOwnProperty.call(matAcc, k)) flushMat(k);
    }
  }

  /* Add one quad (4 vertices, 2 triangles). `uvs` = [u0,v0, u1,v1, u2,v2, u3,v3].
   * Vertices must be listed counter-clockwise as seen from the normal side. */
  function addQuad(mat, n, p0, p1, p2, p3, uvs) {
    var a = accFor(mat);
    if (a.v.length / 8 + 4 > 60000) flushMat(mat); /* stay under 16-bit indices */
    a = accFor(mat);
    var base = a.v.length / 8;
    var v = a.v;
    v.push(p0[0], p0[1], p0[2], n[0], n[1], n[2], uvs[0], uvs[1]);
    v.push(p1[0], p1[1], p1[2], n[0], n[1], n[2], uvs[2], uvs[3]);
    v.push(p2[0], p2[1], p2[2], n[0], n[1], n[2], uvs[4], uvs[5]);
    v.push(p3[0], p3[1], p3[2], n[0], n[1], n[2], uvs[6], uvs[7]);
    a.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    meshStats.quads++;
  }

  /* Vertical wall face between an open cell and a solid cell. `dir` is the
   * outward normal of the solid cell, `plane` the face coordinate, a0..a1 the
   * span along the in-plane horizontal axis. UVs use world coordinates so the
   * texture keeps tiling across the 1m grid segments. */
  function addWallFace(dir, mat, plane, a0, a1, h, y0) {
    var s = MAT_UV[mat] || 3.0;
    var u0 = a0 / s, u1 = a1 / s, v0 = (y0 || 0) / s, v1 = h / s;
    if (dir === '+x') {
      addQuad(mat, [1, 0, 0],
        [plane, y0 || 0, a0], [plane, h, a0], [plane, h, a1], [plane, y0 || 0, a1],
        [u0, v0, u0, v1, u1, v1, u1, v0]);
    } else if (dir === '-x') {
      addQuad(mat, [-1, 0, 0],
        [plane, y0 || 0, a1], [plane, h, a1], [plane, h, a0], [plane, y0 || 0, a0],
        [u1, v0, u1, v1, u0, v1, u0, v0]);
    } else if (dir === '+z') {
      addQuad(mat, [0, 0, 1],
        [a0, y0 || 0, plane], [a1, y0 || 0, plane], [a1, h, plane], [a0, h, plane],
        [u0, v0, u1, v0, u1, v1, u0, v1]);
    } else {
      addQuad(mat, [0, 0, -1],
        [a1, y0 || 0, plane], [a0, y0 || 0, plane], [a0, h, plane], [a1, h, plane],
        [u1, v0, u0, v0, u0, v1, u1, v1]);
    }
  }

  /* Flat "roof" cap on top of a wall block: keeps the solid blocks closed so
   * you can never see the unlit inside of a wall over a lower neighbour. */
  function addWallTop(mat, x0, z0, x1, z1, h) {
    var s = MAT_UV[mat] || 3.0;
    addQuad(mat, [0, 1, 0],
      [x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0],
      [x0 / s, z1 / s, x1 / s, z1 / s, x1 / s, z0 / s, x0 / s, z0 / s]);
  }

  /* Box faces with correct outward normals / winding. Used for props. */
  function addBoxFaces(mat, x0, y0, z0, x1, y1, z1, opts) {
    opts = opts || {};
    var s = MAT_UV[mat] || 2.5;
    var fit = !!FIT_MATS[mat];
    var sx = x1 - x0, sy = y1 - y0, sz = z1 - z0;
    var ux = fit ? 1 : sx / s, uy = fit ? 1 : sy / s, uz = fit ? 1 : sz / s;
    /* +X */ addQuad(mat, [1, 0, 0],
      [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1],
      [0, 0, 0, uy, uz, uy, uz, 0]);
    /* -X */ addQuad(mat, [-1, 0, 0],
      [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0],
      [0, 0, 0, uy, uz, uy, uz, 0]);
    /* +Z */ addQuad(mat, [0, 0, 1],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
      [0, 0, ux, 0, ux, uy, 0, uy]);
    /* -Z */ addQuad(mat, [0, 0, -1],
      [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0],
      [0, 0, ux, 0, ux, uy, 0, uy]);
    /* +Y */ addQuad(mat, [0, 1, 0],
      [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0],
      [0, uz, ux, uz, ux, 0, 0, 0]);
    /* -Y (only for floating pieces such as arch lintels / tunnel roof) */
    if (opts.bottom) {
      addQuad(mat, [0, -1, 0],
        [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
        [0, 0, ux, 0, ux, uz, 0, uz]);
    }
  }

  /* ======================================================================
   * 3. world singleton
   * ==================================================================== */
  var world = {
    name: 'Dust Strike',
    bounds: {
      minX: MAP.minX, maxX: MAP.maxX, minZ: MAP.minZ, maxZ: MAP.maxZ,
      floorY: MAP.floorY, wallHeight: PERIMETER_H
    },
    boxes: [],        /* {min:[x,y,z], max:[x,y,z], kind:'wall'|...|'floor'} */
    propBoxes: [],    /* boxes that are not part of the solid wall grid */
    spawns: { ct: [], t: [] },
    zones: {},
    sites: {
      A: { center: [-17, -6], radius: 5 },
      B: { center: [17, -4], radius: 5 }
    },
    meshes: [],
    meshInfo: [],
    nav: null,
    inZone: inZone,
    render: render,
    raycast: raycast,
    los: los,
    moveEntity: moveEntity,
    init: init
  };
  CS.world = world;

  var built = false;
  var gridSolid = null;       /* Uint8Array, 1 = wall block */
  var gridKind = null;        /* material index per solid cell (0 = default) */
  var wallStyleNames = ['wall', 'wall2', 'brick', 'concrete'];
  var propBoxes = world.propBoxes;

  /* ======================================================================
   * 4. occupancy grid + wall height / material styling
   * ==================================================================== */
  function cellCenterX(i) { return MAP.minX + i + 0.5; }
  function cellCenterZ(j) { return MAP.minZ + j + 0.5; }

  function buildGrid() {
    var n = GW * GH;
    gridSolid = new Uint8Array(n);
    gridKind = new Uint8Array(n);
    var k, i, j;
    for (k = 0; k < n; k++) gridSolid[k] = 1;
    for (k = 0; k < OPEN_RECTS.length; k++) {
      var r = OPEN_RECTS[k];
      var x0 = r[1], z0 = r[2], x1 = r[3], z1 = r[4];
      for (j = 0; j < GH; j++) {
        var cz = cellCenterZ(j);
        if (cz <= z0 || cz >= z1) continue;
        for (i = 0; i < GW; i++) {
          var cx = cellCenterX(i);
          if (cx > x0 && cx < x1) gridSolid[j * GW + i] = 0;
        }
      }
    }
    /* material styling for solid cells (only visible faces matter) */
    for (j = 0; j < GH; j++) {
      for (i = 0; i < GW; i++) {
        if (!gridSolid[j * GW + i]) continue;
        gridKind[j * GW + i] = wallKindIndex(i, j);
      }
    }
  }

  function wallKindIndex(i, j) {
    var x = cellCenterX(i), z = cellCenterZ(j);
    if (i < 4 || i >= GW - 4 || j < 4 || j >= GH - 4) return 1; /* perimeter: wall2 */
    if (x <= -19 && z > 2) return 1;                    /* long A: wall2 */
    if (x >= 19 && z > 2) return 2;                     /* long B/tunnels: brick */
    if (x <= -9 && z <= 2) return 2;                    /* around A: brick */
    if (x >= 9 && z <= 2) return 2;                     /* around B: brick */
    if (z <= -18) return 0;                             /* CT spawn: sand plaster */
    if (z >= 20) return 0;                              /* T spawn: sand plaster */
    return ((i * 7 + j * 13) % 5 === 0) ? 1 : 0;        /* mid: mixed */
  }

  function wallHeightAt(i, j) {
    if (i < 4 || i >= GW - 4 || j < 4 || j >= GH - 4) return PERIMETER_H;
    var hx = i >> 2, hz = j >> 2;
    return 5.4 + ((hx * 5 + hz * 3) % 3) * 0.8;         /* 5.4 / 6.2 / 7.0 */
  }

  /* ======================================================================
   * 5. collision boxes + wall render faces
   * ==================================================================== */
  function addColBox(kind, x0, y0, z0, x1, y1, z1) {
    var b = {
      min: [x0, y0, z0],
      max: [x1, y1, z1],
      kind: kind || 'wall'
    };
    world.boxes.push(b);
    return b;
  }

  function buildFloorCollider() {
    var b = addColBox('floor', -36, -1, -38, 36, 0, 38);
    b.floor = true;
  }

  /* Greedy rectangle decomposition of the solid grid -> collision boxes.
   * Collision only needs the combined solid volume; the visible faces are
   * emitted per 1m grid segment in buildWallFaces(). */
  function buildWallBoxes() {
    var visited = new Uint8Array(GW * GH);
    var i, j;
    for (j = 0; j < GH; j++) {
      for (i = 0; i < GW; i++) {
        var idx = j * GW + i;
        if (!gridSolid[idx] || visited[idx]) continue;
        /* extend right */
        var i2 = i;
        while (i2 + 1 < GW && gridSolid[j * GW + i2 + 1] && !visited[j * GW + i2 + 1]) i2++;
        /* extend down while the whole row is still free */
        var j2 = j;
        while (j2 + 1 < GH) {
          var rowOk = true;
          for (var ii = i; ii <= i2; ii++) {
            var kk = (j2 + 1) * GW + ii;
            if (!gridSolid[kk] || visited[kk]) { rowOk = false; break; }
          }
          if (!rowOk) break;
          j2++;
        }
        var hmax = 0;
        var kind = 'wall';
        for (var jj = j; jj <= j2; jj++) {
          for (var ii2 = i; ii2 <= i2; ii2++) {
            var k2 = jj * GW + ii2;
            visited[k2] = 1;
            var kk2 = wallKindIndex(ii2, jj);
            if (jj === j && ii2 === i) kind = wallStyleNames[kk2] || 'wall';
            var hh = wallHeightAt(ii2, jj);
            if (hh > hmax) hmax = hh;
          }
        }
        addColBox(kind, MAP.minX + i, 0, MAP.minZ + j,
          MAP.minX + i2 + 1, hmax, MAP.minZ + j2 + 1);
      }
    }
  }

  function buildWallFaces() {
    for (var j = 0; j < GH; j++) {
      for (var i = 0; i < GW; i++) {
        if (!gridSolid[j * GW + i]) continue;
        var h = wallHeightAt(i, j);
        var mat = wallStyleNames[gridKind[j * GW + i]] || 'wall';
        var x0 = MAP.minX + i, z0 = MAP.minZ + j;
        var x1 = x0 + GRID, z1 = z0 + GRID;
        var ni, nj, nx, nz, hn;
        /* +x */
        ni = i + 1;
        if (ni >= GW) { /* grid border: map shell, not visible inside */ }
        else if (!gridSolid[j * GW + ni]) addWallFace('+x', mat, x1, z0, z1, h, 0);
        else {
          hn = wallHeightAt(ni, j);
          if (hn < h - 1e-3) addWallFace('+x', mat, x1, z0, z1, h, hn);
        }
        /* -x */
        ni = i - 1;
        if (ni < 0) { /* map shell */ }
        else if (!gridSolid[j * GW + ni]) addWallFace('-x', mat, x0, z0, z1, h, 0);
        else {
          hn = wallHeightAt(ni, j);
          if (hn < h - 1e-3) addWallFace('-x', mat, x0, z0, z1, h, hn);
        }
        /* +z */
        nj = j + 1;
        if (nj >= GH) { /* map shell */ }
        else if (!gridSolid[nj * GW + i]) addWallFace('+z', mat, z1, x0, x1, h, 0);
        else {
          hn = wallHeightAt(i, nj);
          if (hn < h - 1e-3) addWallFace('+z', mat, z1, x0, x1, h, hn);
        }
        /* -z */
        nj = j - 1;
        if (nj < 0) { /* map shell */ }
        else if (!gridSolid[nj * GW + i]) addWallFace('-z', mat, z0, x0, x1, h, 0);
        else {
          hn = wallHeightAt(i, nj);
          if (hn < h - 1e-3) addWallFace('-z', mat, z0, x0, x1, h, hn);
        }
        /* closed rooftop cap */
        addWallTop(mat, x0, z0, x1, z1, h);
      }
    }
  }

  /* ======================================================================
   * 6. props: crates, low walls, arches, tunnel roof
   * ==================================================================== */
  /* Props are real collision boxes too (they are also registered separately in
   * world.propBoxes so the nav grid can treat them as low/standing obstacles). */
  function addPropBox(kind, x0, y0, z0, x1, y1, z1) {
    var b = addColBox(kind, x0, y0, z0, x1, y1, z1);
    propBoxes.push(b);
    return b;
  }

  function prop(kind, x0, z0, x1, z1, h, y0) {
    y0 = y0 || 0;
    addPropBox(kind, x0, y0, z0, x1, y0 + h, z1);
    addBoxFaces(kind, x0, y0, z0, x1, y0 + h, z1, { bottom: y0 > 0.02 });
  }

  function propFloating(kind, x0, z0, x1, z1, y0, y1) {
    addPropBox(kind, x0, y0, z0, x1, y1, z1);
    addBoxFaces(kind, x0, y0, z0, x1, y1, z1, { bottom: true });
  }

  function lowWall(kind, x0, z0, x1, z1, h) {
    prop(kind, x0, z0, x1, z1, h);
  }

  /* Doorway / gate: wall spanning fullW along X centred at cx with a gap of
   * gapW, plus a lintel above the opening (bottom at 2.35m). */
  function archX(kind, cx, z, fullW, depth, gapW, h) {
    var x0 = cx - fullW * 0.5, x1 = cx + fullW * 0.5;
    var g0 = cx - gapW * 0.5, g1 = cx + gapW * 0.5;
    var z0 = z - depth * 0.5, z1 = z + depth * 0.5;
    if (g0 - x0 > 0.3) {
      addPropBox(kind, x0, 0, z0, g0, h, z1);
      addBoxFaces(kind, x0, 0, z0, g0, h, z1, {});
    }
    if (x1 - g1 > 0.3) {
      addPropBox(kind, g1, 0, z0, x1, h, z1);
      addBoxFaces(kind, g1, 0, z0, x1, h, z1, {});
    }
    addPropBox(kind, g0, 2.35, z0, g1, h, z1);
    addBoxFaces(kind, g0, 2.35, z0, g1, h, z1, { bottom: true });
  }

  function buildProps() {
    /* ------------------------------- mid ----------------------------- */
    archX('concrete', 0, 0.0, 6.0, 1.2, 2.2, 3.4);      /* mid doors */
    prop('crate', 1.3, 7.4, 2.9, 9.2, 1.5);             /* "xbox" */
    prop('crate', -2.9, 12.5, -1.5, 13.9, 1.9);
    lowWall('concrete', -3.0, -14.3, -0.2, -13.8, 1.1);
    archX('concrete', 0, -17.5, 6.0, 0.9, 2.8, 3.4);    /* CT mid doors */
    prop('crate', 1.5, -9.0, 2.9, -7.6, 1.2);

    /* ---------------------------- catwalk A -------------------------- */
    lowWall('concrete', -10.0, -8.0, -6.2, -7.5, 1.05);
    prop('metal', -9.8, -4.8, -9.0, -4.0, 1.1);

    /* ----------------------------- long A ---------------------------- */
    archX('brick', -25, -4.0, 6.0, 1.2, 2.6, 3.4);
    prop('crate', -27.9, 8.0, -26.3, 9.4, 1.5);
    prop('crate', -23.6, 13.8, -22.0, 15.2, 1.3);
    lowWall('concrete', -27.9, 18.6, -24.4, 19.1, 1.05);
    prop('metal', -22.8, 4.0, -22.1, 4.7, 1.1);

    /* ----------------------------- A site ---------------------------- */
    prop('crate', -15.6, -10.8, -14.0, -9.2, 1.5);
    prop('crate', -15.6, -9.2, -14.4, -8.4, 0.9);       /* stacked look */
    lowWall('concrete', -22.0, -12.2, -18.0, -11.7, 1.15);
    prop('crate', -19.2, -4.2, -17.6, -2.6, 1.4);
    prop('wood', -22.2, -8.6, -20.6, -8.0, 0.7);
    prop('metal', -11.2, -13.2, -10.4, -12.4, 1.1);
    prop('crate', -12.6, -6.2, -11.0, -4.6, 1.3);

    /* --------------------------- CT wing A --------------------------- */
    prop('crate', -20.2, -25.4, -18.6, -23.8, 1.4);
    lowWall('concrete', -27.9, -23.4, -24.6, -22.9, 1.0);
    prop('crate', -27.9, -19.6, -26.3, -18.0, 1.5);
    prop('metal', -22.4, -18.5, -21.6, -17.7, 1.1);

    /* ----------------------------- B site ---------------------------- */
    archX('brick', 25, 0.0, 6.0, 1.2, 2.6, 3.4);
    prop('crate', 15.6, -6.4, 17.2, -4.8, 1.4);
    prop('crate', 18.6, -5.8, 20.2, -4.2, 1.0);
    lowWall('concrete', 12.0, -11.4, 16.0, -10.9, 1.15);
    prop('crate', 24.0, -10.8, 25.6, -9.2, 1.6);
    prop('metal', 11.0, -2.0, 11.8, -1.2, 1.1);
    prop('crate', 19.4, -3.6, 21.0, -2.0, 1.4);

    /* ----------------------------- long B ---------------------------- */
    prop('crate', 26.4, 6.0, 28.0, 7.6, 1.5);
    prop('crate', 22.0, 11.0, 23.6, 12.4, 1.3);
    lowWall('concrete', 24.5, 17.0, 28.0, 17.5, 1.05);
    prop('metal', 22.0, 20.4, 22.8, 21.2, 1.1);

    /* --------------------------- CT wing B --------------------------- */
    prop('crate', 18.4, -25.4, 20.0, -23.8, 1.4);
    lowWall('concrete', 24.6, -23.4, 27.9, -22.9, 1.0);
    prop('crate', 26.3, -19.6, 27.9, -18.0, 1.5);
    prop('metal', 21.5, -18.5, 22.3, -17.7, 1.1);

    /* ---------------------------- CT spawn --------------------------- */
    prop('crate', -10.4, -23.4, -8.8, -21.8, 1.4);
    prop('crate', 8.8, -23.4, 10.4, -21.8, 1.2);
    lowWall('concrete', -7.5, -21.6, -3.5, -21.1, 1.0);
    prop('metal', -11.2, -29.2, -10.4, -28.4, 1.1);
    prop('metal', 10.4, -29.2, 11.2, -28.4, 1.1);

    /* ----------------------------- T spawn --------------------------- */
    prop('crate', -10.4, 24.0, -8.8, 25.6, 1.4);
    prop('crate', 7.6, 25.0, 9.2, 26.6, 1.5);
    lowWall('concrete', -2.4, 29.4, 2.4, 29.9, 1.0);
    prop('metal', -11.4, 21.0, -10.6, 21.8, 1.1);
    prop('metal', 10.6, 21.0, 11.4, 21.8, 1.1);

    /* ----------------------- T spawn side links ---------------------- */
    prop('crate', -18.0, 26.4, -16.4, 28.0, 1.4);
    prop('crate', 20.0, 24.0, 21.6, 25.6, 1.3);

    /* --------------------------- upper tunnels ----------------------- */
    lowWall('concrete', 8.0, 10.0, 11.0, 10.5, 1.1);
    prop('crate', 13.6, 12.4, 15.2, 14.0, 1.4);
    propFloating('concrete', 6.0, 10.0, 19.0, 14.0, 3.3, 3.9); /* tunnel roof */

    /* ---------------- map-edge decoration (visual richness) ----------- */
    /* Extra cover flush against the outer walls: still leaves >= 2.5m lanes,
     * verified by the nav connectivity self-test. */
    prop('crate', -27.9, 1.0, -26.3, 2.4, 1.3);        /* long A, south end */
    prop('crate', -27.9, 21.6, -26.3, 23.0, 1.6);      /* long A, north end */
    prop('wood', -27.9, 12.0, -26.5, 12.8, 0.6);       /* long A planks */
    prop('crate', 26.4, 2.0, 28.0, 3.4, 1.4);          /* long B, south end */
    prop('crate', 26.4, 22.0, 28.0, 23.4, 1.5);        /* long B, north end */
    prop('wood', 26.5, 24.0, 27.9, 24.8, 0.6);         /* long B planks */
    prop('crate', -10.6, 28.4, -8.6, 30.6, 1.7);       /* T spawn back-left */
    prop('crate', 8.6, 28.6, 10.2, 30.2, 1.4);         /* T spawn back-right */
    prop('crate', 5.4, 12.6, 6.8, 14.0, 1.3);          /* tunnels, north side */
  }

  /* Flat rooftop parapets: 0.6-0.9m trims sitting on top of wall blocks. They
   * are above eye level so they only show up as silhouettes against the sky.
   * Each strip must cover solid cells of a single (uniform height) chunk. */
  function parapet(mat, x0, z0, x1, z1, extra) {
    var i0 = Math.floor(x0 - MAP.minX), i1 = Math.ceil(x1 - MAP.minX) - 1;
    var j0 = Math.floor(z0 - MAP.minZ), j1 = Math.ceil(z1 - MAP.minZ) - 1;
    if (i1 < i0 || j1 < j0) return;
    var h = -1;
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        if (!gridSolid[j * GW + i]) return;
        var hh = wallHeightAt(i, j);
        if (h < 0) h = hh;
        else if (Math.abs(hh - h) > 1e-6) return;
      }
    }
    if (h < 0) return;
    addPropBox(mat, x0, h - 0.08, z0, x1, h + extra, z1);
    addBoxFaces(mat, x0, h - 0.08, z0, x1, h + extra, z1, { bottom: false });
  }

  function buildParapets() {
    parapet('wall2', -4, 2, -3, 6, 0.85);      /* mid west wall */
    parapet('wall2', 3, 2, 4, 6, 0.85);        /* mid east wall */
    parapet('brick', -4, -12, -3, -8, 0.9);    /* mid west, near catwalk */
    parapet('brick', 3, -12, 4, -8, 0.9);      /* mid east */
    parapet('wall2', -22, 8, -21, 12, 0.8);    /* long A east wall */
    parapet('brick', 21, 8, 22, 12, 0.8);      /* long B west wall */
    parapet('wall', -13, 20, -12, 22, 0.8);    /* T spawn west wall */
    parapet('wall', 12, -30, 13, -26, 0.8);    /* CT spawn east wall */
    parapet('brick', -20, -17, -16, -16, 0.8); /* A site north wall */
    parapet('brick', 14, -16, 19, -15, 0.8);   /* B site north wall */
  }

  /* ======================================================================
   * 7. floor mesh + site markings
   * ==================================================================== */
  function buildFloorMesh() {
    var x0 = MAP.minX - 4, x1 = MAP.maxX + 4;
    var z0 = MAP.minZ - 4, z1 = MAP.maxZ + 4;
    var s = MAT_UV.sandfloor;
    addQuad('sandfloor', [0, 1, 0],
      [x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0],
      [x0 / s, z1 / s, x1 / s, z1 / s, x1 / s, z0 / s, x0 / s, z0 / s]);
  }

  var siteMarks = [];      /* drawGroundDecal rings (site markers) */

  function buildSiteMarkings() {
    var a = world.sites.A, b = world.sites.B;
    /* Two concentric painted rings per site: the renderer draws an annulus +
     * a faint tinted disc, which reads like CS's painted bomb site marking.
     * No solid paint slab on purpose, so the ground textures stay visible. */
    siteMarks.push({
      pos: [a.center[0], MAP.floorY, a.center[1]],
      rings: [
        { radius: world.sites.A.radius, color: [0.95, 0.40, 0.10, 0.85] },
        { radius: 1.8, color: [1.0, 0.55, 0.18, 0.9] }
      ]
    });
    siteMarks.push({
      pos: [b.center[0], MAP.floorY, b.center[1]],
      rings: [
        { radius: world.sites.B.radius, color: [0.22, 0.48, 0.95, 0.85] },
        { radius: 1.8, color: [0.35, 0.62, 1.0, 0.9] }
      ]
    });
  }

  /* ======================================================================
   * 8. spawn points, zones, helper queries
   * ==================================================================== */
  function yawTo(px, pz, tx, tz) {
    return Math.atan2(tx - px, -(tz - pz));
  }

  function makeSpawn(px, pz, tx, tz) {
    return { pos: [px, 0, pz], yaw: yawTo(px, pz, tx, tz) };
  }

  function buildSpawns() {
    var ct = world.spawns.ct, t = world.spawns.t;
    /* CT side: south end, facing north / map centre. Player uses ct[0]:
     * from here the whole CT spawn + mid corridor north is an open ~10m
     * sightline (no cover in the first 8m), per Lead feedback. */
    ct.push(makeSpawn(0.0, -27.5, 0, 0));
    ct.push(makeSpawn(-6.5, -28.5, 0, 0));
    ct.push(makeSpawn(6.5, -28.5, 0, 0));
    ct.push(makeSpawn(-3.0, -25.0, 0, 0));
    ct.push(makeSpawn(3.0, -25.0, 0, 0));
    /* T side: north end, facing south / map centre. t[0] looks straight down
     * the T spawn into the mid corridor (open >8m). */
    t.push(makeSpawn(0.0, 28.0, 0, 0));
    t.push(makeSpawn(-7.0, 27.0, 0, 0));
    t.push(makeSpawn(-2.5, 26.5, 0, 0));
    t.push(makeSpawn(7.0, 27.0, 0, 0));
    t.push(makeSpawn(2.5, 26.5, 0, 0));
  }

  function rectPoints(x0, z0, x1, z1) {
    return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  }

  function buildZones() {
    var Z = world.zones;
    Z.tSpawn = { points: rectPoints(-11.5, 22.5, 11.5, 31.5) };
    Z.ctSpawn = { points: rectPoints(-11, -30, 11, -20) };
    Z.mid = { points: rectPoints(-2.5, -16, 2.5, 18) };
    Z.siteA = { points: rectPoints(-27, -14, -11, -2) };
    Z.siteB = { points: rectPoints(12.5, -12, 25, -2.5) };
    Z.longA = { points: rectPoints(-26.5, 4, -23.5, 20) };
    Z.longB = { points: rectPoints(23.5, 4, 26.5, 20) };
    Z.tunnels = { points: rectPoints(5, 11.5, 16, 13) };
    var names = ['tSpawn', 'ctSpawn', 'mid', 'siteA', 'siteB', 'longA', 'longB', 'tunnels'];
    for (var k = 0; k < names.length; k++) {
      var zone = Z[names[k]];
      var cx = 0, cz = 0;
      for (var p = 0; p < zone.points.length; p++) {
        cx += zone.points[p][0];
        cz += zone.points[p][1];
      }
      zone.center = [cx / zone.points.length, cz / zone.points.length];
    }
  }

  /* point in polygon (even-odd), used by inZone / randomPointInZone */
  function pointInPoly(pts, x, z) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], zi = pts[i][1];
      var xj = pts[j][0], zj = pts[j][1];
      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function inZone(name, x, z) {
    var zone = world.zones[name];
    if (!zone || !zone.points || zone.points.length < 3) return false;
    return pointInPoly(zone.points, x, z);
  }

  /* ======================================================================
   * 9. broadphase (uniform 2D grid over collision boxes)
   * ==================================================================== */
  var BP = {
    cell: 4, x0: -36, z0: -38, nx: 18, nz: 19,
    lists: null, stamp: null, counter: 1, out: [],
    losStamp: null, losCounter: 1, ready: false
  };

  function bpCellX(x) {
    var i = Math.floor((x - BP.x0) / BP.cell);
    return i < 0 ? 0 : (i >= BP.nx ? BP.nx - 1 : i);
  }
  function bpCellZ(z) {
    var j = Math.floor((z - BP.z0) / BP.cell);
    return j < 0 ? 0 : (j >= BP.nz ? BP.nz - 1 : j);
  }

  function buildBroadphase() {
    var n = BP.nx * BP.nz;
    var lists = new Array(n);
    for (var k = 0; k < n; k++) lists[k] = null;
    for (var bi = 0; bi < world.boxes.length; bi++) {
      var b = world.boxes[bi];
      if (b.floor) continue;
      var i0 = bpCellX(b.min[0]), i1 = bpCellX(b.max[0]);
      var j0 = bpCellZ(b.min[2]), j1 = bpCellZ(b.max[2]);
      for (var j = j0; j <= j1; j++) {
        for (var i = i0; i <= i1; i++) {
          var idx = j * BP.nx + i;
          if (!lists[idx]) lists[idx] = [];
          lists[idx].push(bi);
        }
      }
    }
    BP.lists = lists;
    BP.stamp = new Int32Array(world.boxes.length);
    BP.losStamp = new Int32Array(world.boxes.length);
    BP.ready = true;
  }

  /* Candidate collision boxes overlapping an XZ rectangle (deduplicated).
   * Returns a shared array - do not keep a reference across calls. */
  function queryBoxes(x0, z0, x1, z1) {
    var out = BP.out;
    out.length = 0;
    if (!BP.ready) return out;
    BP.counter++;
    if (BP.counter > 2000000000) { BP.stamp.fill(0); BP.counter = 1; }
    var c = BP.counter;
    var i0 = bpCellX(x0), i1 = bpCellX(x1);
    var j0 = bpCellZ(z0), j1 = bpCellZ(z1);
    for (var j = j0; j <= j1; j++) {
      var row = j * BP.nx;
      for (var i = i0; i <= i1; i++) {
        var list = BP.lists[row + i];
        if (!list) continue;
        for (var k = 0; k < list.length; k++) {
          var bi = list[k];
          if (BP.stamp[bi] !== c) { BP.stamp[bi] = c; out.push(bi); }
        }
      }
    }
    return out;
  }

  /* 2D DDA over broadphase cells between two points (supercover on corner
   * crossings). cb(i,j) returning true stops the walk. */
  function walkCells(ax, az, bx, bz, cb) {
    if (!BP.ready) return;
    var i = bpCellX(ax), j = bpCellZ(az);
    var endI = bpCellX(bx), endJ = bpCellZ(bz);
    var dx = bx - ax, dz = bz - az;
    var stepI = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
    var stepJ = dz > 0 ? 1 : (dz < 0 ? -1 : 0);
    var tMaxI, tMaxJ, tDeltaI, tDeltaJ;
    if (stepI !== 0) {
      var nextI = BP.x0 + (i + (stepI > 0 ? 1 : 0)) * BP.cell;
      tMaxI = (nextI - ax) / dx;
      tDeltaI = BP.cell / Math.abs(dx);
    } else { tMaxI = Infinity; tDeltaI = Infinity; }
    if (stepJ !== 0) {
      var nextJ = BP.z0 + (j + (stepJ > 0 ? 1 : 0)) * BP.cell;
      tMaxJ = (nextJ - az) / dz;
      tDeltaJ = BP.cell / Math.abs(dz);
    } else { tMaxJ = Infinity; tDeltaJ = Infinity; }
    var guard = 0;
    while (guard++ < 400) {
      if (cb(i, j)) return;
      if (i === endI && j === endJ) return;
      if (tMaxI < tMaxJ - 1e-12) {
        i += stepI; tMaxI += tDeltaI;
      } else if (tMaxJ < tMaxI - 1e-12) {
        j += stepJ; tMaxJ += tDeltaJ;
      } else {
        if (cb(i + stepI, j)) return;
        if (cb(i, j + stepJ)) return;
        i += stepI; j += stepJ;
        tMaxI += tDeltaI; tMaxJ += tDeltaJ;
      }
      if (i < 0 || j < 0 || i >= BP.nx || j >= BP.nz) return;
    }
  }

  /* ======================================================================
   * 10. collision / movement
   * ==================================================================== */
  function supportAt(x, y, z, r) {
    if (y <= MAP.floorY + 0.005 && y >= MAP.floorY - 0.05) return true;
    var cand = queryBoxes(x - r, z - r, x + r, z + r);
    var rr = r * 0.9;
    for (var k = 0; k < cand.length; k++) {
      var b = world.boxes[cand[k]];
      if (b.floor) continue;
      if (x + rr <= b.min[0] || x - rr >= b.max[0]) continue;
      if (z + rr <= b.min[2] || z - rr >= b.max[2]) continue;
      var top = b.max[1];
      /* support must be at the feet: a few mm above the top at most */
      if (top <= y + 0.005 && top >= y - 0.02) return true;
    }
    return false;
  }

  function moveAxisY(p, dy, r, h, res) {
    p[1] += dy;
    if (dy < 0 && p[1] < MAP.floorY) {
      p[1] = MAP.floorY;
      res.onGround = true;
    }
    var cand = queryBoxes(p[0] - r, p[2] - r, p[0] + r, p[2] + r);
    for (var it = 0; it < 3; it++) {
      var hit = false;
      for (var k = 0; k < cand.length; k++) {
        var b = world.boxes[cand[k]];
        if (b.floor) continue;
        if (p[0] + r <= b.min[0] + EPS || p[0] - r >= b.max[0] - EPS) continue;
        if (p[2] + r <= b.min[2] + EPS || p[2] - r >= b.max[2] - EPS) continue;
        if (p[1] >= b.max[1] - EPS || p[1] + h <= b.min[1] + EPS) continue;
        if (dy < 0) {
          p[1] = b.max[1];
          res.onGround = true;
          hit = true;
        } else if (dy > 0) {
          p[1] = b.min[1] - h;
          res.hitCeil = true;
          hit = true;
        } else {
          hit = true;
        }
      }
      if (!hit) break;
    }
  }

  function moveAxisX(p, dx, r, h, res) {
    p[0] += dx;
    var cand = queryBoxes(p[0] - r, p[2] - r, p[0] + r, p[2] + r);
    for (var it = 0; it < 4; it++) {
      var hit = false;
      for (var k = 0; k < cand.length; k++) {
        var b = world.boxes[cand[k]];
        if (b.floor) continue;
        if (p[1] + h <= b.min[1] + EPS || p[1] >= b.max[1] - EPS) continue;
        if (p[2] + r <= b.min[2] + EPS || p[2] - r >= b.max[2] - EPS) continue;
        if (p[0] + r <= b.min[0] + EPS || p[0] - r >= b.max[0] - EPS) continue;
        if (dx > 0) p[0] = b.min[0] - r;
        else p[0] = b.max[0] + r;
        res.hitWall = true;
        hit = true;
      }
      if (!hit) break;
    }
  }

  function moveAxisZ(p, dz, r, h, res) {
    p[2] += dz;
    var cand = queryBoxes(p[0] - r, p[2] - r, p[0] + r, p[2] + r);
    for (var it = 0; it < 4; it++) {
      var hit = false;
      for (var k = 0; k < cand.length; k++) {
        var b = world.boxes[cand[k]];
        if (b.floor) continue;
        if (p[1] + h <= b.min[1] + EPS || p[1] >= b.max[1] - EPS) continue;
        if (p[0] + r <= b.min[0] + EPS || p[0] - r >= b.max[0] - EPS) continue;
        if (p[2] + r <= b.min[2] + EPS || p[2] - r >= b.max[2] - EPS) continue;
        if (dz > 0) p[2] = b.min[2] - r;
        else p[2] = b.max[2] + r;
        res.hitWall = true;
        hit = true;
      }
      if (!hit) break;
    }
  }

  /* AABB swept movement (per-axis sliding). pos is the feet position. */
  function moveEntity(pos, delta, radius, height) {
    var r = (typeof radius === 'number' && radius > 0) ? radius : PLAYER_R;
    var h = (typeof height === 'number' && height > 0) ? height : PLAYER_H;
    var p = [pos[0], pos[1], pos[2]];
    var dx = delta && delta[0] || 0;
    var dy = delta && delta[1] || 0;
    var dz = delta && delta[2] || 0;
    var res = { pos: p, onGround: false, hitWall: false, hitCeil: false };
    if (!built) {
      p[0] += dx; p[1] += dy; p[2] += dz;
      if (p[1] < MAP.floorY) { p[1] = MAP.floorY; res.onGround = true; }
      return res;
    }
    var maxComp = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    var steps = Math.max(1, Math.ceil(maxComp / 0.2));
    var sx = dx / steps, sy = dy / steps, sz = dz / steps;
    for (var s = 0; s < steps; s++) {
      if (sy !== 0) moveAxisY(p, sy, r, h, res);
      if (sx !== 0) moveAxisX(p, sx, r, h, res);
      if (sz !== 0) moveAxisZ(p, sz, r, h, res);
    }
    res.onGround = res.onGround || supportAt(p[0], p[1], p[2], r);
    /* hard safety bounds (should never trigger; outer walls are solid) */
    if (p[0] < MAP.minX + 0.02) { p[0] = MAP.minX + 0.02; res.hitWall = true; }
    if (p[0] > MAP.maxX - 0.02) { p[0] = MAP.maxX - 0.02; res.hitWall = true; }
    if (p[2] < MAP.minZ + 0.02) { p[2] = MAP.minZ + 0.02; res.hitWall = true; }
    if (p[2] > MAP.maxZ - 0.02) { p[2] = MAP.maxZ - 0.02; res.hitWall = true; }
    if (p[1] < -2) { p[1] = MAP.floorY; res.onGround = true; }
    if (!isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) {
      p[0] = pos[0]; p[1] = pos[1]; p[2] = pos[2];
    }
    return res;
  }

  /* ======================================================================
   * 11. raycast / line of sight
   * ==================================================================== */
  /* Ray vs AABB, returns {t, axis, sign} or null. `axis` is the face the ray
   * entered through and `sign` the outward normal component on that axis. */
  function rayBox(ox, oy, oz, dx, dy, dz, min, max, maxT) {
    var tmin = 0, tmax = maxT, axis = -1, sign = 0;
    var o, d, mn, mx, inv, t1, t2, sg, tmp;
    for (var a = 0; a < 3; a++) {
      o = a === 0 ? ox : (a === 1 ? oy : oz);
      d = a === 0 ? dx : (a === 1 ? dy : dz);
      mn = min[a]; mx = max[a];
      if (d > -1e-9 && d < 1e-9) {
        if (o < mn || o > mx) return null;
        continue;
      }
      inv = 1 / d;
      t1 = (mn - o) * inv;
      t2 = (mx - o) * inv;
      if (t1 > t2) { tmp = t1; t1 = t2; t2 = tmp; sg = 1; }
      else sg = -1;
      if (t1 > tmin) { tmin = t1; axis = a; sign = sg; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (tmin > maxT) return null;
    return { t: tmin, axis: axis, sign: sign };
  }

  function raycast(origin, dir, maxDist) {
    if (!built || !origin || !dir) return null;
    var dl = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    if (!(dl > 1e-9)) return null;
    var dx = dir[0] / dl, dy = dir[1] / dl, dz = dir[2] / dl;
    var maxT = (typeof maxDist === 'number' && maxDist > 0) ? maxDist : 200;
    var ox = origin[0], oy = origin[1], oz = origin[2];
    var bestT = maxT + 1, bestBox = null, bestAxis = -1, bestSign = 0;
    var boxes = world.boxes;
    for (var k = 0; k < boxes.length; k++) {
      var b = boxes[k];
      var hit = rayBox(ox, oy, oz, dx, dy, dz, b.min, b.max, maxT);
      if (hit && hit.t < bestT) {
        bestT = hit.t;
        bestBox = b;
        bestAxis = hit.axis;
        bestSign = hit.sign;
      }
    }
    if (!bestBox) return null;
    var normal = [0, 0, 0];
    if (bestAxis >= 0) normal[bestAxis] = bestSign;
    else { normal[0] = -dx; normal[1] = -dy; normal[2] = -dz; }
    return {
      dist: bestT,
      point: [ox + dx * bestT, oy + dy * bestT, oz + dz * bestT],
      normal: normal,
      box: bestBox
    };
  }

  function los(from, to) {
    if (!built || !from || !to) return true;
    var dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    if (dx * dx + dy * dy + dz * dz < 1e-8) return true;
    BP.losCounter++;
    if (BP.losCounter > 2000000000) { BP.losStamp.fill(0); BP.losCounter = 1; }
    var c = BP.losCounter;
    var blocked = false;
    walkCells(from[0], from[2], to[0], to[2], function (i, j) {
      if (!BP.ready) return true;
      var list = BP.lists[j * BP.nx + i];
      if (!list) return false;
      for (var k = 0; k < list.length; k++) {
        var bi = list[k];
        if (BP.losStamp[bi] === c) continue;
        BP.losStamp[bi] = c;
        var b = world.boxes[bi];
        if (M.segmentAABB(from, to, b.min, b.max)) { blocked = true; return true; }
      }
      return false;
    });
    return !blocked;
  }

  /* ======================================================================
   * 12. navigation grid + A*
   * ==================================================================== */
  var NAV = {
    w: 0, h: 0, walk: null, list: [],
    g: null, came: null, closed: null,
    ready: false
  };

  function navCenterX(i) { return MAP.minX + (i + 0.5) * NAV_CELL; }
  function navCenterZ(j) { return MAP.minZ + (j + 0.5) * NAV_CELL; }
  function navCellX(x) {
    var i = Math.floor((x - MAP.minX) / NAV_CELL);
    return i < 0 ? 0 : (i >= NAV.w ? NAV.w - 1 : i);
  }
  function navCellZ(z) {
    var j = Math.floor((z - MAP.minZ) / NAV_CELL);
    return j < 0 ? 0 : (j >= NAV.h ? NAV.h - 1 : j);
  }
  function navWalkAt(i, j) {
    if (i < 0 || j < 0 || i >= NAV.w || j >= NAV.h) return false;
    return NAV.walk[j * NAV.w + i] === 1;
  }

  /* Is a player (radius NAV_RADIUS) able to stand with feet at (x,z)? */
  function isWalkableAt(x, z) {
    var r = NAV_RADIUS;
    if (!(x - r >= MAP.minX && x + r <= MAP.maxX && z - r >= MAP.minZ && z + r <= MAP.maxZ)) return false;
    /* solid wall blocks (expanded by the nav radius, square metric so that the
     * grid, A* hop checks and navLineClear all agree on what is passable) */
    var i0 = Math.floor((x - r - MAP.minX) / GRID);
    var i1 = Math.floor((x + r - MAP.minX) / GRID);
    var j0 = Math.floor((z - r - MAP.minZ) / GRID);
    var j1 = Math.floor((z + r - MAP.minZ) / GRID);
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i1 >= GW) i1 = GW - 1;
    if (j1 >= GH) j1 = GH - 1;
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        if (!gridSolid[j * GW + i]) continue;
        var bx0 = MAP.minX + i, bz0 = MAP.minZ + j;
        if (x > bx0 - r && x < bx0 + GRID + r &&
            z > bz0 - r && z < bz0 + GRID + r) return false;
      }
    }
    /* props: only pieces that intersect the standing body volume */
    var props = propBoxes;
    for (var k = 0; k < props.length; k++) {
      var b = props[k];
      if (b.min[1] > 1.72 || b.max[1] < 0.06) continue;
      if (x > b.min[0] - r && x < b.max[0] + r &&
          z > b.min[2] - r && z < b.max[2] + r) return false;
    }
    return true;
  }

  function buildNav() {
    NAV.w = Math.floor((MAP.maxX - MAP.minX) / NAV_CELL);
    NAV.h = Math.floor((MAP.maxZ - MAP.minZ) / NAV_CELL);
    var n = NAV.w * NAV.h;
    NAV.walk = new Uint8Array(n);
    NAV.list.length = 0;
    for (var j = 0; j < NAV.h; j++) {
      for (var i = 0; i < NAV.w; i++) {
        var cx = navCenterX(i), cz = navCenterZ(j);
        if (isWalkableAt(cx, cz)) {
          NAV.walk[j * NAV.w + i] = 1;
          NAV.list.push([cx, cz]);
        }
      }
    }
    NAV.g = new Float32Array(n);
    NAV.came = new Int32Array(n);
    NAV.closed = new Uint8Array(n);
    NAV.ready = true;
  }

  function nearestWalkable(x, z) {
    if (!NAV.ready) return [x, z];
    var ci = navCellX(x), cj = navCellZ(z);
    if (navWalkAt(ci, cj)) return [navCenterX(ci), navCenterZ(cj)];
    var maxR = Math.max(NAV.w, NAV.h);
    for (var r = 1; r <= maxR; r++) {
      for (var di = -r; di <= r; di++) {
        var djEdge = r - Math.abs(di);
        var j1 = cj + djEdge, j2 = cj - djEdge;
        var iA = ci + di;
        if (iA >= 0 && iA < NAV.w) {
          if (navWalkAt(iA, j1)) return [navCenterX(iA), navCenterZ(j1)];
          if (navWalkAt(iA, j2)) return [navCenterX(iA), navCenterZ(j2)];
        }
      }
      for (var dj = -r + 1; dj <= r - 1; dj++) {
        var diEdge = r - Math.abs(dj);
        var jB = cj + dj;
        if (jB < 0 || jB >= NAV.h) continue;
        var i1 = ci + diEdge, i2 = ci - diEdge;
        if (i1 >= 0 && i1 < NAV.w && navWalkAt(i1, jB)) return [navCenterX(i1), navCenterZ(jB)];
        if (i2 >= 0 && i2 < NAV.w && navWalkAt(i2, jB)) return [navCenterX(i2), navCenterZ(jB)];
      }
    }
    return [x, z];
  }

  /* 2D segment (XZ) vs axis aligned rectangle (slab test). */
  function seg2DRect(ax, az, bx, bz, minx, minz, maxx, maxz) {
    var tmin = 0, tmax = 1;
    var dx = bx - ax, dz = bz - az;
    if (dx > -1e-12 && dx < 1e-12) {
      if (ax < minx || ax > maxx) return false;
    } else {
      var inv = 1 / dx;
      var t1 = (minx - ax) * inv, t2 = (maxx - ax) * inv;
      if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
    if (dz > -1e-12 && dz < 1e-12) {
      if (az < minz || az > maxz) return false;
    } else {
      var inv2 = 1 / dz;
      var s1 = (minz - az) * inv2, s2 = (maxz - az) * inv2;
      if (s1 > s2) { var tmp2 = s1; s1 = s2; s2 = tmp2; }
      if (s1 > tmin) tmin = s1;
      if (s2 < tmax) tmax = s2;
      if (tmin > tmax) return false;
    }
    return true;
  }

  /* Straight line walkability for path smoothing. Exact: the blocked set of a
   * flat map is the union of every ground collision box expanded by the nav
   * radius, so one segment-vs-boxes pass is enough (no sampling gaps at
   * corners). Broadphase bbox query keeps it fast for short hops. */
  function navLineClear(ax, az, bx, bz) {
    var r = NAV_RADIUS;
    if (ax < MAP.minX + r || ax > MAP.maxX - r || az < MAP.minZ + r || az > MAP.maxZ - r) return false;
    if (bx < MAP.minX + r || bx > MAP.maxX - r || bz < MAP.minZ + r || bz > MAP.maxZ - r) return false;
    var cand = queryBoxes(
      Math.min(ax, bx) - r, Math.min(az, bz) - r,
      Math.max(ax, bx) + r, Math.max(az, bz) + r);
    for (var k = 0; k < cand.length; k++) {
      var b = world.boxes[cand[k]];
      if (b.floor) continue;
      if (b.min[1] > 1.72) continue;                      /* overhead pieces */
      if (seg2DRect(ax, az, bx, bz,
        b.min[0] - r, b.min[2] - r, b.max[0] + r, b.max[2] + r)) return false;
    }
    return true;
  }

  var NEIGH = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, 1.41421356], [1, -1, 1.41421356], [-1, 1, 1.41421356], [-1, -1, 1.41421356]
  ];

  function findPath(fromX, fromZ, toX, toZ) {
    if (!NAV.ready) return null;
    if (!isFinite(fromX) || !isFinite(fromZ) || !isFinite(toX) || !isFinite(toZ)) return null;
    var si = navCellX(fromX), sj = navCellZ(fromZ);
    var ti = navCellX(toX), tj = navCellZ(toZ);
    if (!navWalkAt(si, sj)) {
      var nwS = nearestWalkable(fromX, fromZ);
      if (!nwS) return null;
      fromX = nwS[0]; fromZ = nwS[1];
      si = navCellX(fromX); sj = navCellZ(fromZ);
      if (!navWalkAt(si, sj)) return null;
    }
    if (!navWalkAt(ti, tj)) {
      var nwT = nearestWalkable(toX, toZ);
      if (!nwT) return null;
      toX = nwT[0]; toZ = nwT[1];
      ti = navCellX(toX); tj = navCellZ(toZ);
      if (!navWalkAt(ti, tj)) return null;
    }
    var W = NAV.w;
    var startIdx = sj * W + si, goalIdx = tj * W + ti;
    var direct = [[fromX, fromZ]];
    if (startIdx === goalIdx) {
      direct.push([toX, toZ]);
      return direct;
    }
    var g = NAV.g, closed = NAV.closed, came = NAV.came;
    g.fill(Infinity);
    closed.fill(0);
    /* binary heap of node ids; f-score kept in a parallel array pool */
    var heapN = [], heapF = [];
    function hPush(node, f) {
      heapN.push(node); heapF.push(f);
      var k = heapN.length - 1;
      while (k > 0) {
        var parent = (k - 1) >> 1;
        if (heapF[parent] <= f) break;
        heapN[k] = heapN[parent]; heapF[k] = heapF[parent];
        k = parent;
      }
      heapN[k] = node; heapF[k] = f;
    }
    function hPop() {
      var top = heapN[0];
      var lastN = heapN.pop(), lastF = heapF.pop();
      var len = heapN.length;
      if (len > 0) {
        var k = 0;
        heapN[0] = lastN; heapF[0] = lastF;
        for (;;) {
          var l = k * 2 + 1, r = l + 1, m = k;
          if (l < len && heapF[l] < heapF[m]) m = l;
          if (r < len && heapF[r] < heapF[m]) m = r;
          if (m === k) break;
          var tn = heapN[m], tf = heapF[m];
          heapN[m] = heapN[k]; heapF[m] = heapF[k];
          heapN[k] = tn; heapF[k] = tf;
          k = m;
        }
      }
      return top;
    }
    function heuristic(i, j) {
      var dx = Math.abs(i - ti), dz = Math.abs(j - tj);
      return (dx + dz) + (1.41421356 - 2) * Math.min(dx, dz);
    }
    g[startIdx] = 0;
    hPush(startIdx, heuristic(si, sj));
    var found = false;
    var guard = 0;
    while (heapN.length > 0 && guard++ < 60000) {
      var cur = hPop();
      if (closed[cur]) continue;
      if (cur === goalIdx) { found = true; break; }
      closed[cur] = 1;
      var ci = cur % W, cj = (cur - ci) / W;
      var curX = navCenterX(ci), curZ = navCenterZ(cj);
      for (var k = 0; k < 8; k++) {
        var ni = ci + NEIGH[k][0], nj = cj + NEIGH[k][1];
        if (!navWalkAt(ni, nj)) continue;
        var nidx = nj * W + ni;
        if (closed[nidx]) continue;
        var nX = navCenterX(ni), nZ = navCenterZ(nj);
        /* exact hop check: no squeezing through blocked corners */
        if (!navLineClear(curX, curZ, nX, nZ)) continue;
        var tentative = g[cur] + NEIGH[k][2];
        if (tentative < g[nidx]) {
          g[nidx] = tentative;
          came[nidx] = cur;
          hPush(nidx, tentative + heuristic(ni, nj));
        }
      }
    }
    if (!found) return null;
    /* reconstruct cell path */
    var cells = [];
    var idx = goalIdx;
    var safety = 0;
    while (safety++ < 10000) {
      cells.push(idx);
      if (idx === startIdx) break;
      idx = came[idx];
    }
    cells.reverse();
    var pts = [[fromX, fromZ]];
    for (var c = 1; c < cells.length; c++) {
      var ii = cells[c] % W, jj = (cells[c] - ii) / W;
      pts.push([navCenterX(ii), navCenterZ(jj)]);
    }
    pts.push([toX, toZ]);
    /* smooth: greedily skip waypoints while the straight line stays walkable */
    var out = [pts[0]];
    var i = 0;
    while (i < pts.length - 1) {
      var j = i + 1;
      var best = j;
      var limit = Math.min(pts.length - 1, i + 24);
      while (j + 1 <= limit && navLineClear(pts[i][0], pts[i][1], pts[j + 1][0], pts[j + 1][1])) {
        j++;
        best = j;
      }
      out.push(pts[best]);
      i = best;
    }
    /* make sure the exact destination is included when it is reachable */
    var last = out[out.length - 1];
    if (Math.abs(last[0] - toX) > 1e-3 || Math.abs(last[1] - toZ) > 1e-3) {
      if (navLineClear(last[0], last[1], toX, toZ)) out.push([toX, toZ]);
    }
    if (out.length < 2) out.push([toX, toZ]);
    return out;
  }

  function randomPoint() {
    if (!NAV.ready || NAV.list.length === 0) return null;
    return NAV.list[(Math.random() * NAV.list.length) | 0];
  }

  function randomPointInZone(name) {
    if (!NAV.ready) return null;
    var zone = world.zones[name];
    if (!zone || !zone.points || zone.points.length < 3) return null;
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (var k = 0; k < zone.points.length; k++) {
      var p = zone.points[k];
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1];
      if (p[1] > maxZ) maxZ = p[1];
    }
    for (var t = 0; t < 100; t++) {
      var x = minX + Math.random() * (maxX - minX);
      var z = minZ + Math.random() * (maxZ - minZ);
      if (!pointInPoly(zone.points, x, z)) continue;
      if (isWalkableAt(x, z)) return [x, z];
    }
    var nc = nearestWalkable((minX + maxX) * 0.5, (minZ + maxZ) * 0.5);
    if (nc && isWalkableAt(nc[0], nc[1])) return nc;
    return null;
  }

  var nav = {
    cell: NAV_CELL,
    isWalkable: function (x, z) { return NAV.ready ? isWalkableAt(x, z) : false; },
    findPath: findPath,
    nearestWalkable: nearestWalkable,
    randomPointInZone: randomPointInZone,
    randomPoint: randomPoint
  };
  world.nav = nav;

  /* ======================================================================
   * 13. render
   * ==================================================================== */
  function render(renderer) {
    if (!renderer) return;
    var i, j;
    for (i = 0; i < world.meshes.length; i++) {
      var mesh = world.meshes[i];
      if (mesh) renderer.drawMesh(mesh);
    }
    /* site markings: only empty-ground decals, no raised paint slabs */
    if (typeof renderer.drawGroundDecal === 'function') {
      for (i = 0; i < siteMarks.length; i++) {
        var mark = siteMarks[i];
        for (j = 0; j < mark.rings.length; j++) {
          renderer.drawGroundDecal(mark.pos, mark.rings[j].radius, mark.rings[j].color);
        }
      }
    }
  }

  /* ======================================================================
   * 14. init
   * ==================================================================== */
  function init(game) {
    if (built) return world;
    world.game = game || null;
    buildGrid();
    buildFloorCollider();
    buildWallBoxes();
    buildWallFaces();
    buildProps();
    buildParapets();
    buildFloorMesh();
    buildSiteMarkings();
    buildSpawns();
    buildZones();
    flushAllMeshes();
    buildBroadphase();
    buildNav();
    built = true;
    world.ready = true;
    world.stats = {
      boxes: world.boxes.length,
      walls: world.boxes.length - propBoxes.length,
      props: propBoxes.length,
      verts: meshStats.verts,
      tris: meshStats.tris,
      meshes: world.meshes.length,
      navCells: NAV.w * NAV.h,
      walkableCells: NAV.list.length
    };
    return world;
  }

  /* Debug views for the self-test page / node tests (read only). */
  world.grid = {
    w: GW, h: GH, cell: GRID,
    solid: function () { return gridSolid; },
    height: wallHeightAt,
    kind: wallKindIndex
  };
  world.navGrid = {
    getWidth: function () { return NAV.w; },
    getHeight: function () { return NAV.h; },
    getCell: function () { return NAV_CELL; },
    walkable: function () { return NAV.walk; }
  };
})();
