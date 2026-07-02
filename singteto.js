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
let input = null, out = null, bankArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
  else if (args[i] === '--bank') bankArg = args[++i];
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
// grainを等パワークロスフェードで敷き詰めて長さNの持続音を作る
function tile(grain, N, xf) {
  const out = new Float32Array(N);
  if (grain.length === 0) return out;
  xf = Math.min(xf, grain.length >> 1);
  let pos = 0;                       // 出力書き込み位置
  let first = true;
  while (pos < N) {
    const start = first ? 0 : -xf;   // 2枚目以降は前の末尾にxfだけ重ねる
    for (let k = 0; k < grain.length && pos + start + k < N; k++) {
      const wpos = pos + start + k;
      if (wpos < 0) continue;
      let g = grain[k];
      if (!first && k < xf) {        // フェードイン(等パワー)
        g *= Math.sin(0.5 * Math.PI * k / xf);
      }
      if (k > grain.length - xf) {   // フェードアウト(次と重なる分)
        g *= Math.sin(0.5 * Math.PI * (grain.length - k) / xf);
      }
      out[wpos] += g;
    }
    pos += grain.length + start;
    first = false;
    if (grain.length + start <= 0) break;
  }
  return out;
}
function envelope(buf, fadeIn, fadeOut) {
  const a = ms(fadeIn), b = ms(fadeOut);
  for (let i = 0; i < a && i < buf.length; i++) buf[i] *= i / a;
  for (let i = 0; i < b && i < buf.length; i++) buf[buf.length - 1 - i] *= i / b;
  return buf;
}

/* ---- 1音を合成 ---- */
function synthNote(kana, midi, durSamp) {
  const oto = lookup(kana);
  if (!oto) return null;
  const w = readWav(oto.file);
  const src = w.data;
  const r = midiToF(midi) / midiToF(BASE_MIDI);        // ピッチ移調比
  const s0 = Math.max(0, ms(oto.offset));
  let cEnd = s0 + ms(oto.cons);
  const sEnd = oto.cutoff >= 0 ? src.length - ms(oto.cutoff) : s0 + ms(-oto.cutoff);
  const end = Math.min(src.length, Math.max(cEnd + 1, sEnd));
  cEnd = Math.min(cEnd, end);

  const cons = resample(src, s0, cEnd, r);             // 固定の子音部(移調のみ)
  // 母音ループ元は母音区間の中央付近(頭の遷移と末尾の減衰を避ける)
  const vlen = end - cEnd;
  const m0 = cEnd + Math.floor(vlen * 0.15), m1 = end - Math.floor(vlen * 0.10);
  const grain = resample(src, Math.max(cEnd, m0), Math.max(m0 + 1, m1), r);

  const nRem = Math.max(0, durSamp - cons.length);
  const sustain = tile(grain, nRem, ms(35));
  const note = new Float32Array(cons.length + sustain.length);
  note.set(cons, 0); note.set(sustain, cons.length);
  return {buf: envelope(note, 6, 30), consLen: cons.length};
}

/* ---- メイン: 譜面 → ミックス ---- */
const song = Utau.parse(fs.readFileSync(input, 'utf8'));
if (song.mode === 'かたり') {
  console.error('かたりモードはテトサンプル再生に未対応です(うたモードの譜面をどうぞ)。');
  process.exit(1);
}
const st = 60 / song.tempo / 4;                 // 16分音符あたりの秒
const notes = [...song.notes].sort((a, b) => a.start - b.start);
const totalSec = notes.reduce((m, n) => Math.max(m, (n.start + n.len) * st), 0) + 0.6;
const master = new Float32Array(Math.ceil(totalSec * SR) + SR);

let prevVowel = 'a', placed = 0, missing = new Set();
for (const n of notes) {
  let ph = Utau.parseMora(n.lyric);
  if (ph.rest) { prevVowel = prevVowel; continue; }
  let kana = n.lyric;
  if (ph.ext) kana = VOWEL_KANA[prevVowel] || 'あ';       // ー = 直前の母音を伸ばす
  let res = synthNote(kana, n.midi, Math.round(n.len * st * SR));
  if (!res) {                                             // 無ければ母音のみで代替
    const vk = VOWEL_KANA[ph.v] || 'あ';
    res = synthNote(vk, n.midi, Math.round(n.len * st * SR));
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

/* ---- 正規化して書き出し ---- */
let peak = 0;
for (let i = 0; i < master.length; i++) { const a = Math.abs(master[i]); if (a > peak) peak = a; }
if (peak > 0) { const s = 0.89 / peak; for (let i = 0; i < master.length; i++) master[i] *= s; }
fs.writeFileSync(out, Buffer.from(Utau.toWav(master)));

console.log(`🎤×重音テト / ♩=${song.tempo} / ${placed}音 / ${totalSec.toFixed(1)}秒`);
console.log(`   音源: ${BANK.replace(os.homedir(), '~')}`);
console.log(`   → ${out}`);
if (missing.size) console.log(`   ※ 代替/欠落: ${[...missing].join(', ')}`);
