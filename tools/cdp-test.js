/* CDP-driven integration test for DUST STRIKE.
 * Usage: node tools/cdp-test.js "<query>" <outPng> <waitMs> <actions>
 *   query   e.g. "?auto=1&live=1"
 *   outPng  e.g. "shots/cdp.png"
 *   waitMs  real milliseconds to let the game run before screenshot
 *   actions comma list: move,shoot,strafe,look
 * Prints a JSON report with game state, errors and renderer stats.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const query = process.argv[2] || '?auto=1&live=1';
  const outPng = process.argv[3] || 'shots/cdp.png';
  const waitMs = parseInt(process.argv[4] || '6000', 10);
  const actions = (process.argv[5] || 'move,shoot').split(',').filter(Boolean);
  const W = parseInt(process.argv[6] || '1280', 10);
  const H = parseInt(process.argv[7] || '720', 10);

  const userDataDir = path.join(os.tmpdir(), 'dsh-cdp-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });
  const url = 'file:///' + (ROOT + '/index.html').replace(/\\/g, '/') + query;

  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=0', '--user-data-dir=' + userDataDir,
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--window-size=' + W + ',' + H, 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeStderr = '';
  chrome.stderr.on('data', (d) => { chromeStderr += d.toString(); });

  let port = 0;
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 120; i++) {
    if (fs.existsSync(portFile)) {
      const lines = fs.readFileSync(portFile, 'utf8').split('\n');
      if (lines[0]) { port = parseInt(lines[0], 10); break; }
    }
    await sleep(100);
  }
  if (!port) throw new Error('Chrome DevTools port not found:\n' + chromeStderr);

  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  let msgId = 0;
  const pending = new Map();
  const exceptions = [];
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      exceptions.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      exceptions.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result ? r.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(1200);

  /* wait for the game loop to actually run */
  let frames = 0;
  for (let i = 0; i < 100; i++) {
    frames = await evaluate('window.__DSH_GAME__ ? window.__DSH_GAME__.frame : -1');
    if (frames > 5) break;
    await sleep(150);
  }
  const bootErrors = await evaluate('JSON.stringify(window.__ERRORS__ || [])');

  /* dispatch helpers (real DOM events through CDP) */
  const keyDown = (code, key, vk) => send('Input.dispatchKeyEvent', {
    type: 'keyDown', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
  });
  const keyUp = (code, key, vk) => send('Input.dispatchKeyEvent', {
    type: 'keyUp', code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
  });
  async function holdKey(code, key, vk, ms) {
    await keyDown(code, key, vk);
    await sleep(ms);
    await keyUp(code, key, vk);
  }
  async function pressMouse(ms) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: W / 2, y: H / 2, button: 'left', clickCount: 1 });
    await sleep(ms);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: W / 2, y: H / 2, button: 'left', clickCount: 1 });
  }

  /* action script: spread over the wait window */
  const t0 = Date.now();
  const remaining = () => Math.max(0, waitMs - (Date.now() - t0));
  for (const act of actions) {
    if (remaining() <= 0) break;
    if (act === 'move') { await holdKey('KeyW', 'w', 87, Math.min(1400, remaining())); }
    else if (act === 'strafe') { await holdKey('KeyD', 'd', 68, Math.min(600, remaining())); }
    else if (act === 'shoot') {
      /* aim a bit down/up randomly via direct player angle (test-only) + click */
      await evaluate('(function(){var g=window.__DSH_GAME__;if(g&&g.player){g.player.pitch=0.02;}})()');
      await pressMouse(200);
      await sleep(150);
      await pressMouse(120);
    } else if (act === 'look') {
      await evaluate('(function(){var g=window.__DSH_GAME__;if(g&&g.player){g.player.yaw+=0.35;}})()');
      await sleep(200);
    } else if (act === 'buy') {
      await evaluate('(function(){var g=window.__DSH_GAME__;if(g&&g.rules&&g.rules.state.canBuy){return g.rules.buy(g,"ak47");}return "cannot buy";})()');
    } else if (act === 'start') {
      const rectStr = await evaluate(`(function(){
        var bs = [].slice.call(document.querySelectorAll('button, [role="button"], .ds-btn'));
        var b = bs.filter(function(x){ return /进入游戏|开始游戏|start/i.test(x.textContent || ''); })[0];
        if (!b) return null;
        var r = b.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`);
      if (!rectStr) { console.log('START: button not found'); }
      else {
        const rect = JSON.parse(rectStr);
        console.log('START_CLICK ' + JSON.stringify(rect));
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
        await sleep(50);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await sleep(60);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await sleep(1500);
        console.log('START_STATE ' + await evaluate('(function(){var g=window.__DSH_GAME__;return JSON.stringify({started:g.started,paused:g.paused,locked:g.input.locked,phase:g.rules.state.phase,blocked:g.hud.isBlockingInput(),frozen:g.frozen});})()'));
      }
    } else if (act === 'jump') {
      await keyDown('Space', ' ', 32);
      await sleep(180);
      console.log('JUMP ' + await evaluate('(function(){var g=window.__DSH_GAME__;return JSON.stringify({y:+g.player.pos[1].toFixed(2), eye:+(g.player.eye?g.player.eye()[1]:0).toFixed(2), vy:g.player.vel?+g.player.vel[1].toFixed(2):null});})()'));
      await keyUp('Space', ' ', 32);
      await sleep(700);
      console.log('LAND ' + await evaluate('(function(){var g=window.__DSH_GAME__;return JSON.stringify({y:+g.player.pos[1].toFixed(2), onGround:g.player.onGround});})()'));
    } else if (act === 'crouch') {
      await keyDown('ControlLeft', 'Control', 17);
      await sleep(500);
      console.log('CROUCH ' + await evaluate('(function(){var g=window.__DSH_GAME__;return JSON.stringify({eye:+(g.player.eye?g.player.eye()[1]:0).toFixed(2), crouching:g.player.crouching});})()'));
      await keyUp('ControlLeft', 'Control', 17);
      await sleep(400);
    } else if (act === 'restart') {
      await evaluate('(function(){var g=window.__DSH_GAME__; if(g&&g.callbacks&&g.callbacks.restart) g.callbacks.restart(); return "restart";})()');
      await sleep(800);
    } else if (act === 'reload') {
      await holdKey('KeyR', 'r', 82, 80);
      await sleep(1800);
    } else if (act === 'switch2') { await holdKey('Digit2', '2', 50, 80); }
    else if (act === 'switch3') { await holdKey('Digit3', '3', 51, 80); }
    else if (act === 'buyawp') {
      const r = await evaluate(`(function(){
        var g=window.__DSH_GAME__; if(!g||!g.rules) return 'no game';
        g.rules.state.money = 9000;
        return JSON.stringify(g.rules.buy(g, 'awp'));
      })()`);
      console.log('BUYAWP ' + r);
      await sleep(900);
    } else if (act === 'scope') {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: W / 2, y: H / 2, button: 'right', clickCount: 1 });
      await sleep(80);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: W / 2, y: H / 2, button: 'right', clickCount: 1 });
      await sleep(500);
      console.log('SCOPE_STATE ' + await evaluate('(function(){var g=window.__DSH_GAME__;return JSON.stringify({scoped:g.player.scoped,fov:g.player.fov});})()'));
    } else if (act === 'buyak') {
      const r = await evaluate(`(function(){
        var g=window.__DSH_GAME__; if(!g||!g.rules) return 'no game';
        g.rules.state.money = 9000;
        var res = g.rules.buy(g, 'ak47');
        return JSON.stringify(res);
      })()`);
      console.log('BUYAK ' + r);
      await sleep(200);
    } else if (act === 'buykey') {
      await holdKey('KeyB', 'b', 66, 90);
      await sleep(900);
      console.log('BUYKEY ' + await evaluate('(function(){var g=window.__DSH_GAME__;return JSON.stringify({open:g.hud.isBuyMenuOpen(),blocked:g.hud.isBlockingInput(),paused:g.paused});})()'));
    } else if (act === 'esc') {
      await holdKey('Escape', 'Escape', 27, 90);
      await sleep(700);
      console.log('ESC ' + await evaluate('(function(){var g=window.__DSH_GAME__;return JSON.stringify({blocked:g.hud.isBlockingInput(),paused:g.paused});})()'));
    } else if (act === 'pause') {
      await evaluate('(function(){var g=window.__DSH_GAME__; if(g&&g.callbacks&&g.callbacks.requestPause) g.callbacks.requestPause(); return "pause";})()');
      await sleep(900);
      console.log('PAUSE ' + await evaluate('(function(){var g=window.__DSH_GAME__;return JSON.stringify({blocked:g.hud.isBlockingInput(),paused:g.paused});})()'));
    } else if (act === 'none') {
      await sleep(200);
    } else if (act === 'winround') {
      const r = await evaluate(`(function(){
        var g=window.__DSH_GAME__; if(!g||!g.weapons&&!window.CS.weapons) return 'no game';
        var killed=0;
        (g.bots||[]).forEach(function(b){
          if(b.team==='t' && b.alive){ window.CS.weapons.hit(g, b, 500, g.player, 'ak47', 'body', [b.pos[0],1.2,b.pos[2]]); killed++; }
        });
        var st=g.rules.state;
        return JSON.stringify({killed:killed, aliveT:(g.bots||[]).filter(function(b){return b.team==='t'&&b.alive;}).length});
      })()`);
      console.log('WINROUND ' + r);
      await sleep(1500);
      console.log('AFTER_WIN ' + await evaluate('(function(){var g=window.__DSH_GAME__;var st=g.rules.state;return JSON.stringify({phase:st.phase,score:st.score,money:st.money,winner:st.winner,reason:st.reason,matchWinner:st.matchWinner,round:st.round});})()'));
    } else if (act === 'matchpoint') {
      await evaluate('(function(){var g=window.__DSH_GAME__;g.rules.state.score.ct=7;return "matchpoint";})()');
      console.log('MATCHPOINT set');
    } else if (act === 'combat') {
      const r = await evaluate(`(function(){
        var g=window.__DSH_GAME__; if(!g||!g.player) return 'no game';
        var p=g.player; var best=null, bd=1e9;
        (g.bots||[]).forEach(function(b){ if(b.alive && b.team==='t'){ var d=Math.hypot(b.pos[0]-p.pos[0], b.pos[2]-p.pos[2]); if(d<bd){bd=d;best=b;} }});
        if(!best) return 'no enemy';
        p.alive=true; p.health=100; if(p.armor===undefined) p.armor=0;
        p.pos[0]=best.pos[0]; p.pos[1]=0; p.pos[2]=best.pos[2]+4.5;
        p.vel=[0,0,0];
        var dx=best.pos[0]-p.pos[0], dz=best.pos[2]-p.pos[2];
        p.yaw=Math.atan2(dx,-dz);
        p.pitch=Math.atan2(1.15-1.62, Math.hypot(dx,dz));
        window.__TESTTARGET__=best.name;
        return JSON.stringify({target:best.name, dist:+bd.toFixed(1), yaw:+p.yaw.toFixed(2), pitch:+p.pitch.toFixed(3)});
      })()`);
      console.log('COMBAT ' + r);
      await sleep(300);
      for (let i = 0; i < 3; i++) { await pressMouse(120); await sleep(160); }
      const after = await evaluate(`(function(){
        var g=window.__DSH_GAME__; if(!g) return 'no game';
        var t=(g.bots||[]).filter(function(b){return b.name===window.__TESTTARGET__;})[0];
        return JSON.stringify({target:window.__TESTTARGET__, targetAlive:t?!!t.alive:null, targetHp:t?Math.round(t.health):null,
          playerKills:g.player?g.player.kills:null, mag:g.player&&g.player.ammo?g.player.ammo[Object.keys(g.player.ammo)[0]]:null});
      })()`);
      console.log('COMBAT_AFTER ' + after);
    }
  }
  if (remaining() > 0) await sleep(remaining());

  const report = await evaluate(`(function(){
    var g = window.__DSH_GAME__ || {};
    var st = (g.rules && g.rules.state) || {};
    function r3(v){ return v ? [Math.round(v[0]*100)/100, Math.round(v[1]*100)/100, Math.round(v[2]*100)/100] : null; }
    var bots = (g.bots || []).map(function(b){ return { n:b.name, t:b.team, alive:!!b.alive, hp:Math.round(b.health||0), st:b.state||'', pos:r3(b.pos), k:b.kills||0 }; });
    var alive = { ct: 0, t: 0 };
    bots.forEach(function(b){ if(b.alive) alive[b.t]++; });
    if (g.player && g.player.alive) alive.ct++;
    return JSON.stringify({
      ok: (window.__ERRORS__ || []).length === 0,
      errors: (window.__ERRORS__ || []).slice(0,10),
      time: g.time ? +g.time.toFixed(2) : 0,
      frame: g.frame,
      active: g.active, started: g.started, paused: g.paused, frozen: g.frozen,
      phase: st.phase, round: st.round, score: st.score, money: st.money, roundLeft: st.roundTimeLeft,
      alive: alive,
      player: g.player ? { alive:!!g.player.alive, hp:Math.round(g.player.health||0), armor:Math.round(g.player.armor||0),
        pos:r3(g.player.pos), yaw:+(g.player.yaw||0).toFixed(2), weapon:g.player.current,
        kills:g.player.kills||0, deaths:g.player.deaths||0, spread:g.player.crosshairSpread,
        loadout:g.player.loadout||null,
        def: (function(){ try { var d=g.player.currentDef?g.player.currentDef():null; return d?d.id:null; } catch(e){return null;} })(),
        ammo:g.player.ammo||null } : null,
      bots: bots,
      renderer: g.renderer && g.renderer.stats ? g.renderer.stats : null
    });
  })()`);

  fs.mkdirSync(path.dirname(path.join(ROOT, outPng)), { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(ROOT, outPng), Buffer.from(shot.data, 'base64'));

  let finalErrors = exceptions.slice();
  try { finalErrors = finalErrors.concat(await evaluate('window.__ERRORS__ || []')); } catch (e) {}
  const verdict = { bootErrors: JSON.parse(bootErrors || '[]'), runtimeExceptions: exceptions.slice(0, 10), errors: finalErrors.slice(0, 10) };

  console.log('REPORT ' + (report || 'null'));
  console.log('VERDICT ' + JSON.stringify(verdict));
  console.log('SHOT ' + outPng + ' ' + fs.statSync(path.join(ROOT, outPng)).size + ' bytes');

  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  await sleep(300);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
}

main().then(() => process.exit(0)).catch((e) => { console.error('CDP TEST FAILED:', e && e.stack || e); process.exit(1); });
