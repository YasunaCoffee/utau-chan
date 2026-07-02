#!/usr/bin/env node
/*
 * うたごえWAVの品質メトリクスを測る(テト調教の履歴用)
 *   node tools/analyze-teto.js <歌.wav> <譜面.uta>
 * 出力: 音程誤差(セント) / ビブラート検出数 / クリック数
 * ピッチ推定は YIN(110〜500Hzに制限してオクターブ誤りを回避)。
 */
'use strict';
const fs = require('fs');
const Utau = require('../engine.js');
const SR = 44100;
const midiToF = m => 440 * Math.pow(2, (m - 69) / 12);

const [wavPath, utaPath] = process.argv.slice(2);
if (!wavPath || !utaPath) { console.error('usage: node tools/analyze-teto.js <wav> <uta>'); process.exit(1); }

// --- WAV(16bit mono)読み込み ---
function readWav(p) {
  const b = fs.readFileSync(p);
  let off = 12, dataOff = 0, len = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; len = sz; }
    off += 8 + sz + (sz & 1);
  }
  const n = len / 2, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(dataOff + i * 2) / 32768;
  return x;
}
const x = readWav(wavPath);

// --- 譜面から意図した音程・時刻 ---
const song = Utau.parse(fs.readFileSync(utaPath, 'utf8'));
const st = 60 / song.tempo / 4;
const notes = song.notes
  .filter(n => { const p = Utau.parseMora(n.lyric); return !p.rest; })
  .map(n => ({ t0: n.start * st, dur: n.len * st, hz: midiToF(n.midi), midi: n.midi, lyric: n.lyric }));

// --- YIN F0(110-500Hz) ---
function f0(center, win) {
  const a = Math.max(0, Math.round((center - win / 2) * SR));
  const b = Math.min(x.length, Math.round((center + win / 2) * SR));
  const N = b - a; if (N < 400) return 0;
  const minLag = Math.floor(SR / 500), maxLag = Math.min(Math.floor(SR / 110), N >> 1);
  const d = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let s = 0; const lim = N - tau;
    for (let i = 0; i < lim; i += 2) { const dd = x[a + i] - x[a + i + tau]; s += dd * dd; }
    d[tau] = s;
  }
  let run = 0; const cm = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * (tau - minLag + 1) / run : 1; }
  let tau = -1;
  for (let t = minLag + 1; t < maxLag; t++) { if (cm[t] < 0.15) { while (t + 1 < maxLag && cm[t + 1] < cm[t]) t++; tau = t; break; } }
  if (tau < 0) { let mn = Infinity; for (let t = minLag; t <= maxLag; t++) if (cm[t] < mn) { mn = cm[t]; tau = t; } }
  return tau > 0 ? SR / tau : 0;
}
const cents = (f, tgt) => 1200 * Math.log2(f / tgt);
const median = a => { const s = [...a].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };

// 1) 音程誤差(1音を複数点で測り中央値→オクターブ誤検出に強い)
const errs = [];
for (const n of notes) {
  // 音の中心寄り(0.3〜0.55)で測る。後半は先行発声で隣の音にかぶり誤検出しやすい
  const cand = [0.3, 0.4, 0.5, 0.55].map(p => f0(n.t0 + n.dur * p, 0.07)).filter(f => f >= 110 && f <= 520);
  if (!cand.length) continue;
  errs.push(Math.abs(cents(median(cand), n.hz)));
}
const mean = errs.reduce((a, b) => a + b, 0) / (errs.length || 1);
const med = median(errs);
const over50 = errs.filter(e => e > 50).length;
// 2) ビブラート(長音のF0変動)
let vib = 0, flat = 0;
for (const n of notes) {
  if (n.dur < 0.5) continue;
  const fs = [];
  for (let t = 0.28; t < n.dur - 0.05; t += 0.03) { const f = f0(n.t0 + t, 0.07); if (f > 110 && f < 520) fs.push(f); }
  if (fs.length < 4) continue;
  const rng = 1200 * Math.log2(Math.max(...fs) / Math.min(...fs));
  if (rng < 15) flat++; else if (rng <= 130) vib++;
}
// 3) クリック
let j15 = 0, j25 = 0;
for (let i = 1; i < x.length; i++) { const d = Math.abs(x[i] - x[i - 1]); if (d > 0.15) j15++; if (d > 0.25) j25++; }

console.log(`# ${wavPath}`);
console.log(`音程誤差:  中央値 ${med.toFixed(0)}c  平均 ${mean.toFixed(0)}c  50c超 ${over50}/${errs.length}音`);
console.log(`ビブラート: 検出 ${vib}音  平坦 ${flat}音  (長音のみ)`);
console.log(`クリック:  |Δ|>0.15 ${j15}回  |Δ|>0.25 ${j25}回`);
console.log(`尺: ${(x.length / SR).toFixed(1)}秒`);
