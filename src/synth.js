/*
 * バンドちゃん エンジン — バンドテキスト → ライブ演奏 / WAV書き出し
 *
 * Strudel風のライブコーディング・シンセサイザー。トラックごとにドラム・ベース・
 * コード・リード・(engine.jsの)うたを書き、Web Audioで先読みスケジューリング
 * しながら鳴らす。パーサ部分(parse)は依存ゼロでNodeでも動く。
 *
 *   const song = Band.parse(text);         // {tempo, swing, voice, style, tracks, loopLen16}
 *   const player = Band.createPlayer();     // ブラウザ専用(Web Audio)
 *   player.play(text);
 *   player.apply(newText);                  // 次の小節から差し替え(ライブコーディング)
 *   const wav = await Band.renderWav(text); // ArrayBuffer(ブラウザ専用)
 *
 * ── バンドテキスト形式 ──────────────────────────────
 *   # コメント
 *   @tempo 120              テンポBPM(省略時100)
 *   @voice うたこ           [うた]トラックの声
 *   @style ふつう           [うた]トラックのスタイル
 *   @swing 0.1              スウィング(0〜0.3、省略時0)
 *
 *   [ドラム] どつたつ どつたち | どつたつ ぱつたち
 *   [ベース] ど2:4 ど2:4 ら1:4 そ1:4
 *   [コード] Am:16 F:16 | C:16 G:16
 *   [リード] み4:2 そ4:2 ら4:4 ・:8
 *   [うた]   ど4:き ど4:ら そ4:き そ4:ら
 *
 *   [トラック名] を行頭に置くとトラック切り替え。トラック名なしの音符行は
 *   直前のトラックへ連結。| と空白は読み飛ばす飾り。# はコメント。
 * ──────────────────────────────────────────────
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Band = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

/* engine.js(うたエンジン)を読み込む。ブラウザは <script src="engine.js"> で
 * すでに global.Utau があり、Nodeは同じフォルダから require する。 */
let Utau = (typeof globalThis !== 'undefined' && globalThis.Utau) || null;
if (!Utau && typeof require !== 'undefined') {
  try { Utau = require('./engine.js'); } catch (_) { /* ブラウザ内requireなど */ }
}

/* ============ 0. 共通ユーティリティ ============ */
function toHiragana(s) {
  return String(s).replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}
const PC_KANA = {'ど': 0, 'れ': 2, 'み': 4, 'ふぁ': 5, 'そ': 7, 'ら': 9, 'し': 11};
const PC_ABC = {c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11};
function parsePitch(p) {
  p = toHiragana(p).toLowerCase();
  const m = p.match(/^(ど|れ|み|ふぁ|そ|ら|し|[a-g])([#♯b♭]?)(\d)$/);
  if (!m) return null;
  const pc = PC_KANA[m[1]] !== undefined ? PC_KANA[m[1]] : PC_ABC[m[1]];
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : (m[2] === 'b' || m[2] === '♭' ? -1 : 0);
  return 12 * (+m[3] + 1) + pc + acc;
}
const midiToF = m => 440 * Math.pow(2, (m - 69) / 12);

/* ============ 1. ドラム文字 ============ */
const DRUM_MAP = {'ど': 'kick', 'た': 'snare', 'つ': 'hat', 'ち': 'ohat', 'ぱ': 'clap', '・': 'rest'};

/* ============ 2. コード定義 ============ */
// ルート + 半音インターバル(オクターブ3を基準に積む → add9等は自然にオクターブ4へ伸びる)
const CHORD_DEF = {
  '': [0, 4, 7],          // メジャー
  m: [0, 3, 7],           // マイナー
  7: [0, 4, 7, 10],       // 7th
  m7: [0, 3, 7, 10],      // マイナー7th
  maj7: [0, 4, 7, 11],    // メジャー7th
  dim: [0, 3, 6],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 14]
};
function parseChordName(tok) {
  const m = tok.match(/^([A-Ga-g])([#♯b♭]?)(maj7|m7|dim|sus4|add9|7|m)?$/);
  if (!m) return null;
  const pcBase = {c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11}[m[1].toLowerCase()];
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : (m[2] === 'b' || m[2] === '♭' ? -1 : 0);
  const quality = (m[3] || '').toLowerCase();
  const intervals = CHORD_DEF[quality];
  if (!intervals) return null;
  const root = 48 + pcBase + acc;   // オクターブ3のルート(ど3=48)
  return intervals.map(iv => root + iv);
}

/* ============ 3. バンドテキストのパーサ ============ */
function throwErrors(errors) {
  const e = new Error(errors.join('\n'));
  e.bandErrors = errors;
  throw e;
}

function parseDrumTrack(chunks, errors) {
  const hits = [];
  let pos = 0;
  for (const {li, text} of chunks) {
    const norm = toHiragana(text);
    for (const ch of norm) {
      if (ch === ' ' || ch === '　' || ch === '|' || ch === '｜') continue;
      const kind = DRUM_MAP[ch];
      if (!kind) {
        errors.push(`${li + 1}行目: ドラム文字「${ch}」がわかりません(ど/た/つ/ち/ぱ/・ で)`);
        pos++; continue;
      }
      if (kind !== 'rest') hits.push({start: pos, len: 1, drum: kind});
      pos++;
    }
  }
  return {type: 'ドラム', hits, len16: pos};
}

function parseMonoTrack(chunks, errors) {
  const notes = [];
  let pos = 0;
  for (const {li, text} of chunks) {
    for (let token of text.split(/\s+/)) {
      if (!token || token === '|' || token === '｜') continue;
      const parts = token.split(/[:：]/);
      if (/^[・.rR]/.test(parts[0])) {
        const len = Math.max(1, Math.min(64, parseInt(parts[1], 10) || 4));
        pos += len; continue;
      }
      const midi = parsePitch(parts[0]);
      if (midi === null) {
        errors.push(`${li + 1}行目: "${token}" の高さがわかりません(例: ど4:4 / C4:4)`);
        continue;
      }
      const len = Math.max(1, Math.min(64, parseInt(parts[1], 10) || 4));
      notes.push({start: pos, len, midi});
      pos += len;
    }
  }
  return {type: 'note', notes, len16: pos};
}

function parseChordTrack(chunks, errors) {
  const notes = [];
  let pos = 0;
  for (const {li, text} of chunks) {
    for (let token of text.split(/\s+/)) {
      if (!token || token === '|' || token === '｜') continue;
      const parts = token.split(/[:：]/);
      if (/^[・.rR]/.test(parts[0])) {
        const len = Math.max(1, Math.min(64, parseInt(parts[1], 10) || 4));
        pos += len; continue;
      }
      const midis = parseChordName(parts[0]);
      if (!midis) {
        errors.push(`${li + 1}行目: コード「${token}」がわかりません(例: C, Am, C7, Am7, Cmaj7, dim, sus4, add9)`);
        continue;
      }
      const len = Math.max(1, Math.min(64, parseInt(parts[1], 10) || 4));
      notes.push({start: pos, len, midis});
      pos += len;
    }
  }
  return {type: 'コード', notes, len16: pos};
}

function parseUtaTrack(chunks, song, errors) {
  if (!Utau) {
    errors.push('[うた]トラックがありますが engine.js(Utau)が読み込めていません');
    return null;
  }
  const body = chunks.map(c => c.text).join(' ');
  const header = `@tempo ${song.tempo}\n@voice ${song.voice}\n@style ${song.style}\n`;
  let utauSong;
  try {
    utauSong = Utau.parse(header + body);
  } catch (e) {
    const li = chunks.length ? chunks[0].li + 1 : '?';
    errors.push(`${li}行目([うた]): ${e.message}`);
    return null;
  }
  let len16 = 0;
  for (const n of utauSong.notes) len16 = Math.max(len16, n.start + n.len);
  return {type: 'うた', utauSong, len16};
}

const TRACK_PARSERS = {
  'ドラム': parseDrumTrack,
  'ベース': parseMonoTrack,
  'リード': parseMonoTrack,
  'コード': parseChordTrack
};

function parse(text) {
  const song = {tempo: 100, swing: 0, voice: 'うたこ', style: 'ふつう'};
  const errors = [];
  const tracksRaw = {};
  const order = [];
  let currentTrack = null;

  String(text).split('\n').forEach((raw, li) => {
    const line = raw.replace(/(^|\s)[#＃].*$/, '$1').replace(/[　\t]/g, ' ').trim();
    if (!line) return;
    if (line[0] === '@' || line[0] === '＠') {
      const dm = line.slice(1).match(/^(\S+)\s+(\S+)/);
      if (!dm) { errors.push(`${li + 1}行目: "${line}" がよめません`); return; }
      const [, key, val] = dm;
      if (/^(tempo|てんぽ|テンポ)$/i.test(key)) {
        const t = parseInt(val, 10);
        if (t >= 40 && t <= 300) song.tempo = t;
        else errors.push(`${li + 1}行目: テンポは40〜300で`);
      } else if (/^(voice|こえ|声)$/i.test(key)) {
        song.voice = val;
      } else if (/^(style|すたいる|スタイル)$/i.test(key)) {
        song.style = val;
      } else if (/^(swing|すいんぐ|スウィング)$/i.test(key)) {
        const s = parseFloat(val);
        if (!isNaN(s) && s >= 0 && s <= 0.3) song.swing = s;
        else errors.push(`${li + 1}行目: スウィングは0〜0.3で`);
      } else {
        errors.push(`${li + 1}行目: @${key} はしらないなあ`);
      }
      return;
    }
    const tm = line.match(/^[\[［](.+?)[\]］]\s*(.*)$/);
    let content;
    if (tm) {
      currentTrack = tm[1].trim();
      content = tm[2];
      if (!tracksRaw[currentTrack]) { tracksRaw[currentTrack] = []; order.push(currentTrack); }
    } else {
      if (!currentTrack) {
        errors.push(`${li + 1}行目: トラック指定([ドラム]等)がない音符行です`);
        return;
      }
      content = line;
    }
    if (content) tracksRaw[currentTrack].push({li, text: content});
  });

  const tracks = {};
  for (const name of order) {
    const chunks = tracksRaw[name];
    if (name === 'うた') {
      tracks[name] = parseUtaTrack(chunks, song, errors);
    } else if (TRACK_PARSERS[name]) {
      tracks[name] = TRACK_PARSERS[name](chunks, errors);
    } else {
      errors.push(`${chunks[0].li + 1}行目: 不明なトラック名「${name}」です(ドラム/ベース/コード/リード/うた のいずれかで)`);
    }
  }
  if (errors.length) throwErrors(errors);

  let maxLen = 0;
  for (const name in tracks) if (tracks[name]) maxLen = Math.max(maxLen, tracks[name].len16 || 0);
  const loopLen16 = Math.max(16, Math.ceil(maxLen / 16) * 16);

  return {tempo: song.tempo, swing: song.swing, voice: song.voice, style: song.style, tracks, loopLen16};
}

/* ============ 4. 楽器(Web Audioノード合成) ============ */
const noiseCache = new Map();
function noiseBuffer(ctx, dur) {
  const key = ctx;
  let m = noiseCache.get(key);
  if (!m) { m = new Map(); noiseCache.set(key, m); }
  const cacheKey = Math.round(dur * 1000);
  if (m.has(cacheKey)) return m.get(cacheKey);
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  m.set(cacheKey, buf);
  return buf;
}

function playKick(ctx, dest, time) {
  const osc = ctx.createOscillator(); osc.type = 'sine';
  const g = ctx.createGain();
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(50, time + 0.12);
  g.gain.setValueAtTime(1, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.28);
  osc.connect(g); g.connect(dest);
  osc.start(time); osc.stop(time + 0.32);
}
function playSnare(ctx, dest, time) {
  const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, 0.2);
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 1.2;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.9, time);
  ng.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
  src.connect(bp); bp.connect(ng); ng.connect(dest);
  src.start(time); src.stop(time + 0.2);

  const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 180;
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.5, time);
  og.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
  osc.connect(og); og.connect(dest);
  osc.start(time); osc.stop(time + 0.15);
}
function playHat(ctx, dest, time, open) {
  const dur = open ? 0.25 : 0.04;
  const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, dur + 0.02);
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.6, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + dur);
  src.connect(hp); hp.connect(g); g.connect(dest);
  src.start(time); src.stop(time + dur + 0.02);
}
function playClap(ctx, dest, time) {
  for (let i = 0; i < 3; i++) {
    const t = time + i * 0.012;
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, 0.05);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    src.connect(bp); bp.connect(g); g.connect(dest);
    src.start(t); src.stop(t + 0.1);
  }
}
function playBass(ctx, dest, time, dur, midi) {
  const freq = midiToF(midi);
  const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = freq;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600; lp.Q.value = 2;
  const g = ctx.createGain();
  const atk = 0.01, dec = 0.08, sus = 0.7, rel = 0.08, peak = 0.85;
  const end = time + dur;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(peak, time + atk);
  g.gain.linearRampToValueAtTime(peak * sus, time + atk + dec);
  g.gain.setValueAtTime(peak * sus, Math.max(time + atk + dec, end - rel));
  g.gain.linearRampToValueAtTime(0.0001, end);
  osc.connect(lp); lp.connect(g); g.connect(dest);
  osc.start(time); osc.stop(end + 0.05);
}
function playChord(ctx, dest, time, dur, midis) {
  const end = time + dur, atk = Math.min(0.25, dur * 0.4);
  for (const midi of midis) {
    const freq = midiToF(midi);
    for (const det of [-4, 4]) {
      const osc = ctx.createOscillator(); osc.type = 'triangle';
      osc.frequency.value = freq; osc.detune.value = det;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(0.22, time + atk);
      g.gain.setValueAtTime(0.22, Math.max(time + atk, end - 0.2));
      g.gain.linearRampToValueAtTime(0.0001, end);
      osc.connect(lp); lp.connect(g); g.connect(dest);
      osc.start(time); osc.stop(end + 0.1);
    }
  }
}
function playLead(ctx, dest, time, dur, midi) {
  const freq = midiToF(midi);
  const osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = freq;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 5.5;
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 8;
  lfo.connect(lfoGain); lfoGain.connect(osc.detune);
  const g = ctx.createGain();
  const atk = 0.02, rel = 0.06, end = time + dur;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(0.5, time + atk);
  g.gain.setValueAtTime(0.5, Math.max(time + atk, end - rel));
  g.gain.linearRampToValueAtTime(0.0001, end);
  osc.connect(lp); lp.connect(g); g.connect(dest);
  osc.start(time); lfo.start(time);
  osc.stop(end + 0.1); lfo.stop(end + 0.1);
}

/* ============ 5. 1ステップぶんのスケジューリング(リアルタイム/オフライン共通) ============ */
function prepareUtaBuffer(ctx, track) {
  if (track.__buffer || !track.utauSong || !Utau) return;
  const {samples} = Utau.render(track.utauSong);
  const buf = ctx.createBuffer(1, samples.length, Utau.SR);
  buf.copyToChannel(samples, 0);
  track.__buffer = buf;
}
function scheduleStep(song, getDest, ctx, step, time, stepDur) {
  for (const name of Object.keys(song.tracks)) {
    const track = song.tracks[name];
    if (!track) continue;
    const dest = getDest(name);
    if (!dest) continue;
    if (track.type === 'ドラム') {
      const local = track.len16 > 0 ? step % track.len16 : step;
      for (const h of track.hits) {
        if (h.start !== local) continue;
        if (h.drum === 'kick') playKick(ctx, dest, time);
        else if (h.drum === 'snare') playSnare(ctx, dest, time);
        else if (h.drum === 'hat') playHat(ctx, dest, time, false);
        else if (h.drum === 'ohat') playHat(ctx, dest, time, true);
        else if (h.drum === 'clap') playClap(ctx, dest, time);
      }
    } else if (track.type === 'note') {
      const local = track.len16 > 0 ? step % track.len16 : step;
      for (const n of track.notes) {
        if (n.start !== local) continue;
        const dur = n.len * stepDur;
        if (name === 'ベース') playBass(ctx, dest, time, dur, n.midi);
        else playLead(ctx, dest, time, dur, n.midi);
      }
    } else if (track.type === 'コード') {
      const local = track.len16 > 0 ? step % track.len16 : step;
      for (const n of track.notes) {
        if (n.start !== local) continue;
        playChord(ctx, dest, time, n.len * stepDur, n.midis);
      }
    } else if (track.type === 'うた') {
      if (track.len16 > 0 && step % track.len16 === 0) {
        prepareUtaBuffer(ctx, track);
        if (track.__buffer) {
          const src = ctx.createBufferSource();
          src.buffer = track.__buffer;
          src.connect(dest);
          src.start(time);
        }
      }
    }
  }
}

/* ============ 6. リアルタイム演奏プレイヤー(ブラウザ専用) ============ */
function isBrowserAudio() {
  return typeof window !== 'undefined' &&
    (typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined');
}

function createPlayer() {
  const LOOKAHEAD = 0.1, INTERVAL_MS = 25;
  let ctx = null, compressor = null;
  let song = null, pendingSong = null;
  const trackGains = {};      // name -> {gain, muted, volume}
  let timerId = null, rafId = 0;
  let nextStepTime = 0, currentStep = 0, barIndex = 0;
  let scheduledSteps = [];
  let lastReportedStep = -1;
  let stepCb = null;
  let playing = false;

  function ensureCtx() {
    if (!isBrowserAudio()) throw new Error('この環境ではWeb Audioが使えません(ブラウザで開いてね)');
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctx();
      compressor = ctx.createDynamicsCompressor();
      compressor.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function ensureTrackGain(name) {
    if (!trackGains[name]) {
      const g = ctx.createGain();
      g.connect(compressor);
      trackGains[name] = {gain: g, muted: false, volume: 1};
    }
    return trackGains[name];
  }
  function applyGainValue(name) {
    const tg = trackGains[name];
    if (tg) tg.gain.gain.value = tg.muted ? 0 : tg.volume;
  }
  function ensureAllTrackGains(s) {
    for (const name of Object.keys(s.tracks)) ensureTrackGain(name);
  }

  function apply(text) {
    const parsed = parse(text);
    if (!playing) { song = parsed; currentStep = 0; barIndex = 0; }
    else pendingSong = parsed;
    return parsed;
  }

  function scheduler() {
    while (song && nextStepTime < ctx.currentTime + LOOKAHEAD) {
      if (currentStep % 16 === 0 && pendingSong) {
        song = pendingSong; pendingSong = null;
        ensureAllTrackGains(song);
        currentStep = 0;
      }
      const stepDur = 60 / song.tempo / 4;
      const getDest = name => trackGains[name] && trackGains[name].gain;
      scheduleStep(song, getDest, ctx, currentStep, nextStepTime, stepDur);
      scheduledSteps.push({step: currentStep, bar: barIndex, time: nextStepTime});

      let delay = stepDur;
      if (song.swing) delay = stepDur * (1 + (currentStep % 2 === 0 ? song.swing : -song.swing));
      nextStepTime += delay;
      currentStep++;
      if (currentStep % 16 === 0) barIndex++;
      if (currentStep >= song.loopLen16) currentStep = 0;
    }
  }
  function drawLoop() {
    if (!playing) return;
    const now = ctx.currentTime;
    let found = null;
    while (scheduledSteps.length && scheduledSteps[0].time <= now) found = scheduledSteps.shift();
    if (found) {
      lastReportedStep = found.step;
      if (stepCb) stepCb(found.step, found.bar);
    }
    rafId = requestAnimationFrame(drawLoop);
  }

  function play(text) {
    ensureCtx();
    if (text !== undefined) song = parse(text);
    if (!song) throw new Error('えんそうするバンドテキストがありません');
    ensureAllTrackGains(song);
    for (const name of Object.keys(trackGains)) applyGainValue(name);
    playing = true;
    currentStep = 0; barIndex = 0;
    nextStepTime = ctx.currentTime + 0.06;
    scheduledSteps = []; lastReportedStep = -1;
    if (timerId) clearInterval(timerId);
    timerId = setInterval(scheduler, INTERVAL_MS);
    scheduler();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(drawLoop);
  }
  function stop() {
    playing = false;
    if (timerId) { clearInterval(timerId); timerId = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    scheduledSteps = [];
    pendingSong = null;
  }
  function setTempo(bpm) {
    if (song) song.tempo = Math.max(40, Math.min(300, bpm));
  }
  function setMute(name, muted) {
    if (!trackGains[name]) return;
    trackGains[name].muted = !!muted;
    applyGainValue(name);
  }
  function setVolume(name, vol) {
    if (!trackGains[name]) return;
    trackGains[name].volume = Math.max(0, Math.min(1.5, vol));
    applyGainValue(name);
  }
  function onStep(cb) { stepCb = cb; }
  function getSong() { return song; }
  function getIsPlaying() { return playing; }

  return {apply, play, stop, setTempo, setMute, setVolume, onStep, getSong, isPlaying: getIsPlaying};
}

/* ============ 7. オフラインWAV書き出し(ブラウザ専用) ============ */
async function renderWav(text, opts = {}) {
  const OfflineCtor = (typeof OfflineAudioContext !== 'undefined') ? OfflineAudioContext
    : (typeof webkitOfflineAudioContext !== 'undefined' ? webkitOfflineAudioContext : null);
  if (!OfflineCtor) throw new Error('この環境ではWAV書き出しができません(ブラウザで開いてね)');
  if (!Utau) throw new Error('engine.js(Utau)が読み込めていません');

  const song = parse(text);
  const stepDur = 60 / song.tempo / 4;
  const loops = opts.loops || 2;
  const totalSteps = song.loopLen16 * loops;
  const tailSec = 2.0;
  const durationSec = totalSteps * stepDur + tailSec;
  const sr = 44100;
  const ctx = new OfflineCtor(1, Math.ceil(durationSec * sr), sr);
  const compressor = ctx.createDynamicsCompressor();
  compressor.connect(ctx.destination);

  const gains = {};
  for (const name of Object.keys(song.tracks)) {
    const g = ctx.createGain(); g.connect(compressor); gains[name] = g;
  }
  const getDest = name => gains[name];

  let t = 0;
  for (let i = 0; i < totalSteps; i++) {
    const local = i % song.loopLen16;
    scheduleStep(song, getDest, ctx, local, t, stepDur);
    let delay = stepDur;
    if (song.swing) delay = stepDur * (1 + (i % 2 === 0 ? song.swing : -song.swing));
    t += delay;
  }

  const rendered = await ctx.startRendering();
  const samples = rendered.getChannelData(0).slice();
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak > 0) {
    const g = 0.89 / peak;
    for (let i = 0; i < samples.length; i++) samples[i] *= g;
  }
  return Utau.toWav(samples);
}

return {
  parse, createPlayer, renderWav, parsePitch,
  CHORD_NAMES: Object.keys(CHORD_DEF).filter(Boolean),
  DRUM_CHARS: Object.keys(DRUM_MAP)
};
});
