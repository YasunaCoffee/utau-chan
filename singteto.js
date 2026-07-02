#!/usr/bin/env node
/*
 * うたうくん × 重音テト — うたテキスト譜面を「実録音サンプル(UTAU音源)」で歌わせる
 *
 *   node singteto.js songs/kirakira.uta            → songs/kirakira.teto.wav
 *   node singteto.js songs/kirakira.uta -o out.wav
 *   node singteto.js songs/kirakira.uta --bank /path/to/単独音フォルダ
 *
 * 通常の sing.js はフォルマント合成(録音なし)。こちらは録音WAV+oto.iniを
 * 切り貼りして歌わせる、ミニUTAUリサンプラー。単独音(CV)ライブラリー対応。
 *
 * ※ 音源ファイルは同梱しない。重音テト音源(小山乃舞世)の再配布は規約で禁止。
 *   各自ダウンロードしたフォルダを --bank / UTAU_BANK で指す。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const Utau = require('./engine.js');

const SR = 44100;
const BASE_MIDI = 63;          // 録音の基準ピッチ(実測: 重音テト単独音 ≈ D#4)
const midiToF = m => 440 * Math.pow(2, (m - 69) / 12);

/* ---- 引数 ---- */
const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
  console.log(`うたうくん × 重音テト — 譜面を実録音サンプルで歌わせる
つかいかた:
  node singteto.js <譜面.uta> [-o 出力.wav] [--bank <単独音フォルダ>]
  音源は別途ダウンロード(再配布禁止)。既定の探索先:
    ~/dev/teto-voicebank/**/重音テト単独音
  環境変数 UTAU_BANK でも指定可。`);
  process.exit(args.length ? 0 : 1);
}
let input = null, out = null, bankArg = null, useReverb = true, useVib = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
  else if (args[i] === '--bank') bankArg = args[++i];
  else if (args[i] === '--dry') useReverb = false;
  else if (args[i] === '--no-vib') useVib = false;
  else input = args[i];
}
if (!out) out = path.join(path.dirname(input),
  path.basename(input, path.extname(input)) + '.teto.wav');

/* ---- 音源フォルダの解決 ---- */
function findBank() {
  if (bankArg) return bankArg;
  if (process.env.UTAU_BANK) return process.env.UTAU_BANK;
  const roots = [path.join(os.homedir(), 'dev', 'teto-voicebank')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const hit = walkFor(root, '重音テト単独音', 5);
    if (hit) return hit;
  }
  return null;
}
function walkFor(dir, name, depth) {
  if (depth < 0) return null;
  let ents; try { ents = fs.readdirSync(dir, {withFileTypes: true}); } catch { return null; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name === name && fs.existsSync(path.join(p, 'oto.ini'))) return p;
    const sub = walkFor(p, name, depth - 1);
    if (sub) return sub;
  }
  return null;
}
const BANK = findBank();
if (!BANK || !fs.existsSync(path.join(BANK, 'oto.ini'))) {
  console.error(`音源フォルダ(oto.iniのある単独音フォルダ)が見つかりません。
--bank で指定するか、UTAU_BANK 環境変数を設定してください。
例: node singteto.js ${input || '譜面.uta'} --bank "~/dev/teto-voicebank/TETO-tougou-110401/重音テト音声ライブラリー/重音テト単独音"`);
  process.exit(1);
}

/* ---- oto.ini(Shift-JIS)を読む ---- */
// filename=alias,offset,consonant,cutoff,preutterance,overlap  (ms)
function loadOto(dir) {
  const raw = fs.readFileSync(path.join(dir, 'oto.ini'));
  const text = new TextDecoder('shift_jis').decode(raw);
  const plain = new Map(), any = new Map();
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const file = line.slice(0, eq);
    const rest = line.slice(eq + 1).split(',');
    const alias = (rest[0] || '').trim();
    const [offset, cons, cutoff, pre, ov] = rest.slice(1).map(Number);
    const rec = {file, offset, cons, cutoff, pre, ov};
    if (!alias) continue;
    if (!any.has(alias)) any.set(alias, rec);
    if (!/\s/.test(alias) && !plain.has(alias)) plain.set(alias, rec);  // 「あ」を「- あ」より優先
  }
  return {plain, any};
}
const OTO = loadOto(BANK);
const VOWEL_KANA = {a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お', n: 'ん'};

function lookup(kana) {
  return OTO.plain.get(kana) || OTO.any.get(kana) || null;
}

/* ---- WAV(16bit PCM mono)を読む ---- */
const wavCache = new Map();
function readWav(file) {
  if (wavCache.has(file)) return wavCache.get(file);
  const buf = fs.readFileSync(path.join(BANK, file));
  // RIFFチャンク走査
  let p = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const sz = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = {ch: buf.readUInt16LE(p + 10), sr: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22)};
    else if (id === 'data') { dataOff = p + 8; dataLen = sz; }
    p += 8 + sz + (sz & 1);
  }
  const ch = fmt ? fmt.ch : 1, bits = fmt ? fmt.bits : 16;
  const bytes = bits / 8, frames = Math.floor(dataLen / (bytes * ch));
  const f = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const s = buf.readInt16LE(dataOff + i * bytes * ch);   // ch0のみ
    f[i] = s / 32768;
  }
  const res = {data: f, sr: fmt ? fmt.sr : SR};
  wavCache.set(file, res);
  return res;
}

/* ---- DSP小物 ---- */
const ms = m => Math.round(m * SR / 1000);
function interp(src, x) {
  if (x < 0) return 0;
  const i = x | 0; if (i + 1 >= src.length) return src[src.length - 1] || 0;
  const fr = x - i; return src[i] * (1 - fr) + src[i + 1] * fr;
}
// srcの[i0,i1)をステップrで線形リサンプル(r>1で高く・短く)
function resample(src, i0, i1, r) {
  const n = Math.max(0, Math.floor((i1 - i0) / r));
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = interp(src, i0 + k * r);
  return out;
}
function envelope(buf, fadeIn, fadeOut) {
  const a = ms(fadeIn), b = ms(fadeOut);
  for (let i = 0; i < a && i < buf.length; i++) buf[i] *= Math.sin(0.5 * Math.PI * i / a);
  for (let i = 0; i < b && i < buf.length; i++) buf[buf.length - 1 - i] *= Math.sin(0.5 * Math.PI * i / b);
  return buf;
}

// YINでサンプルの基準ピッチを推定(調波/subharmonicのオクターブ誤りに強い)
// 探索範囲を110〜500Hzに絞り、テト単独音(D4〜D#4)を確実に当てる
function yinF0(src, a, b) {
  const N = b - a;
  const minLag = Math.floor(SR / 500), maxLag = Math.min(Math.floor(SR / 110), N >> 1);
  if (maxLag <= minLag + 2) return 0;
  const d = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let s = 0; const lim = N - tau;
    for (let i = 0; i < lim; i++) { const dd = src[a + i] - src[a + i + tau]; s += dd * dd; }
    d[tau] = s;
  }
  const cmnd = new Float32Array(maxLag + 1);
  let run = 0;
  for (let tau = minLag; tau <= maxLag; tau++) { run += d[tau]; cmnd[tau] = run > 0 ? d[tau] * (tau - minLag + 1) / run : 1; }
  let tau = -1;
  for (let t = minLag + 1; t < maxLag; t++) {
    if (cmnd[t] < 0.15) { while (t + 1 < maxLag && cmnd[t + 1] < cmnd[t]) t++; tau = t; break; }
  }
  if (tau < 0) { let mn = Infinity; for (let t = minLag; t <= maxLag; t++) if (cmnd[t] < mn) { mn = cmnd[t]; tau = t; } }
  if (tau <= minLag) return 0;
  const y0 = cmnd[tau - 1], y1 = cmnd[tau], y2 = cmnd[tau + 1] || y1;   // 放物線補間(極小)
  const den = y0 - 2 * y1 + y2;
  const period = tau + (den !== 0 ? 0.5 * (y0 - y2) / den : 0);
  return SR / period;
}
const f0Cache = new Map();
function sampleF0(file, s0, cEnd, end) {
  if (f0Cache.has(file)) return f0Cache.get(file);
  const src = readWav(file).data;
  let a = cEnd + ms(25), b = Math.min(end - ms(15), a + ms(220));
  if (b - a < ms(60)) { a = Math.min(s0 + ms(60), src.length - 1); b = Math.min(src.length, a + ms(240)); }
  let f = yinF0(src, a, Math.min(b, src.length));
  if (!(f >= 130 && f <= 520)) f = midiToF(BASE_MIDI);   // 失敗時は既定D#4
  f0Cache.set(file, f);
  return f;
}

/* ---- 1音を合成 ---- */
// 固定子音部 + 母音をクロスフェードループで伸長(ビブラート付き)。移調はサンプル実測ピッチ基準。
function synthNote(kana, midi, durSamp, seed) {
  const oto = lookup(kana);
  if (!oto) return null;
  const src = readWav(oto.file).data;
  const s0 = Math.max(0, ms(oto.offset));
  let cEnd = s0 + ms(oto.cons);
  const sEnd = oto.cutoff >= 0 ? src.length - ms(oto.cutoff) : s0 + ms(-oto.cutoff);
  const end = Math.min(src.length, Math.max(cEnd + ms(40), sEnd));
  cEnd = Math.min(cEnd, end - ms(40));
  const f0 = sampleF0(oto.file, s0, cEnd, end);
  const r = midiToF(midi) / f0;                          // ← サンプル毎の実測基準で移調

  const cons = resample(src, s0, cEnd, r);               // 固定の子音部(移調のみ)

  // 母音ループ区間(頭の遷移と末尾の減衰を避けた安定域)
  let lp0 = cEnd + ms(15), lp1 = end - ms(15);
  if (lp1 - lp0 < ms(50)) { lp0 = cEnd; lp1 = end; }
  const L = lp1 - lp0, xf = Math.max(1, Math.min(ms(25), Math.floor(L * 0.4)));

  const nRem = Math.max(0, durSamp - cons.length);
  const sustain = new Float32Array(nRem);
  const vibHz = 5.7, vibPeak = useVib ? 0.0163 : 0;      // ±約28セント
  const vibDelay = 0.22 * SR, vibRamp = 0.18 * SR;
  let phase = ((seed * 0.37) % 1) * Math.max(1, L - xf); // ノート毎に位相をずらす(ループ癖を隠す)
  for (let k = 0; k < nRem; k++) {
    let vd = 0;
    if (useVib && k > vibDelay) {
      const g = Math.min(1, (k - vibDelay) / vibRamp);
      vd = vibPeak * g * Math.sin(2 * Math.PI * vibHz * k / SR + seed);
    }
    const rate = r * (1 + vd);
    let out;
    if (phase < L - xf) out = interp(src, lp0 + phase);
    else {                                               // 継ぎ目を等パワークロスフェード(クリック防止)
      const u = (phase - (L - xf)) / xf;
      out = interp(src, lp0 + phase) * Math.cos(0.5 * Math.PI * u)
          + interp(src, lp0 + (phase - (L - xf))) * Math.sin(0.5 * Math.PI * u);
    }
    sustain[k] = out;
    phase += rate;
    if (phase >= L) phase -= (L - xf);
  }

  // 子音→母音の継ぎ目を短くクロスフェード
  const j = Math.min(ms(10), cons.length, sustain.length);
  const note = new Float32Array(cons.length + sustain.length - j);
  note.set(cons, 0);
  for (let i = 0; i < sustain.length; i++) {
    const idx = cons.length - j + i;
    if (i < j) note[idx] = note[idx] * Math.cos(0.5 * Math.PI * i / j) + sustain[i] * Math.sin(0.5 * Math.PI * i / j);
    else note[idx] = sustain[i];
  }
  return {buf: envelope(note, 8, 45), consLen: Math.max(0, cons.length - j)};
}

// 軽いシュレーダー・リバーブ(コム4+オールパス2)。ソロ声に少しだけ空気感を足す
function reverb(buf, wet) {
  const tmp = new Float32Array(buf.length);
  for (const [d, g] of [[1557, 0.76], [1617, 0.74], [1491, 0.78], [1422, 0.72]]) {
    const z = new Float32Array(d); let p = 0;
    for (let i = 0; i < buf.length; i++) { const y = buf[i] + g * z[p]; z[p] = y; tmp[i] += y; p = p + 1 === d ? 0 : p + 1; }
  }
  for (const [d, g] of [[225, 0.5], [556, 0.5]]) {
    const z = new Float32Array(d); let p = 0;
    for (let i = 0; i < tmp.length; i++) { const x = tmp[i], y = -g * x + z[p]; z[p] = x + g * y; tmp[i] = y; p = p + 1 === d ? 0 : p + 1; }
  }
  const out = new Float32Array(buf.length);
  for (let i = 0; i < out.length; i++) out[i] = buf[i] * (1 - wet) + tmp[i] * (wet / 4);
  return out;
}

/* ---- メイン: 譜面 → ミックス ---- */
const song = Utau.parse(fs.readFileSync(input, 'utf8'));
if (song.mode === 'かたり') {
  console.error('かたりモードはテトサンプル再生に未対応です(うたモードの譜面をどうぞ)。');
  process.exit(1);
}
const st = 60 / song.tempo / 4;                 // 16分音符あたりの秒
const notes = [...song.notes].sort((a, b) => a.start - b.start);
const totalSec = notes.reduce((m, n) => Math.max(m, (n.start + n.len) * st), 0) + 0.8;
let master = new Float32Array(Math.ceil(totalSec * SR) + SR);

let prevVowel = 'a', placed = 0, idx = 0, missing = new Set();
for (const n of notes) {
  idx++;
  let ph = Utau.parseMora(n.lyric);
  if (ph.rest) continue;
  let kana = n.lyric;
  if (ph.ext) kana = VOWEL_KANA[prevVowel] || 'あ';       // ー = 直前の母音を伸ばす
  const durSamp = Math.round(n.len * st * SR);
  let res = synthNote(kana, n.midi, durSamp, idx);
  if (!res) {                                             // 無ければ母音のみで代替
    const vk = VOWEL_KANA[ph.v] || 'あ';
    res = synthNote(vk, n.midi, durSamp, idx);
    if (res) missing.add(`${n.lyric}→${vk}`);
  }
  if (!res) { missing.add(`${n.lyric}(欠)`); continue; }
  if (ph.v) prevVowel = ph.v;
  // 子音は拍より前から鳴らす(先行発声風)。母音が拍頭に来るように前詰め
  let at = Math.round(n.start * st * SR) - res.consLen;
  if (at < 0) at = 0;
  const g = (n.mods || '').includes('!') ? 1.25 : (n.mods || '').includes('?') ? 0.7 : 1;
  for (let i = 0; i < res.buf.length && at + i < master.length; i++) master[at + i] += res.buf[i] * g;
  placed++;
}

/* ---- 仕上げ: リバーブ → 正規化 → 書き出し ---- */
if (useReverb) master = reverb(master, 0.18);
let peak = 0;
for (let i = 0; i < master.length; i++) { const a = Math.abs(master[i]); if (a > peak) peak = a; }
if (peak > 0) { const s = 0.89 / peak; for (let i = 0; i < master.length; i++) master[i] *= s; }
fs.writeFileSync(out, Buffer.from(Utau.toWav(master)));

console.log(`🎤×重音テト / ♩=${song.tempo} / ${placed}音 / ${totalSec.toFixed(1)}秒`
  + ` / ビブ:${useVib ? '有' : '無'} / 残響:${useReverb ? '有' : '無'}`);
console.log(`   音源: ${BANK.replace(os.homedir(), '~')}`);
console.log(`   → ${out}`);
if (missing.size) console.log(`   ※ 代替/欠落: ${[...missing].join(', ')}`);
