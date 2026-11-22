/* Fruit Slash — game logic + browser game (classic script, no imports).
   Pure logic is exported for the Node unit harness (module.exports guard at
   the end); all DOM/canvas code is guarded by `typeof document`. */
(function () {
  'use strict';

  /* ============================== config ============================== */
  // Single speed-threshold setting (PRD §3): the fingertip must move faster
  // than this (canvas px per second, scaled to the smaller screen side)
  // for a swipe to count as a slash. 0.7 = a firm swipe, not a lightning
  // flick — but a slow touch or resting finger (~0-200 px/s) still does
  // nothing. The 200 floor keeps the threshold above a slow drag on the
  // smallest screens while letting phones scale down to ~252 px/s.
  var SLASH_SPEED_FACTOR = 0.7; // x min(canvasWidth, canvasHeight) per second
  var SLASH_CHAIN_WINDOW_MS = 150; // slashes this close together = one swipe
  var MAX_MISSES = 3; // 3 misses ends the game; completing a round with <=2 advances
  var HIGH_SCORE_KEY = 'fruitSlashHighScore';
  var GRAVITY_FACTOR = 1.6; // x canvas height, px/s^2 (original fast fall; hang time ~2.1s)
  var FRUIT_SCALE = 1.45; // fruit + bomb radius multiplier (bigger, juicier targets)
  var ANNOUNCE_MS = 1000; // wave banner shows for ~1s before the wave launches
  var MAX_PARTICLES = 120; // cap on live juice/explosion particles (mobile perf)
  // Rounds, not slower fruit, make the game last longer: each round has a
  // fixed quota of fruits to clear. Round 1 = 15 fruits, +5 per round.
  // Wave sizes: round 1 waves carry 3 fruits, +2 per round, capped at 20.
  function roundQuota(n) { return 10 + 5 * n; }
  function waveSizeForRound(n) { return Math.min(20, 3 + 2 * (n - 1)); }

  function slashSpeedThreshold(w, h) {
    // Rounded to whole px/s: 0.7 is not exact in binary, so 0.7*360 would
    // otherwise come out as 251.99999999999997 instead of 252.
    return Math.max(200, Math.round(SLASH_SPEED_FACTOR * Math.min(w, h)));
  }

  /* ============================ fruit types =========================== */
  var FRUIT_TYPES = {
    watermelon: { label: 'Watermelon', r: 46, body: ['#2fae4e', '#0d5c22'], flesh: '#ff4d6d', juice: '#ff4d6d', kind: 'watermelon' },
    orange:     { label: 'Orange',     r: 38, body: ['#ff9f1c', '#e07b00'], flesh: '#ffcf7d', juice: '#ff9f1c', kind: 'orange' },
    apple:      { label: 'Apple',      r: 37, body: ['#ef233c', '#a4161a'], flesh: '#fff3d6', juice: '#ef233c', kind: 'apple' },
    lemon:      { label: 'Lemon',      r: 34, body: ['#ffd60a', '#eab505'], flesh: '#fff3b0', juice: '#ffd60a', kind: 'lemon' },
    kiwi:       { label: 'Kiwi',       r: 33, body: ['#8a5a2b', '#5e3a17'], flesh: '#8ac926', juice: '#8ac926', kind: 'kiwi' }
  };
  var FRUIT_KEYS = ['watermelon', 'orange', 'apple', 'lemon', 'kiwi'];

  /* ============================ pure logic ============================ */
  // One swipe with n fruits: n base points + (n-1) bonus. 2 -> 3, 3 -> 5.
  function comboBonus(chainLength) { return Math.max(0, chainLength - 1); }
  function scoreForSwipe(n) { return n + comboBonus(n); }

  // Difficulty per ROUND (not per second): each round is harder than the
  // last — bigger waves, slightly faster launches, more bombs, shorter gaps.
  // Gravity stays at 1.6 every round; rounds get longer because the quota
  // grows, not because the fruit slows down.
  function difficultyForRound(n) {
    return {
      spawnInterval: Math.max(0.7, 1.2 - 0.08 * (n - 1)),
      waveSize: waveSizeForRound(n),
      bombChance: Math.min(0.30, 0.05 + 0.04 * (n - 1)),
      launchBoost: 1 + Math.min(0.25, 0.05 * (n - 1))
    };
  }

  // Plan one wave for round n: how many quota fruits launch, and how many
  // extra bombs come along. Pure (rng injectable) so the harness can test it.
  // - Fruit count is min(wave size for the round, quota still remaining).
  // - Bombs are extra bodies on top of the fruit quota, capped at 2 per wave.
  // - From round 2, a wave that rolled no bomb has a 70% second chance of
  //   carrying exactly one bomb, so most later waves carry a bomb.
  function planWave(roundNum, fruitsRemaining, rng) {
    var d = difficultyForRound(roundNum);
    var r = rng || Math.random;
    var fruits = Math.max(0, Math.min(d.waveSize, fruitsRemaining));
    var bombs = 0;
    for (var i = 0; i < fruits; i++) {
      if (bombs < 2 && r() < d.bombChance) bombs++;
    }
    if (roundNum >= 2 && bombs === 0 && fruits > 0 && r() < 0.7) bombs = 1;
    return { total: fruits + bombs, bombs: bombs, fruits: fruits };
  }

  // Does the segment (x1,y1)-(x2,y2) pass through the circle? Used so a
  // fast fingertip cannot jump over a fruit between frames.
  function segmentHitsCircle(x1, y1, x2, y2, cx, cy, r) {
    var dx = x2 - x1, dy = y2 - y1;
    var len2 = dx * dx + dy * dy;
    var t = len2 === 0 ? 0 : ((cx - x1) * dx + (cy - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    var px = x1 + t * dx, py = y1 + t * dy;
    var ddx = cx - px, ddy = cy - py;
    return ddx * ddx + ddy * ddy <= r * r;
  }

  function makeFruit(typeKey, x, y, vx, vy, r) {
    return {
      kind: 'fruit', type: typeKey, x: x, y: y, vx: vx, vy: vy,
      r: r, rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 5, slashed: false, dead: false
    };
  }
  function makeBomb(x, y, vx, vy, r) {
    return {
      kind: 'bomb', x: x, y: y, vx: vx, vy: vy, r: r,
      rot: Math.random() * Math.PI * 2, vrot: (Math.random() - 0.5) * 2,
      slashed: false, dead: false, fuse: Math.random() * 10
    };
  }
  function updateBody(b, dt, gravity) {
    b.vy += gravity * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.rot += b.vrot * dt;
    if (b.fuse !== undefined) b.fuse += dt;
    return b;
  }
  // A body is a miss when it has fallen off the bottom, still whole.
  function isMissed(b, canvasHeight) {
    return !b.slashed && b.vy > 0 && b.y - b.r > canvasHeight + 40;
  }

  /* ---- round state ---- */
  // A "round" is one quota of fruits to clear. Score and total slashed
  // carry forward across rounds (cumulative); slashed / misses / bestCombo
  // are per round. `launched` counts quota fruits launched, `resolved`
  // counts quota fruits finished (slashed or missed). Bombs are extra and
  // touch neither count.
  function newRound(roundNum, prev) {
    var n = roundNum || 1;
    return {
      round: n, quota: roundQuota(n), launched: 0, resolved: 0,
      score: prev ? prev.score : 0, startScore: prev ? prev.score : 0,
      slashed: 0, totalSlashed: prev ? prev.totalSlashed : 0,
      misses: 0, bestCombo: 0,
      chain: 0, lastSlashAt: -1e9, over: false, reason: null, complete: false
    };
  }
  // Every quota fruit launched and every one resolved (slashed or missed).
  function isRoundComplete(round) {
    return !round.over && round.launched >= round.quota && round.resolved >= round.launched;
  }
  // Complete with 2 or fewer misses advances to the next round. (3 misses
  // sets over=true, so a complete round always has <=2 misses; the check is
  // kept explicit so the rule is testable.)
  function canAdvance(round) {
    return isRoundComplete(round) && round.misses <= 2;
  }
  // Register one slashed fruit. Returns { points, chain, bonus }.
  function registerSlash(round, nowMs) {
    if (round.over) return { points: 0, chain: 0, bonus: 0 };
    var chain = (nowMs - round.lastSlashAt <= SLASH_CHAIN_WINDOW_MS) ? round.chain + 1 : 1;
    round.lastSlashAt = nowMs;
    round.chain = chain;
    round.slashed += 1;
    round.totalSlashed += 1;
    round.resolved += 1;
    var bonus = chain > 1 ? 1 : 0; // each extra fruit in the swipe adds +1
    round.score += 1 + bonus;
    if (chain > round.bestCombo) round.bestCombo = chain;
    return { points: 1 + bonus, chain: chain, bonus: bonus };
  }
  // Register a missed fruit. Returns true when the round is now over.
  function registerMiss(round) {
    if (round.over) return false;
    round.misses += 1;
    round.resolved += 1;
    round.chain = 0;
    if (round.misses >= MAX_MISSES) { round.over = true; round.reason = 'misses'; return true; }
    return false;
  }
  // Register a slashed bomb. Returns true when the round is now over.
  function registerBomb(round) {
    if (round.over) return false;
    round.over = true; round.reason = 'bomb'; return true;
  }

  /* ---- high score (storage is injectable so tests can pass a fake) ---- */
  function loadHighScore(storage) {
    try {
      var v = parseInt((storage || {}).getItem
        ? storage.getItem(HIGH_SCORE_KEY) : '0', 10);
      return isNaN(v) ? 0 : Math.max(0, v);
    } catch (e) { return 0; }
  }
  // Returns true when the score beat the stored best and was saved.
  function saveHighScore(storage, score) {
    var prev = loadHighScore(storage);
    if (score <= prev) return false;
    try { storage.setItem(HIGH_SCORE_KEY, String(score)); } catch (e) { /* private mode */ }
    return true;
  }

  /* ---- spawn helpers (pure, used by the game loop) ---- */
  function pickSpawn(rng) {
    var roll = (rng || Math.random)();
    return roll;
  }
  function launchVelocity(canvasW, canvasH, x, boost, rng) {
    var rnd = rng || Math.random;
    var vy = -(1.55 + rnd() * 0.3) * canvasH * boost;
    var vx = (canvasW / 2 - x) * (0.1 + rnd() * 0.25) + (rnd() - 0.5) * 80;
    return { vx: vx, vy: vy };
  }

  /* ====================== canvas drawing (fruits) ===================== */
  function fruitScale(w, h) { return Math.min(w, h) / 800 * FRUIT_SCALE; }

  /* ---- gradient cache (perf): gradients are built ONCE per fruit type +
     radius and reused every frame. Creating a new gradient per fruit per
     frame churns the GC and costs GPU time on phones. A gradient's
     coordinates live in the user space at fill time, so the same cached
     gradient is correct under any translate/rotate. Keyed by type + rounded
     radius (radius already encodes the current scale S). */
  var gradientCache = {};
  function fruitGradient(ctx, typeKey, r) {
    var key = typeKey + ':' + Math.round(r);
    var g = gradientCache[key];
    if (g) return g;
    var t = FRUIT_TYPES[typeKey];
    var rx = t.kind === 'lemon' ? r * 1.28 : r;
    var ry = t.kind === 'lemon' ? r * 0.82 : r;
    g = ctx.createRadialGradient(-rx * 0.35, -ry * 0.4, r * 0.1, 0, 0, r * 1.15);
    g.addColorStop(0, t.body[0]);
    g.addColorStop(1, t.body[1]);
    gradientCache[key] = g;
    return g;
  }
  function bombGradient(ctx, r) {
    var key = 'bomb:' + Math.round(r);
    var g = gradientCache[key];
    if (g) return g;
    g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.1);
    g.addColorStop(0, '#4a4a4a');
    g.addColorStop(0.6, '#212121');
    g.addColorStop(1, '#000000');
    gradientCache[key] = g;
    return g;
  }
  var bladeTipGradient = null; // built once, reused (knife-local coords)
  function bladeTipGradientFor(ctx) {
    if (bladeTipGradient) return bladeTipGradient;
    bladeTipGradient = ctx.createLinearGradient(0, -7, 0, 7);
    bladeTipGradient.addColorStop(0, '#ffffff');
    bladeTipGradient.addColorStop(1, '#90a4ae');
    return bladeTipGradient;
  }

  function drawWholeFruit(ctx, typeKey, x, y, r, rot) {
    var t = FRUIT_TYPES[typeKey];
    if (!t) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    var rx = t.kind === 'lemon' ? r * 1.28 : r;
    var ry = t.kind === 'lemon' ? r * 0.82 : r;
    // body (cached gradient — no per-frame allocation)
    ctx.fillStyle = fruitGradient(ctx, typeKey, r);
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    // details per fruit
    if (t.kind === 'watermelon') {
      ctx.strokeStyle = 'rgba(6, 60, 20, 0.55)';
      ctx.lineWidth = r * 0.09;
      for (var i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(i * rx * 0.32, -ry * 0.92);
        ctx.quadraticCurveTo(i * rx * 0.45, 0, i * rx * 0.32, ry * 0.92);
        ctx.stroke();
      }
    } else if (t.kind === 'orange') {
      ctx.fillStyle = 'rgba(255, 220, 150, 0.5)';
      ctx.beginPath(); ctx.ellipse(0, -ry * 0.72, r * 0.16, r * 0.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#2f7d32'; ctx.lineWidth = r * 0.07;
      ctx.beginPath(); ctx.moveTo(0, -ry); ctx.quadraticCurveTo(r * 0.1, -ry * 1.25, r * 0.3, -ry * 1.2); ctx.stroke();
      ctx.fillStyle = '#43a047';
      ctx.beginPath(); ctx.ellipse(r * 0.34, -ry * 1.12, r * 0.3, r * 0.14, -0.5, 0, Math.PI * 2); ctx.fill();
    } else if (t.kind === 'apple') {
      ctx.strokeStyle = '#6d4c41'; ctx.lineWidth = r * 0.08;
      ctx.beginPath(); ctx.moveTo(0, -ry * 0.9); ctx.quadraticCurveTo(r * 0.08, -ry * 1.2, r * 0.22, -ry * 1.22); ctx.stroke();
      ctx.fillStyle = '#43a047';
      ctx.beginPath(); ctx.ellipse(r * 0.34, -ry * 1.05, r * 0.32, r * 0.15, -0.45, 0, Math.PI * 2); ctx.fill();
    } else if (t.kind === 'lemon') {
      ctx.fillStyle = t.body[1];
      ctx.beginPath(); ctx.ellipse(-rx, 0, r * 0.16, r * 0.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(rx, 0, r * 0.16, r * 0.1, 0, 0, Math.PI * 2); ctx.fill();
    } else if (t.kind === 'kiwi') {
      ctx.strokeStyle = 'rgba(60, 35, 10, 0.5)'; ctx.lineWidth = 1.5;
      for (var k = 0; k < 26; k++) {
        var a = (k / 26) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * rx * 0.82, Math.sin(a) * ry * 0.82);
        ctx.lineTo(Math.cos(a) * rx * 0.98, Math.sin(a) * ry * 0.98);
        ctx.stroke();
      }
    }
    // shine
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(-rx * 0.32, -ry * 0.42, rx * 0.3, ry * 0.17, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // One half of a slashed fruit. The flat cut face lies along the slash
  // angle; the round side is rind, the flat side shows the flesh.
  function drawFruitHalf(ctx, typeKey, x, y, r, rot, cutAngle) {
    var t = FRUIT_TYPES[typeKey];
    if (!t) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(cutAngle);
    ctx.rotate(rot * 0.25); // halves tumble gently, cut face stays readable
    // flesh (flat face = the diameter)
    ctx.fillStyle = t.flesh;
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    ctx.arc(0, 0, r, Math.PI, 0, false);
    ctx.closePath();
    ctx.fill();
    // rind around the round side
    ctx.strokeStyle = t.body[1];
    ctx.lineWidth = Math.max(4, r * 0.14);
    ctx.beginPath();
    ctx.arc(0, 0, r - ctx.lineWidth / 2, Math.PI, 0, false);
    ctx.stroke();
    // flesh details
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    if (t.kind === 'watermelon') {
      var seeds = [[-r * 0.5, -r * 0.45], [0, -r * 0.6], [r * 0.5, -r * 0.45], [-r * 0.25, -r * 0.2], [r * 0.28, -r * 0.2]];
      for (var s = 0; s < seeds.length; s++) {
        ctx.beginPath();
        ctx.ellipse(seeds[s][0], seeds[s][1], r * 0.05, r * 0.09, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (t.kind === 'orange' || t.kind === 'lemon') {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = Math.max(2, r * 0.05);
      for (var i = 0; i < 5; i++) {
        var a = Math.PI + (i + 0.5) * (Math.PI / 5);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.14, 0, Math.PI * 2); ctx.fill();
    } else if (t.kind === 'kiwi') {
      ctx.fillStyle = '#f1f8e9';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.34, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1b1b1b';
      for (var q = 0; q < 10; q++) {
        var ang = (q / 10) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(Math.cos(ang) * r * 0.55, Math.sin(ang) * r * 0.55 - r * 0.1, r * 0.045, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (t.kind === 'apple') {
      ctx.fillStyle = '#d7a86e';
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.12);
      ctx.lineTo(-r * 0.16, -r * 0.42); ctx.lineTo(r * 0.02, -r * 0.28);
      ctx.lineTo(r * 0.16, -r * 0.42); ctx.lineTo(0, -r * 0.12);
      ctx.fill();
      ctx.beginPath(); ctx.arc(0, -r * 0.08, r * 0.1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawBomb(ctx, x, y, r, rot, fuseT) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot * 0.2);
    // fuse
    ctx.strokeStyle = '#8d6e63';
    ctx.lineWidth = Math.max(3, r * 0.09);
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.85);
    ctx.quadraticCurveTo(r * 0.35, -r * 1.35, r * 0.62, -r * 1.05);
    ctx.stroke();
    // spark (flickers with time)
    var sp = r * (0.22 + 0.1 * Math.sin(fuseT * 14) + 0.06 * Math.sin(fuseT * 31));
    var sx = r * 0.62, sy = -r * 1.05;
    ctx.fillStyle = '#ffea00';
    ctx.beginPath();
    for (var i = 0; i < 8; i++) {
      var a = (i / 8) * Math.PI * 2 + fuseT;
      var rr = i % 2 === 0 ? sp : sp * 0.45;
      ctx.lineTo(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ff6d00';
    ctx.beginPath(); ctx.arc(sx, sy, sp * 0.4, 0, Math.PI * 2); ctx.fill();
    // body (cached gradient — no per-frame allocation)
    ctx.fillStyle = bombGradient(ctx, r);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    // skull-ish warning dot + shine
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath(); ctx.ellipse(-r * 0.32, -r * 0.42, r * 0.28, r * 0.16, -0.6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255, 82, 82, 0.9)';
    ctx.lineWidth = Math.max(2, r * 0.06);
    ctx.beginPath(); ctx.arc(0, r * 0.08, r * 0.34, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ff5252';
    ctx.beginPath(); ctx.arc(-r * 0.12, r * 0.02, r * 0.07, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(r * 0.12, r * 0.02, r * 0.07, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /* ===================== blade trail + particles ====================== */
  function drawBlade(ctx, trail) {
    if (!trail || trail.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // No shadow blur: on mobile GPUs it forces an offscreen pass per stroke.
    // The glow is faked with a wide faint cyan halo stroke under the white
    // core stroke — same look, two plain strokes instead.
    for (var i = 1; i < trail.length; i++) {
      var p0 = trail[i - 1], p1 = trail[i];
      var f = i / trail.length; // 0 = tail, 1 = tip
      ctx.strokeStyle = 'rgba(120, 220, 255,' + (0.05 + 0.22 * f) + ')';
      ctx.lineWidth = 2 + 13 * f + 10;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255,' + (0.12 + 0.85 * f) + ')';
      ctx.lineWidth = 2 + 13 * f;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    // blade tip: a small sleek knife pointing along the motion
    var tip = trail[trail.length - 1];
    var prev = trail[trail.length - 2];
    var ang = Math.atan2(tip.y - prev.y, tip.x - prev.x);
    ctx.translate(tip.x, tip.y);
    ctx.rotate(ang);
    ctx.fillStyle = bladeTipGradientFor(ctx);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(26, -9, 52, -3);
    ctx.quadraticCurveTo(30, 2, 0, 7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#37474f';
    ctx.fillRect(-14, -4, 14, 8);
    ctx.restore();
  }

  /* ====================== browser game (DOM) ====================== */
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    var $ = function (id) { return document.getElementById(id); };
    var canvas = $('game-canvas');
    var ctx = canvas.getContext('2d');
    var video = $('cam-video');

    var W = 0, H = 0, DPR = 1, S = 1; // CSS-pixel viewport size + fruit scale
    var bgGradient = null; // cached per resize (was rebuilt every frame)
    function buildBackgroundGradient() {
      bgGradient = ctx.createLinearGradient(0, 0, 0, H);
      bgGradient.addColorStop(0, '#0b2e1f');
      bgGradient.addColorStop(0.55, '#0f3d26');
      bgGradient.addColorStop(1, '#071a10');
    }
    function resize() {
      // DPR cap 1.5 (was 2): a phone at DPR 2-3 would rasterise ~10M px per
      // frame; 1.5 is ~44% fewer pixels with no visible loss at game sizes.
      DPR = Math.min(window.devicePixelRatio || 1, 1.5);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      S = fruitScale(W, H);
      buildBackgroundGradient();
    }
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', function () { setTimeout(resize, 120); });
    resize();

    /* ---------- state ---------- */
    var state = 'start'; // start | loading | ready | playing | over | roundcomplete
    var mode = 'camera'; // camera | mouse (mouse = pointer fallback, works with touch too)
    var round = newRound(1);
    var fruits = [], halves = [], particles = [];
    var trail = []; // recent fingertip points {x, y, t}
    var tip = { x: -999, y: -999, px: -999, py: -999, speed: 0, present: false };
    var smooth = { x: 0, y: 0, init: false };
    var lastFrameAt = 0;
    var spawnTimer = 0;
    var roundElapsed = 0;
    var roundStartedAt = 0;
    var highScore = loadHighScore(window.localStorage);
    var tracker = null;
    var trackerWarm = false;
    var readySince = 0;
    var countdown = null; // { step, at }
    var endAt = 0; // when to show the result screen after the round ends
    var endShown = false;
    var boom = null; // { x, y, at } explosion visual
    var ambient = [];
    var soundOn = true;
    var newBest = false;
    var waveNum = 0; // waves launched this round
    var pendingWave = null; // { wave, plan, at } — announced, not yet launched
    var completeShown = false;
    var completeAt = 0; // when to show the round-complete screen
    var bestComboOverall = 0;

    function showScreen(name) {
      ['start', 'loading', 'ready', 'result', 'round-complete'].forEach(function (n) {
        var el = $('screen-' + n);
        if (el) el.classList.toggle('active', n === name);
      });
      setHudActive(name === 'ready' || state === 'playing');
    }
    function setHudActive(on) {
      var hud = $('hud');
      if (hud) hud.classList.toggle('active', on);
      var hr = $('hud-round');
      if (hr) hr.classList.toggle('active', on);
    }
    function setStatus(text) { var el = $('loading-status'); if (el) el.textContent = text; }
    var lastHint = null; // setReadyHint runs every frame in ready state; only write on change
    function setReadyHint(text) {
      if (text === lastHint) return;
      lastHint = text;
      var el = $('ready-hint'); if (el) el.textContent = text;
    }

    /* ---------- sounds ---------- */
    var sounds = {};
    function preloadSounds() {
      ['swoosh', 'splat', 'combo', 'bomb'].forEach(function (n) {
        try {
          var a = new Audio('assets/sounds/' + n + '.mp3');
          a.preload = 'auto';
          sounds[n] = a;
        } catch (e) { /* audio unavailable */ }
      });
    }
    function playSound(name, vol) {
      if (!soundOn) return;
      try {
        var a = sounds[name];
        if (!a) return;
        var c = a.cloneNode();
        c.volume = vol == null ? 0.8 : vol;
        var p = c.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) { /* ignore */ }
    }
    preloadSounds();

    /* ---------- ambient start-screen fruits ---------- */
    function initAmbient() {
      ambient = [];
      for (var i = 0; i < 6; i++) {
        ambient.push({
          type: FRUIT_KEYS[i % FRUIT_KEYS.length],
          x: (0.08 + 0.84 * (i / 6) + (Math.random() - 0.5) * 0.06) * W,
          baseY: H * (0.25 + Math.random() * 0.55),
          phase: Math.random() * Math.PI * 2,
          speed: 0.4 + Math.random() * 0.5,
          r: 30 + Math.random() * 22,
          rot: Math.random() * Math.PI * 2
        });
      }
    }
    initAmbient();

    /* ---------- spawning ---------- */
    // Wave banner: before every wave launches, the player sees exactly how
    // many fruits are coming ("WAVE 2 — 5 FRUITS INCOMING!") for ~1 second.
    function showWaveBanner(wave, fruitCount) {
      var b = $('wave-banner');
      if (!b) return;
      var t = $('wave-banner-title');
      if (t) t.textContent = 'WAVE ' + wave;
      var s = $('wave-banner-sub');
      if (s) s.textContent = fruitCount + (fruitCount === 1 ? ' FRUIT' : ' FRUITS') + ' INCOMING!';
      b.classList.add('show');
    }
    function hideWaveBanner() {
      var b = $('wave-banner');
      if (b) b.classList.remove('show');
    }
    // Launch a pre-announced wave: plan.fruits quota fruits + plan.bombs
    // extra bombs, slots shuffled so bombs never launch from a fixed spot.
    function spawnWave(plan) {
      var kinds = [];
      var i;
      for (i = 0; i < plan.bombs; i++) kinds.push('bomb');
      for (i = 0; i < plan.fruits; i++) kinds.push('fruit');
      for (i = kinds.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = kinds[i]; kinds[i] = kinds[j]; kinds[j] = tmp;
      }
      var d = difficultyForRound(round.round);
      for (i = 0; i < kinds.length; i++) {
        var x = W * (0.1 + Math.random() * 0.8);
        var v = launchVelocity(W, H, x, d.launchBoost, Math.random);
        if (kinds[i] === 'bomb') {
          fruits.push(makeBomb(x, H + 60, v.vx, v.vy, 34 * S + 8));
        } else {
          var key = FRUIT_KEYS[Math.floor(Math.random() * FRUIT_KEYS.length)];
          fruits.push(makeFruit(key, x, H + 60, v.vx, v.vy, FRUIT_TYPES[key].r * S));
        }
      }
      round.launched += plan.fruits; // quota counts fruits only; bombs are extra
    }

    /* ---------- slashing ---------- */
    function slashAt(x1, y1, x2, y2, nowMs) {
      var hitAny = false;
      for (var i = 0; i < fruits.length; i++) {
        var f = fruits[i];
        if (f.slashed || f.dead) continue;
        if (!segmentHitsCircle(x1, y1, x2, y2, f.x, f.y, f.r * 1.08)) continue;
        hitAny = true;
        f.slashed = true;
        f.dead = true;
        if (f.kind === 'bomb') {
          registerBomb(round);
          boom = { x: f.x, y: f.y, at: nowMs };
          playSound('bomb', 1);
          flashScreen();
          endAt = nowMs + 1100; // let the explosion show before the result
          spawnBurst(f.x, f.y, '#ff6d00', 18, 420);
          spawnBurst(f.x, f.y, '#ffd60a', 12, 320);
          spawnBurst(f.x, f.y, '#616161', 10, 220);
        } else {
          var res = registerSlash(round, nowMs);
          playSound('splat', 0.9);
          if (res.chain >= 2) {
            playSound('combo', 0.9);
            showCombo(res.chain);
          }
          splitFruit(f, x2 - x1, y2 - y1);
          spawnBurst(f.x, f.y, FRUIT_TYPES[f.type].juice, 8, 260);
        }
      }
      return hitAny;
    }
    function splitFruit(f, dx, dy) {
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len, ny = dx / len; // perpendicular to the swipe
      var ang = Math.atan2(dy, dx);
      var push = 130 * S + 60;
      for (var s = -1; s <= 1; s += 2) {
        halves.push({
          type: f.type, x: f.x, y: f.y,
          vx: f.vx * 0.6 + nx * push * s,
          vy: f.vy * 0.6 + ny * push * s - 60,
          r: f.r, rot: f.rot, vrot: s * (3 + Math.random() * 3),
          cutAngle: ang, life: 1
        });
      }
    }
    function spawnBurst(x, y, color, n, speed) {
      // Cap total live particles: bursts beyond the cap add nothing.
      var room = MAX_PARTICLES - particles.length;
      if (room <= 0) return;
      var count = Math.min(n, room);
      for (var i = 0; i < count; i++) {
        var a = Math.random() * Math.PI * 2;
        var v = speed * (0.3 + Math.random() * 0.7);
        particles.push({
          x: x, y: y,
          vx: Math.cos(a) * v, vy: Math.sin(a) * v - 80,
          r: 2 + Math.random() * 5, color: color, life: 1,
          decay: 1.4 + Math.random() * 1.2
        });
      }
    }
    function flashScreen() {
      var el = $('flash');
      if (!el) return;
      el.classList.add('on');
      setTimeout(function () { el.classList.remove('on'); }, 180);
    }
    var comboTimer = null;
    function showCombo(chain) {
      var el = $('combo-pop');
      if (!el) return;
      el.textContent = 'COMBO x' + chain + '  +' + (chain - 1) + ' BONUS';
      el.classList.add('show');
      if (comboTimer) clearTimeout(comboTimer);
      comboTimer = setTimeout(function () { el.classList.remove('show'); }, 900);
    }

    /* ---------- HUD ---------- */
    // Change-gated: updateHUD runs every frame in the playing state, so it
    // only touches the DOM when a value actually changed.
    var hudCache = { score: null, best: null, misses: null, danger: null, round: null };
    function updateHUD() {
      if (round.score !== hudCache.score) {
        hudCache.score = round.score;
        var scoreEl = $('hud-score');
        if (scoreEl) scoreEl.textContent = round.score;
      }
      var best = Math.max(highScore, round.score);
      if (best !== hudCache.best) {
        hudCache.best = best;
        var bestEl = $('hud-best');
        if (bestEl) bestEl.textContent = 'BEST ' + best;
      }
      var marks = '';
      for (var i = 0; i < MAX_MISSES; i++) marks += i < round.misses ? '✕' : '○';
      if (marks !== hudCache.misses) {
        hudCache.misses = marks;
        var missEl = $('hud-misses');
        if (missEl) missEl.textContent = marks;
      }
      var danger = round.misses >= 2;
      if (danger !== hudCache.danger) {
        hudCache.danger = danger;
        var missEl2 = $('hud-misses');
        if (missEl2) missEl2.classList.toggle('danger', danger);
      }
      var left = Math.max(0, round.quota - round.resolved);
      var roundText = 'ROUND ' + round.round + ' · ' + left + ' LEFT';
      if (roundText !== hudCache.round) {
        hudCache.round = roundText;
        var roundEl = $('hud-round');
        if (roundEl) roundEl.textContent = roundText;
      }
    }

    /* ---------- fingertip ---------- */
    function readTip(dt) {
      var prevX = tip.x, prevY = tip.y;
      var present = false, tx = 0, ty = 0;
      if (mode === 'camera' && tracker) {
        var nt = tracker.getTip();
        if (nt && nt.present) {
          present = true;
          tx = (1 - nt.x) * W; // mirrored: video x flips on screen
          ty = nt.y * H;
        }
      } else if (mode === 'mouse') {
        if (pointer.present) { present = true; tx = pointer.x; ty = pointer.y; }
      }
      if (present) {
        if (!smooth.init) { smooth.x = tx; smooth.y = ty; smooth.init = true; }
        smooth.x += (tx - smooth.x) * 0.45; // eased interpolation (PRD §5)
        smooth.y += (ty - smooth.y) * 0.45;
        tip.px = tip.x; tip.py = tip.y;
        tip.x = smooth.x; tip.y = smooth.y;
        tip.present = true;
        var d = Math.hypot(tip.x - prevX, tip.y - prevY);
        tip.speed = (prevX < -100 || dt <= 0) ? 0 : d / dt;
        var now = performance.now();
        trail.push({ x: tip.x, y: tip.y, t: now });
        while (trail.length > 14 || (trail.length && now - trail[0].t > 140)) trail.shift();
      } else {
        tip.present = false;
        tip.speed = 0;
        if (trail.length) trail.shift();
      }
      return present;
    }

    /* pointer fallback (mouse + touch — same path, works on phones) */
    var pointer = { x: 0, y: 0, present: false };
    window.addEventListener('pointermove', function (e) {
      pointer.x = e.clientX; pointer.y = e.clientY; pointer.present = true;
    }, { passive: true });
    window.addEventListener('pointerdown', function (e) {
      pointer.x = e.clientX; pointer.y = e.clientY; pointer.present = true;
    }, { passive: true });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    /* ---------- main loop ---------- */
    var wasFast = false;
    function loop(nowMs) {
      requestAnimationFrame(loop);
      var dt = lastFrameAt ? Math.min(0.05, (nowMs - lastFrameAt) / 1000) : 0.016;
      lastFrameAt = nowMs;
      var t = nowMs / 1000;

      // No full clear: the background fill (or the video frame in camera
      // mode) is opaque and covers the whole canvas every frame, so
      // clearing first would be a wasted full-screen pass.
      // In gameplay with the camera on, the video IS the background — the
      // gradient fill underneath it is skipped. Everywhere else (start,
      // loading, mouse mode, game over) the gradient is painted.
      var inGame = state === 'ready' || state === 'playing' || state === 'over' || state === 'roundcomplete';
      if (!inGame || !videoVisible()) drawBackground(t);

      if (state === 'start') {
        drawAmbient(t, dt);
      } else if (state === 'loading') {
        // DOM covers the screen; keep the canvas calm.
      } else if (state === 'ready' || state === 'playing' || state === 'over' || state === 'roundcomplete') {
        if (mode === 'camera') drawVideoBackground(); // mouse mode: static background only
        var present = readTip(dt);
        if (state === 'ready') {
          drawTipMarker();
          if (present) {
            if (!readySince) readySince = nowMs;
            var held = nowMs - readySince;
            if (mode === 'mouse') {
              setReadyHint('Blade on your finger — tap START when ready!');
            } else if (held > 400) {
              setReadyHint('Locked on! Get ready…');
              startCountdown(nowMs);
            } else {
              setReadyHint('Hold still — locking onto your hand…');
            }
          } else {
            readySince = 0;
            setReadyHint(mode === 'mouse'
              ? 'Move your mouse or finger — the blade follows it.'
              : 'Raise one hand so the camera can see it.');
          }
        } else if (state === 'playing') {
          roundElapsed = (nowMs - roundStartedAt) / 1000;
          // swipe sound when a fast swipe starts
          var fast = tip.present && tip.speed > slashSpeedThreshold(W, H);
          if (fast && !wasFast) playSound('swoosh', 0.45);
          wasFast = fast;
          // slash check (only while the fingertip is moving fast)
          if (fast && tip.px > -100) slashAt(tip.px, tip.py, tip.x, tip.y, nowMs);
          // waves: announce first (~1s banner with the exact fruit count),
          // then launch. Never spawn after the round is over, and never
          // launch more quota fruits than the round still needs.
          if (!round.over) {
            if (pendingWave) {
              if (nowMs - pendingWave.at >= ANNOUNCE_MS) {
                hideWaveBanner();
                spawnWave(pendingWave.plan);
                pendingWave = null;
                spawnTimer = difficultyForRound(round.round).spawnInterval;
                updateHUD();
              }
            } else {
              spawnTimer -= dt;
              if (spawnTimer <= 0 && round.launched < round.quota) {
                var plan = planWave(round.round, round.quota - round.launched, Math.random);
                waveNum += 1;
                pendingWave = { wave: waveNum, plan: plan, at: nowMs };
                showWaveBanner(waveNum, plan.fruits);
              }
            }
          }
          // physics + misses (only FRUITS count as misses; a bomb falling
          // off the bottom untouched costs nothing — PRD §3)
          var gravity = GRAVITY_FACTOR * H;
          for (var i = fruits.length - 1; i >= 0; i--) {
            var f = fruits[i];
            updateBody(f, dt, gravity);
            if (isMissed(f, H)) {
              fruits.splice(i, 1);
              if (f.kind === 'fruit') {
                if (registerMiss(round)) endAt = nowMs + 700;
                updateHUD();
              }
            } else if (f.dead) {
              fruits.splice(i, 1);
            }
          }
          if (round.over && !endShown && nowMs >= endAt) showResult();
          // round complete: every quota fruit launched + resolved, and no
          // bodies left on screen (a lingering bomb must fall away first —
          // and the player may still slash it, ending the game, until it does).
          if (!round.over && !round.complete && isRoundComplete(round) && fruits.length === 0) {
            round.complete = true;
            completeAt = nowMs + 500;
          }
          if (round.complete && !completeShown && nowMs >= completeAt) showRoundComplete();
          updateHUD();
        }
        // halves + particles always animate while a round is on screen
        updateHalves(dt);
        updateParticles(dt);
        drawFruits();
        drawHalves();
        drawParticles();
        if (state !== 'start') drawBlade(ctx, trail);
        if (boom) drawBoom(nowMs);
        if (countdown) drawCountdown(nowMs);
      }
    }

    function drawBackground(t) {
      if (!bgGradient) buildBackgroundGradient();
      ctx.fillStyle = bgGradient;
      ctx.fillRect(0, 0, W, H);
    }
    function drawAmbient(t, dt) {
      for (var i = 0; i < ambient.length; i++) {
        var a = ambient[i];
        var y = a.baseY + Math.sin(t * a.speed + a.phase) * 26;
        a.rot += dt * 0.2;
        ctx.globalAlpha = 0.85;
        drawWholeFruit(ctx, a.type, a.x, y, a.r * S + 8, a.rot);
      }
      ctx.globalAlpha = 1;
    }
    function videoVisible() {
      return mode === 'camera' && video && video.readyState >= 2 && video.videoWidth;
    }
    function drawVideoBackground() {
      if (videoVisible()) {
        ctx.save();
        ctx.translate(W, 0);
        ctx.scale(-1, 1); // mirrored so the blade moves the way the hand moves
        ctx.drawImage(video, 0, 0, W, H);
        ctx.restore();
        ctx.fillStyle = 'rgba(4, 20, 12, 0.42)'; // dim so fruits pop
        ctx.fillRect(0, 0, W, H);
      }
    }
    function drawTipMarker() {
      if (!tip.present) return;
      ctx.save();
      // Two plain circles instead of a shadow blur: a wide faint halo + the
      // bright ring. Same glow look, no offscreen pass.
      ctx.strokeStyle = 'rgba(125, 216, 255, 0.4)';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 20 * S + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 20 * S + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    function updateHalves(dt) {
      var gravity = GRAVITY_FACTOR * H;
      for (var i = halves.length - 1; i >= 0; i--) {
        var h = halves[i];
        updateBody(h, dt, gravity);
        h.life -= dt * 0.9;
        if (h.y - h.r > H + 80 || h.life <= 0) halves.splice(i, 1);
      }
    }
    function updateParticles(dt) {
      for (var i = particles.length - 1; i >= 0; i--) {
        var p = particles[i];
        p.vy += GRAVITY_FACTOR * H * 0.7 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= p.decay * dt;
        if (p.life <= 0 || p.y > H + 20) particles.splice(i, 1);
      }
    }
    function drawFruits() {
      for (var i = 0; i < fruits.length; i++) {
        var f = fruits[i];
        if (f.kind === 'bomb') drawBomb(ctx, f.x, f.y, f.r, f.rot, f.fuse);
        else drawWholeFruit(ctx, f.type, f.x, f.y, f.r, f.rot);
      }
    }
    function drawHalves() {
      for (var i = 0; i < halves.length; i++) {
        var h = halves[i];
        ctx.globalAlpha = Math.max(0, Math.min(1, h.life));
        drawFruitHalf(ctx, h.type, h.x, h.y, h.r, h.rot, h.cutAngle);
      }
      ctx.globalAlpha = 1;
    }
    function drawParticles() {
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // Explosion glow, pre-rendered once to an offscreen sprite and drawn
    // scaled — no per-frame gradient creation.
    var boomSprite = null;
    function getBoomSprite() {
      if (boomSprite) return boomSprite;
      var c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      var bctx = c.getContext('2d');
      var g = bctx.createRadialGradient(128, 128, 0, 128, 128, 128);
      g.addColorStop(0, 'rgba(255, 240, 120, 0.95)');
      g.addColorStop(0.4, 'rgba(255, 109, 0, 0.75)');
      g.addColorStop(1, 'rgba(255, 60, 0, 0)');
      bctx.fillStyle = g;
      bctx.fillRect(0, 0, 256, 256);
      boomSprite = c;
      return boomSprite;
    }
    function drawBoom(nowMs) {
      var age = (nowMs - boom.at) / 1000;
      if (age > 0.7) { boom = null; return; }
      var r = (0.2 + age * 2.4) * Math.min(W, H) * 0.32;
      ctx.drawImage(getBoomSprite(), boom.x - r, boom.y - r, r * 2, r * 2);
    }
    var lastCountdownN = -1; // only write the DOM when the number changes
    function drawCountdown(nowMs) {
      var step = Math.floor((nowMs - countdown.at) / 550);
      if (step >= 3) { countdown = null; lastCountdownN = -1; beginPlay(nowMs); return; }
      var n = 3 - step;
      if (n === lastCountdownN) return;
      lastCountdownN = n;
      var el = $('countdown');
      if (el) {
        el.textContent = n;
        el.classList.add('show');
      }
    }
    function startCountdown(nowMs) {
      if (countdown) return;
      state = 'ready';
      countdown = { at: nowMs };
      var el = $('countdown');
      if (el) el.classList.add('show');
    }
    function beginPlay(nowMs) {
      var el = $('countdown');
      if (el) el.classList.remove('show');
      state = 'playing';
      roundStartedAt = nowMs;
      roundElapsed = 0;
      spawnTimer = 0; // first wave is announced the instant play begins
      waveNum = 0;
      pendingWave = null;
      hideWaveBanner();
      showScreen('game');
      updateHUD();
    }

    /* ---------- screens / flow ---------- */
    function showResult() {
      endShown = true;
      state = 'over';
      hideWaveBanner();
      bestComboOverall = Math.max(bestComboOverall, round.bestCombo);
      var beaten = saveHighScore(window.localStorage, round.score);
      newBest = beaten;
      if (beaten) highScore = round.score;
      var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
      set('result-score', round.score);
      set('result-slashed', round.totalSlashed);
      set('result-combo', bestComboOverall > 1 ? 'x' + bestComboOverall : '—');
      set('result-best', highScore);
      set('result-round', round.round);
      set('result-reason', round.reason === 'bomb'
        ? 'BOOM! You slashed a bomb.'
        : 'Three fruits got past you.');
      var badge = $('result-badge');
      if (badge) badge.classList.toggle('show', beaten && round.score > 0);
      if (tracker) tracker.pause();
      showScreen('result');
    }

    /* ---------- round complete ---------- */
    function showRoundComplete() {
      completeShown = true;
      state = 'roundcomplete';
      hideWaveBanner();
      bestComboOverall = Math.max(bestComboOverall, round.bestCombo);
      var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
      set('rc-kicker', 'ROUND ' + round.round + ' COMPLETE!');
      set('rc-score', round.score);
      set('rc-slashed', round.slashed);
      set('rc-misses', round.misses);
      set('rc-combo', round.bestCombo > 1 ? 'x' + round.bestCombo : '—');
      set('rc-next', 'Round ' + (round.round + 1) + ': ' + roundQuota(round.round + 1) +
        ' fruits, bigger waves, more bombs.');
      showScreen('round-complete');
    }
    function startNextRound() {
      var prev = round;
      bestComboOverall = Math.max(bestComboOverall, prev.bestCombo);
      round = newRound(prev.round + 1, prev); // score + total slashed carry over
      fruits = []; halves = []; particles = []; trail = [];
      smooth.init = false;
      tip.x = tip.y = -999; tip.present = false; tip.speed = 0;
      readySince = 0; countdown = null; endShown = false; completeShown = false;
      endAt = 0; completeAt = 0; boom = null; newBest = false; wasFast = false;
      waveNum = 0; pendingWave = null;
      hideWaveBanner();
      updateHUD();
      // Straight into the countdown — the tracker is already warm and the
      // hand is still up, so no ready screen is needed between rounds.
      startCountdown(performance.now());
      setHudActive(true);
    }

    function startGame(nextMode) {
      mode = nextMode;
      round = newRound(1); // fresh run: round 1, score 0
      bestComboOverall = 0;
      fruits = []; halves = []; particles = []; trail = [];
      smooth.init = false;
      tip.x = tip.y = -999; tip.present = false; tip.speed = 0;
      readySince = 0; countdown = null; endShown = false; completeShown = false;
      endAt = 0; completeAt = 0; boom = null;
      newBest = false; wasFast = false;
      waveNum = 0; pendingWave = null;
      hideWaveBanner();
      updateHUD();
      if (mode === 'mouse') {
        state = 'ready';
        setReadyHint('Move your mouse or finger — the blade follows it.');
        showScreen('ready');
        var go = $('ready-go');
        if (go) go.style.display = '';
        return;
      }
      // camera mode
      state = 'loading';
      showScreen('loading');
      var errBox = $('loading-error');
      if (errBox) errBox.classList.remove('show');
      setStatus('Asking for the camera…');
      getTracker().then(function (trk) {
        if (state !== 'loading') return; // user left meanwhile
        setStatus('Loading the hand model…');
        return trk.start(video, setStatus);
      }).then(function () {
        if (state !== 'loading') return;
        trackerWarm = true;
        state = 'ready';
        setReadyHint('Raise one hand so the camera can see it.');
        showScreen('ready');
        var go2 = $('ready-go');
        if (go2) go2.style.display = 'none';
      }).catch(function (err) {
        if (state !== 'loading') return;
        state = 'start';
        showScreen('loading');
        setStatus('Camera could not start.');
        var box = $('loading-error');
        var msg = $('loading-error-msg');
        if (msg) {
          msg.textContent = (err && err.name === 'NotAllowedError')
            ? 'Camera permission was denied. Tap the lock / camera icon in the address bar, allow the camera, then try again — or play with mouse / touch instead.'
            : 'No camera was found, or it could not be opened (' + (err && err.message ? err.message : 'unknown error') + '). Check the camera is plugged in and not used by another app — or play with mouse / touch instead.';
        }
        if (box) box.classList.add('show');
      });
    }

    var trackerPromise = null;
    function getTracker() {
      if (trackerPromise) return trackerPromise;
      trackerPromise = new Promise(function (resolve, reject) {
        try {
          var T = window.FruitSlash && window.FruitSlash.Tracker;
          if (!T) throw new Error('Tracker module did not load.');
          tracker = new T();
          resolve(tracker);
        } catch (e) { reject(e); }
      });
      return trackerPromise;
    }

    /* ---------- wiring ---------- */
    function bind(id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); }
    bind('play-btn', function () { startGame('camera'); });
    bind('mouse-btn', function () { startGame('mouse'); });
    bind('retry-btn', function () { startGame('camera'); });
    bind('again-btn', function () { startGame(mode); });
    bind('next-btn', function () { startNextRound(); });
    bind('home-btn', function () {
      state = 'start';
      pendingWave = null;
      hideWaveBanner();
      if (tracker) tracker.pause();
      showScreen('start');
      initAmbient();
    });
    bind('rc-home-btn', function () {
      state = 'start';
      pendingWave = null;
      hideWaveBanner();
      if (tracker) tracker.pause();
      showScreen('start');
      initAmbient();
    });
    bind('ready-go', function () {
      if (state === 'ready' && mode === 'mouse') startCountdown(performance.now());
    });
    bind('sound-btn', function () {
      soundOn = !soundOn;
      var el = $('sound-btn');
      if (el) el.textContent = soundOn ? 'SOUND: ON' : 'SOUND: OFF';
    });
    bind('sound-btn-2', function () {
      soundOn = !soundOn;
      var el = $('sound-btn-2');
      if (el) el.textContent = soundOn ? 'SOUND: ON' : 'SOUND: OFF';
    });
    var bestEl = $('start-best');
    if (bestEl) bestEl.textContent = highScore > 0 ? "Today's best: " + highScore : 'No scores yet today — be the first!';

    showScreen('start');
    requestAnimationFrame(loop);
  }

  /* ============================ exports ============================= */
  var api = {
    SLASH_SPEED_FACTOR: SLASH_SPEED_FACTOR,
    FRUIT_SCALE: FRUIT_SCALE,
    GRAVITY_FACTOR: GRAVITY_FACTOR,
    SLASH_CHAIN_WINDOW_MS: SLASH_CHAIN_WINDOW_MS,
    MAX_MISSES: MAX_MISSES,
    HIGH_SCORE_KEY: HIGH_SCORE_KEY,
    ANNOUNCE_MS: ANNOUNCE_MS,
    MAX_PARTICLES: MAX_PARTICLES,
    FRUIT_TYPES: FRUIT_TYPES,
    FRUIT_KEYS: FRUIT_KEYS,
    slashSpeedThreshold: slashSpeedThreshold,
    fruitScale: fruitScale,
    comboBonus: comboBonus,
    scoreForSwipe: scoreForSwipe,
    roundQuota: roundQuota,
    waveSizeForRound: waveSizeForRound,
    difficultyForRound: difficultyForRound,
    planWave: planWave,
    segmentHitsCircle: segmentHitsCircle,
    makeFruit: makeFruit,
    makeBomb: makeBomb,
    updateBody: updateBody,
    isMissed: isMissed,
    newRound: newRound,
    isRoundComplete: isRoundComplete,
    canAdvance: canAdvance,
    registerSlash: registerSlash,
    registerMiss: registerMiss,
    registerBomb: registerBomb,
    loadHighScore: loadHighScore,
    saveHighScore: saveHighScore,
    launchVelocity: launchVelocity
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FruitSlashGame = api;
})();
