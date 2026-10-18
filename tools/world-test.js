/* Node self-test for js/world.js (run: node tools/world-test.js)
 * Loads math.js + world.js in a stubbed browser-ish global, then checks:
 * geometry buffers, spawns/zones walkability + reachability, A* success rate,
 * moveEntity stress (no wall penetration / no falling out), raycast, los.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
global.window = global;

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/math.js'), 'utf8'), { filename: 'js/math.js' });

const created = [];
global.CS.gl = {
  createMesh(vertices, indices, tex) {
    created.push({ vertices, indices, tex });
    return { vbo: null, ibo: null, count: indices.length, tris: indices.length / 3, texName: tex };
  }
};

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/world.js'), 'utf8'), { filename: 'js/world.js' });
const CS = global.CS;
const W = CS.world;

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}${extra ? '  [' + extra + ']' : ''}`);
  else { fails++; console.log(`  FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

const t0 = Date.now();
W.init({ world: null });
const initMs = Date.now() - t0;
console.log(`init: ${initMs} ms`);

/* ---------------------------------------------------------------- geometry */
section('geometry / meshes');
check('world.name', W.name === 'Dust Strike', W.name);
check('meshes created', created.length > 4, created.length + ' meshes');
let totalVerts = 0, totalTris = 0, strideOK = true, indexOK = true, windingStats = [];
for (const m of created) {
  const nv = m.vertices.length / 8;
  totalVerts += nv;
  totalTris += m.indices.length / 3;
  if (m.vertices.length % 8 !== 0) strideOK = false;
  if (nv > 65535) indexOK = false;
  if (m.indices.length % 3 !== 0) indexOK = false;
  for (const i of m.indices) if (i >= nv) { indexOK = false; break; }
  // normal length check
  for (let v = 0; v < nv; v++) {
    const p = v * 8;
    const nx = m.vertices[p + 3], ny = m.vertices[p + 4], nz = m.vertices[p + 5];
    const l = Math.hypot(nx, ny, nz);
    if (l < 0.99 || l > 1.01) { strideOK = false; }
  }
  check(`mesh ${m.tex}: verts=${nv} tris=${m.indices.length / 3}`, nv > 0 && m.indices.length > 0);
}
check('stride 8 / unit normals', strideOK);
check('16-bit indices valid', indexOK);
check('triangles < 20000', totalTris < 20000, totalTris + ' tris / ' + totalVerts + ' verts');
check('floor collider exists', W.boxes.some(b => b.kind === 'floor' && b.floor));
check('collision boxes count', W.boxes.length > 50, W.boxes.length + ' boxes');
check('world.stats', !!W.stats && W.stats.tris === totalTris, JSON.stringify(W.stats));
// box corners sane, min<=max
let boxesOK = true;
for (const b of W.boxes) {
  for (let a = 0; a < 3; a++) if (!(b.min[a] <= b.max[a])) boxesOK = false;
}
check('all box min<=max', boxesOK);

/* ---------------------------------------------------------------- data */
section('spawns / zones / sites');
function insideAnyBox(x, y, z, r, h) {
  for (const b of W.boxes) {
    if (b.floor) continue;
    if (x + r <= b.min[0] || x - r >= b.max[0]) continue;
    if (z + r <= b.min[2] || z - r >= b.max[2]) continue;
    if (y + h <= b.min[1] || y >= b.max[1]) continue;
    return true;
  }
  return false;
}
check('5 CT spawns', W.spawns.ct.length === 5);
check('5 T spawns', W.spawns.t.length === 5);
let spawnOK = true;
for (const team of ['ct', 't']) {
  W.spawns[team].forEach((s, i) => {
    const ok = W.nav.isWalkable(s.pos[0], s.pos[2]) && !insideAnyBox(s.pos[0], 0, s.pos[2], 0.32, 1.8);
    if (!ok) { spawnOK = false; console.log(`    bad spawn ${team}[${i}] at ${s.pos}`); }
    if (Math.abs(s.pos[1]) > 1e-9) spawnOK = false;
    const near = W.nav.nearestWalkable(s.pos[0], s.pos[2]);
    if (Math.hypot(near[0] - s.pos[0], near[1] - s.pos[2]) > 0.75) {
      spawnOK = false;
      console.log(`    spawn ${team}[${i}] far from nav cell: ${near}`);
    }
  });
}
check('spawns walkable / clear', spawnOK);
check('spawn yaws finite', W.spawns.ct.concat(W.spawns.t).every(s => Number.isFinite(s.yaw)));

const ZONE_NAMES = ['tSpawn', 'ctSpawn', 'mid', 'siteA', 'siteB', 'longA', 'longB', 'tunnels'];
let zonesOK = true;
for (const name of ZONE_NAMES) {
  const z = W.zones[name];
  if (!z || !z.points || z.points.length < 3) { zonesOK = false; console.log('    missing zone ' + name); continue; }
  for (const p of z.points) {
    if (!W.nav.isWalkable(p[0], p[1]) || insideAnyBox(p[0], 0, p[1], 0.32, 1.8)) {
      zonesOK = false;
      console.log(`    zone ${name} point not walkable: ${p}`);
    }
  }
}
check('zone polygon points walkable', zonesOK);
check('sites centers', W.sites.A.center[0] === -17 && W.sites.A.center[1] === -6 &&
  W.sites.B.center[0] === 17 && W.sites.B.center[1] === -4 && W.sites.A.radius === 5);
check('inZone works', W.inZone('siteA', -17, -6) && !W.inZone('siteA', 17, -4));

/* ------------------------------------------------------- nav connectivity */
section('nav grid / connectivity');
const NW = W.navGrid.getWidth(), NH = W.navGrid.getHeight();
const walk = W.navGrid.walkable();
const cell = W.navGrid.getCell();
function navIndexFromXZ(x, z) {
  let i = Math.floor((x - (-32)) / cell), j = Math.floor((z - (-34)) / cell);
  i = Math.max(0, Math.min(NW - 1, i));
  j = Math.max(0, Math.min(NH - 1, j));
  return [i, j];
}
function navCenter(i, j) { return [-32 + (i + 0.5) * cell, -34 + (j + 0.5) * cell]; }
let walkableCount = 0;
for (let k = 0; k < walk.length; k++) if (walk[k]) walkableCount++;
check('nav grid size', NW > 80 && NH > 80 && cell === 0.75, `${NW}x${NH} cell=${cell}`);
check('walkable cells sane', walkableCount > 800 && walkableCount < NW * NH, walkableCount + ' cells');
// BFS components
const comp = new Int32Array(NW * NH).fill(-1);
let comps = 0;
const compSize = [];
for (let j = 0; j < NH; j++) {
  for (let i = 0; i < NW; i++) {
    const idx = j * NW + i;
    if (!walk[idx] || comp[idx] >= 0) continue;
    const queue = [idx];
    comp[idx] = comps;
    let size = 0;
    while (queue.length) {
      const cur = queue.pop();
      size++;
      const ci = cur % NW, cj = (cur - ci) / NW;
      const nbs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
      for (const [di, dj] of nbs) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= NW || nj >= NH) continue;
        const nidx = nj * NW + ni;
        if (!walk[nidx] || comp[nidx] >= 0) continue;
        if (di && dj) {
          if (!walk[cj * NW + ni] || !walk[nj * NW + ci]) continue;
        }
        comp[nidx] = comps;
        queue.push(nidx);
      }
    }
    compSize.push(size);
    comps++;
  }
}
compSize.sort((a, b) => b - a);
check('single walkable component (pockets ignored)', comps <= 6 && compSize[0] > 0.9 * walkableCount,
  `${comps} comps, sizes=${compSize.slice(0, 8).join(',')}`);
const mainComp = comp[Math.max(0, navIndexFromXZ(0, -27)[1] * NW + navIndexFromXZ(0, -27)[0])];
const bigComp = compSize[0] === comp[0] ? comp[0] : comps; // fallback
function mainCompOf(idx) { return comp[idx]; }
// find component id of the largest component
const compBySize = [];
for (let c = 0; c < comps; c++) compBySize.push({ c, size: 0 });
for (let k = 0; k < walk.length; k++) if (walk[k] && comp[k] >= 0) compBySize[comp[k]].size++;
compBySize.sort((a, b) => b.size - a.size);
const biggest = compBySize[0].c;
function navIndexFor(x, z) { const [i, j] = navIndexFromXZ(x, z); return j * NW + i; }
let zonesReach = true;
for (const name of ZONE_NAMES) {
  for (const p of W.zones[name].points) {
    const nw = W.nav.nearestWalkable(p[0], p[1]);
    if (comp[navIndexFor(nw[0], nw[1])] !== biggest) {
      zonesReach = false;
      console.log(`    zone ${name} point disconnected: ${p} (nearest ${nw})`);
    }
  }
}
for (const team of ['ct', 't']) {
  for (const s of W.spawns[team]) {
    const nw = W.nav.nearestWalkable(s.pos[0], s.pos[2]);
    if (comp[navIndexFor(nw[0], nw[1])] !== biggest) {
      zonesReach = false;
      console.log(`    spawn disconnected ${team} ${s.pos}`);
    }
  }
}
check('spawns + zones in main component', zonesReach);

/* ------------------------------------------------------------ path tests */
section('findPath');
const walkList = [];
for (let j = 0; j < NH; j++) for (let i = 0; i < NW; i++) {
  if (walk[j * NW + i] && comp[j * NW + i] === biggest) walkList.push([i, j]);
}
function rndPoint() {
  const [i, j] = walkList[(Math.random() * walkList.length) | 0];
  return navCenter(i, j);
}
// specific path checks
const routes = [
  ['ctSpawn -> siteA', [-6, -26], [-17, -8]],
  ['ctSpawn -> siteB', [6, -26], [18, -6]],
  ['tSpawn -> siteA', [0, 28], [-18, -8]],
  ['tSpawn -> siteB', [0, 28], [18, -6]],
  ['tSpawn -> ctSpawn (mid)', [0, 28], [0, -28]],
  ['longA -> A', [-25, 24], [-20, -10]],
  ['longB -> B', [25, 24], [20, -10]],
  ['tunnels -> mid', [10, 12], [0, 8]]
];
// validate that a path is walkable end-to-end by sampling
function pathWalkable(p) {
  for (let s = 0; s < p.length - 1; s++) {
    const L = Math.hypot(p[s + 1][0] - p[s][0], p[s + 1][1] - p[s][1]);
    const n = Math.max(1, Math.ceil(L / 0.2));
    for (let q = 0; q <= n; q++) {
      const t = q / n;
      const x = p[s][0] + (p[s + 1][0] - p[s][0]) * t;
      const z = p[s][1] + (p[s + 1][1] - p[s][1]) * t;
      if (!W.nav.isWalkable(x, z)) return { x, z, s };
    }
  }
  return null;
}
let routeOK = 0;
for (const [label, a, b] of routes) {
  const p = W.nav.findPath(a[0], a[1], b[0], b[1]);
  let ok = !!p && p.length >= 2;
  let why = p ? p.length + ' pts' : 'null';
  if (ok) {
    const last = p[p.length - 1];
    if (Math.hypot(last[0] - b[0], last[1] - b[1]) > 1.0) { ok = false; why = 'bad end ' + last; }
    const bad = pathWalkable(p);
    if (bad) { ok = false; why = `blocked at ${bad.x.toFixed(2)},${bad.z.toFixed(2)} seg ${bad.s}`; }
  }
  if (ok) routeOK++;
  check(label, ok, why);
}
// random pairs
const NPAIR = 500;
let pathSuccess = 0, pathLenSum = 0, pathInvalid = 0, pathBlocked = 0;
const tPath = Date.now();
let nullShown = 0;
for (let n = 0; n < NPAIR; n++) {
  const a = rndPoint(), b = rndPoint();
  const p = W.nav.findPath(a[0], a[1], b[0], b[1]);
  if (!p || p.length < 2) {
    if (nullShown < 4) { nullShown++; console.log('    NULL path', a, '->', b); }
    continue;
  }
  pathSuccess++;
  pathLenSum += p.length;
  const last = p[p.length - 1];
  if (Math.hypot(last[0] - b[0], last[1] - b[1]) > 1.0) pathInvalid++;
  if (pathWalkable(p)) pathBlocked++;
}
const pathMs = Date.now() - tPath;
console.log(`  ${NPAIR} random pairs: ${pathSuccess} paths (${(pathSuccess / NPAIR * 100).toFixed(1)}%), ` +
  `${(pathLenSum / Math.max(1, pathSuccess)).toFixed(1)} pts avg, ${pathMs} ms total (${(pathMs / NPAIR).toFixed(2)} ms/path)`);
check('random pair path success >= 95%', pathSuccess / NPAIR >= 0.95, `${pathSuccess}/${NPAIR}`);
check('random paths end at destination', pathInvalid === 0, pathInvalid + ' invalid');
check('random paths collision free', pathBlocked === 0, pathBlocked + ' blocked');

/* ------------------------------------------------------------- moveEntity */
section('moveEntity stress');
function overlapsBoxes(p, r, h) {
  for (const b of W.boxes) {
    if (b.floor) continue;
    if (p[0] + r * 0.98 <= b.min[0] || p[0] - r * 0.98 >= b.max[0]) continue;
    if (p[2] + r * 0.98 <= b.min[2] || p[2] - r * 0.98 >= b.max[2]) continue;
    if (p[1] + h * 0.98 <= b.min[1] || p[1] + 0.02 >= b.max[1]) continue;
    return b;
  }
  return null;
}
let stressFail = 0, stressSteps = 0, outOfBounds = 0, penetrate = 0, maxPen = 0;
let p = [W.spawns.ct[0].pos[0], 0, W.spawns.ct[0].pos[2]];
let vy = 0;
let dirAng = Math.random() * Math.PI * 2;
for (let n = 0; n < 2000; n++) {
  if (n % 45 === 0) dirAng = Math.random() * Math.PI * 2;
  const speed = 5.2 / 60;
  vy -= 16 / 60;
  const delta = [Math.cos(dirAng) * speed, vy / 60, Math.sin(dirAng) * speed];
  const res = W.moveEntity(p, delta, 0.32, 1.8);
  p = res.pos;
  stressSteps++;
  if (res.onGround) vy = 0;
  if (p[0] < -32 || p[0] > 32 || p[2] < -34 || p[2] > 34 || p[1] < -0.001 || p[1] > 5) outOfBounds++;
  const pen = overlapsBoxes(p, 0.32, 1.8);
  if (pen) {
    penetrate++;
    const d = Math.min(
      Math.abs(p[0] - pen.min[0]), Math.abs(p[0] - pen.max[0]),
      Math.abs(p[2] - pen.min[2]), Math.abs(p[2] - pen.max[2]));
    if (d > maxPen) maxPen = d;
  }
}
check('2000 random steps: no out of bounds', outOfBounds === 0, outOfBounds);
check('2000 random steps: no wall penetration', penetrate === 0, `${penetrate} frames, maxPen=${maxPen.toFixed(3)}`);
// wall-push test: walk straight into the mid west wall
p = [0, 0, 10];
let hitWall = false, finalX = 0;
for (let n = 0; n < 200; n++) {
  const res = W.moveEntity(p, [-5.2 / 60, 0, 0], 0.32, 1.8);
  p = res.pos;
  if (res.hitWall) hitWall = true;
  finalX = p[0];
}
check('walking into wall clamps at x=-3+radius', hitWall && Math.abs(finalX - (-3 + 0.32)) < 0.05, `x=${finalX.toFixed(3)}`);
// sliding: diagonal into wall slides along it
p = [0, 0, 10];
let zStart = p[2];
for (let n = 0; n < 120; n++) {
  const res = W.moveEntity(p, [-5.2 / 60, 0, 1.0 / 60], 0.32, 1.8);
  p = res.pos;
}
check('wall sliding works', hitWall && p[2] > zStart + 1.5, `z ${zStart} -> ${p[2].toFixed(2)}`);
// drop onto low crate: crate at (-22.2..-20.6, -8.6..-8.0) h=0.7
p = [-21.4, 1.4, -8.3];
let onCrate = false;
for (let n = 0; n < 120; n++) {
  const res = W.moveEntity(p, [0, -0.1, 0], 0.32, 1.8);
  p = res.pos;
  if (res.onGround) { onCrate = Math.abs(p[1] - 0.7) < 0.02; break; }
}
check('can land on 0.7m crate top', onCrate, `pos=${p.map(v => v.toFixed(2)).join(',')}`);
// jump forward onto the same crate (jump apex 0.85 > crate 0.7); walk at 3 m/s
p = [-21.4, 0, -9.8];
vy = 5.2;
let jumpOn = false;
for (let n = 0; n < 200; n++) {
  vy -= 16 / 60;
  const res = W.moveEntity(p, [0, vy / 60, 3.0 / 60], 0.32, 1.8);
  p = res.pos;
  if (res.onGround) {
    if (Math.abs(p[1] - 0.7) < 0.02) { jumpOn = true; break; }
    vy = 5.2;
  }
}
check('can jump forward onto 0.7m crate', jumpOn, `pos=${p.map(v => v.toFixed(2)).join(',')}`);
// ceiling: jump under the mid door lintel (bottom 2.35)
p = [0, 0, 0];
vy = 5.2;
let hitCeil = false;
for (let n = 0; n < 80; n++) {
  vy -= 16 / 60;
  const res = W.moveEntity(p, [0, vy / 60, 0], 0.32, 1.8);
  p = res.pos;
  if (res.hitCeil) { hitCeil = true; break; }
  if (res.onGround) vy = 5.2;
}
check('jumping under lintel hits ceiling', hitCeil, `y=${p[1].toFixed(2)}`);

/* ------------------------------------------------------- raycast / los */
section('raycast / los');
let hit = W.raycast([0, 1.62, 10], [1, 0, 0], 100);
check('raycast +x hits mid east wall near x=3', !!hit && Math.abs(hit.point[0] - 3) < 0.02 &&
  Math.abs(hit.normal[0] + 1) < 1e-6, hit ? `dist=${hit.dist.toFixed(2)} n=[${hit.normal}]` : 'null');
hit = W.raycast([0, 1.62, 10], [0, -1, 0], 10);
check('raycast down hits floor', !!hit && Math.abs(hit.point[1]) < 1e-6 && Math.abs(hit.normal[1] - 1) < 1e-6,
  hit ? `dist=${hit.dist.toFixed(2)} n=[${hit.normal}]` : 'null');
hit = W.raycast([-10, 1.62, 26], [-1, 0, 0], 100);
check('raycast hits far wall', !!hit && hit.dist > 1, hit ? `dist=${hit.dist.toFixed(2)}` : 'null');
hit = W.raycast([0, 1.62, 10], [1, 0, 0], 1);
check('raycast respects maxDist', hit === null);
const eyeCT = [0, 1.62, -27], eyeT = [0, 1.62, 27];
check('mid is a straight corridor: CT eye -> T eye clear down mid', W.los(eyeCT, eyeT) === true);
check('los within same room clear', W.los([-6, 1.62, -24], [-2, 1.62, -24]) === true);
check('los through mid doors clear', W.los([0, 1.62, 6], [0, 1.62, -6]) === true);
check('los blocked by CT spawn side wall', W.los([-6, 1.62, -27], [-6, 1.62, -15]) === false);
check('los blocked by mid-door pillar', W.los([2, 1.62, 2], [2, 1.62, -2]) === false);
check('los blocked by long A hull wall', W.los([-30, 1.62, 10], [-20, 1.62, 10]) === false);
check('los over a 1.1m low wall at eye height is clear',
  W.los([-20, 1.62, -14], [-20, 1.62, -10]) === true); // A-site low wall (h1.15) between them
check('los blocked by A site low wall at crouch eye height',
  W.los([-20, 0.9, -14], [-20, 0.9, -10]) === false);

/* ------------------------------------------------------------ helpers */
section('nav helpers');
const rp = W.nav.randomPoint();
check('randomPoint walkable', !!rp && W.nav.isWalkable(rp[0], rp[1]), rp ? rp.map(v => v.toFixed(1)).join(',') : 'null');
let zoneRandOK = true;
for (const name of ZONE_NAMES) {
  for (let n = 0; n < 15; n++) {
    const pt = W.nav.randomPointInZone(name);
    if (!pt || !W.nav.isWalkable(pt[0], pt[1]) || !W.inZone(name, pt[0], pt[1])) {
      zoneRandOK = false;
      console.log(`    randomPointInZone(${name}) bad: ${pt}`);
      break;
    }
  }
}
check('randomPointInZone all zones walkable + inside', zoneRandOK);
const nw = W.nav.nearestWalkable(0, 0);
check('nearestWalkable returns walkable', W.nav.isWalkable(nw[0], nw[1]), nw.map(v => v.toFixed(1)).join(','));
const nwOutside = W.nav.nearestWalkable(-31.5, 0); // deep inside west wall
check('nearestWalkable from inside wall', W.nav.isWalkable(nwOutside[0], nwOutside[1]) &&
  Math.hypot(nwOutside[0] + 31.5, nwOutside[1]) < 8, nwOutside.map(v => v.toFixed(1)).join(','));

/* ------------------------------------------------------------- render stub */
section('render');
let drawMeshCalls = 0, drawBoxCalls = 0, drawDecalCalls = 0;
const fakeRenderer = {
  drawMesh() { drawMeshCalls++; },
  drawBox() { drawBoxCalls++; },
  drawGroundDecal() { drawDecalCalls++; }
};
W.render(fakeRenderer);
check('render draws all static meshes', drawMeshCalls === created.length, drawMeshCalls + '/' + created.length);
check('render draws two site rings per site', drawDecalCalls === 4 && drawBoxCalls === 0,
  `box=${drawBoxCalls} decal=${drawDecalCalls}`);

/* --------------------------------------------------------------- ASCII map */
section('ASCII map (top view, 2x2 cell blocks: # wall, . walkable, C crate, A/B site)');
const ascii = [];
const GW = W.grid.w, GH = W.grid.h;
for (let bj = 0; bj < GH; bj += 2) {
  let row = '';
  for (let bi = 0; bi < GW; bi += 2) {
    const solid = W.grid.solid()[(bj + 1) * GW + (bi + 1)];
    const x = -32 + bi + 1.5, z = -34 + bj + 1.5;
    let ch = solid ? '#' : '.';
    if (!solid) {
      for (const b of W.boxes) {
        if (b.floor) continue;
        if (x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2]) { ch = b.kind === 'crate' ? 'C' : '%'; break; }
      }
      if (W.inZone('siteA', x, z)) ch = 'A';
      if (W.inZone('siteB', x, z)) ch = 'B';
      if (W.spawns.ct.some(s => Math.hypot(s.pos[0] - x, s.pos[2] - z) < 2.2)) ch = 'c';
      if (W.spawns.t.some(s => Math.hypot(s.pos[0] - x, s.pos[2] - z) < 2.2)) ch = 't';
    }
    row += ch;
  }
  ascii.push(row);
}
console.log('    ' + '-'.repeat(GW / 2 + 2));
ascii.forEach((r, k) => console.log(String(k * 2).padStart(3, ' ') + ' ' + r));
console.log('    ' + '-'.repeat(GW / 2 + 2));

/* ---------------------------------------------------------------- summary */
console.log('\n=========================================');
console.log(`total triangles: ${totalTris}, vertices: ${totalVerts}, boxes: ${W.boxes.length}`);
console.log(`nav: ${walkableCount}/${NW * NH} walkable cells, ${comps} components`);
console.log(fails === 0 ? 'ALL CHECKS PASSED' : `${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
