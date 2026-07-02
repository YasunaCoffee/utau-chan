#!/usr/bin/env node
/*
 * うたうくん × 重音テト — うたテキスト譜面を「実録音サンプル(UTAU音源)」で歌わせる
 *
 *   node singteto.js songs/kirakira.uta            → songs/kirakira.teto.wav
 *   node singteto.js songs/kirakira.uta -o out.wav
 *   node singteto.js songs/kirakira.uta --bank /path/to/音源フォルダ
 *   オプション: --no-vib(ビブラート無効) --dry(残響無効)
 *
 * 通常の sing.js はフォルマント合成(録音なし)。こちらは録音WAV+oto.iniを
 * 切り貼りして歌わせるミニUTAUリサンプラー。
 *   - 連続音(VCV): エイリアス「a か / i き / - ら」…前の母音→子音の遷移録音でつなぐ
 *   - 単独音(CV) : エイリアス「か / き / あ」…かな1音ずつ
 * otoの内容から連続音/単独音を自動判別する。移調はサンプル毎の実測ピッチ(YIN)基準。
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
const BASE_MIDI = 63;          // 実測できなかった時の既定(重音テト単独音 ≈ D#4)
const midiToF = m => 440 * Math.pow(2, (m - 69) / 12);

/* ---- 引数 ---- */
const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
  console.log(`うたうくん × 重音テト — 譜面を実録音サンプルで歌わせる
つかいかた:
  node singteto.js <譜面.uta> [-o 出力.wav] [--bank <音源フォルダ>] [--no-vib] [--dry]
  連続音(VCV)/単独音(CV)は自動判別。音源は別途DL(再配布禁止)。既定の探索先:
    ~/dev/teto-voicebank/**/(重音テト連続音 または 重音テト単独音)
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

/* ---- 音源フォルダの解決(連続音を優先) ---- */
function findBank() {
  if (bankArg) return bankArg;
  if (process.env.UTAU_BANK) return process.env.UTAU_BANK;
  const root = path.join(os.homedir(), 'dev', 'teto-voicebank');
  if (fs.existsSync(root)) {
    for (const name of ['重音テト連続音', '重音テト単独音']) {
      const hit = walkFor(root, name, 5);
      if (hit) return hit;
    }
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
  console.error(`音源フォルダ(oto.iniのあるフォルダ)が見つかりません。
--bank で指定するか、UTAU_BANK 環境変数を設定してください。`);
  process.exit(1);
}

/* ---- oto.ini(Shift-JIS)を読む ---- */
// filename=alias,offset,consonant,cutoff,preutterance,overlap  (ms)
function loadOto(dir) {
  const text = new TextDecoder('shift_jis').decode(fs.readFileSync(path.join(dir, 'oto.ini')));
  const map = new Map();
  let vcv = false;
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const file = line.slice(0, eq);
    const r = line.slice(eq + 1).split(',');
    const alias = (r[0] || '').trim();
    if (!alias) continue;
    if (/^[aiueon] /.test(alias)) vcv = true;              // 「a か」式があれば連続音
    if (!map.has(alias)) map.set(alias, {
      file, offset: +r[1], cons: +r[2], cutoff: +r[3], pre: +r[4], ov: +r[5]
    });
  }
  return {map, vcv};
}
const OTO = loadOto(BANK);
const VOWEL_KANA = {a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お', n: 'ん'};

// かな + 直前の母音(a/i/u/e/o/n/-) → oto レコード
function resolveAlias(kana, prevV) {
  if (OTO.vcv) {
    return OTO.map.get(`${prevV} ${kana}`) || OTO.map.get(`- ${kana}`)
      // 語頭で「- き」が無い音源向け: 母音付きを借りる(先頭母音は buildNote で切る)
      || ['a', 'e', 'o', 'u', 'i', 'n'].map(v => OTO.map.get(`${v} ${kana}`)).find(Boolean) || null;
  }
  return OTO.map.get(kana) || OTO.map.get(`- ${kana}`) || OTO.map.get(`* ${kana}`) || null;
}

/* ---- WAV(16bit PCM mono)を読む ---- */
const wavCache = new Map();
function readWav(file) {
  if (wavCache.has(file)) return wavCache.get(file);
  const buf = fs.readFileSync(path.join(BANK, file));
  let p = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), sz = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = {ch: buf.readUInt16LE(p + 10), bits: buf.readUInt16LE(p + 22)};
    else if (id === 'data') { dataOff = p + 8; dataLen = sz; }
    p += 8 + sz + (sz & 1);
  }
  const ch = fmt ? fmt.ch : 1, bytes = (fmt ? fmt.bits : 16) / 8;
  const frames = Math.floor(dataLen / (bytes * ch));
  const f = new Float32Array(frames);
  for (let i = 0; i < frames; i++) f[i] = buf.readInt16LE(dataOff + i * bytes * ch) / 32768; // ch0
  const res = {data: f};
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
function resample(src, i0, i1, r) {
  const n = Math.max(0, Math.floor((i1 - i0) / r));
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = interp(src, i0 + k * r);
  return out;
}

// YINでサンプルの基準ピッチを推定(110〜500Hzに制限しオクターブ誤りを回避)
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
  let run = 0; const cm = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * (tau - minLag + 1) / run : 1; }
  let tau = -1;
  for (let t = minLag + 1; t < maxLag; t++) { if (cm[t] < 0.15) { while (t + 1 < maxLag && cm[t + 1] < cm[t]) t++; tau = t; break; } }
  if (tau < 0) { let mn = Infinity; for (let t = minLag; t <= maxLag; t++) if (cm[t] < mn) { mn = cm[t]; tau = t; } }
  if (tau <= minLag) return 0;
  const y0 = cm[tau - 1], y1 = cm[tau], y2 = cm[tau + 1] || y1, den = y0 - 2 * y1 + y2;
  return SR / (tau + (den !== 0 ? 0.5 * (y0 - y2) / den : 0));
}
const f0Cache = new Map();
function sampleF0(file, cEnd, end) {
  const key = file + '@' + cEnd;
  if (f0Cache.has(key)) return f0Cache.get(key);
  const src = readWav(file).data;
  let a = cEnd + ms(25), b = Math.min(end - ms(15), a + ms(220));
  if (b - a < ms(60)) { a = Math.max(0, cEnd); b = Math.min(src.length, a + ms(240)); }
  let f = yinF0(src, a, Math.min(b, src.length));
  if (!(f >= 130 && f <= 520)) f = midiToF(BASE_MIDI);
  f0Cache.set(key, f);
  return f;
}

// TD-PSOLA: 母音の定常部をピッチ同期の波形粒(2周期Hann)で重畳し、
// フォルマントを保ったまま目標ピッチへ移調&任意長へ伸長する。ループのうなりも出ない。
function psolaSustain(src, cEnd, end, f0src, fTarget, N, seed) {
  const out = new Float32Array(Math.max(0, N));
  if (N <= 0) return out;
  const P0 = Math.max(2, Math.round(SR / f0src));         // 元の基本周期
  const vlen = end - cEnd;
  const v0 = cEnd + Math.max(P0, Math.floor(vlen * 0.12)); // 定常部(遷移/末尾を避ける)
  const v1 = cEnd + Math.min(vlen - P0, Math.max(4 * P0, Math.floor(vlen * 0.7)));
  const marks = [];
  for (let m = v0; m <= v1; m += P0) marks.push(m);
  if (marks.length < 2) {                                 // 母音が短すぎ: 単純ループで代替
    for (let k = 0; k < N; k++) out[k] = interp(src, cEnd + (k % Math.max(1, vlen)));
    return out;
  }
  const vibHz = 5.7, vibPeak = useVib ? 0.0163 : 0, vibDelay = 0.22 * SR, vibRamp = 0.18 * SR;
  const half = P0, PtBase = SR / fTarget;
  let outPos = 0, mi = 0, dir = 1;
  while (outPos < N) {
    let vd = 0;
    if (useVib && outPos > vibDelay) { const g = Math.min(1, (outPos - vibDelay) / vibRamp); vd = vibPeak * g * Math.sin(2 * Math.PI * vibHz * outPos / SR + seed); }
    const Pt = PtBase / (1 + vd);                         // 目標周期(ビブラートで変調)
    const im = marks[mi], c = Math.round(outPos);
    const gain = Math.min(1.5, Pt / P0);                  // OLA密度の補正
    for (let k = -half; k <= half; k++) {
      const oi = c + k; if (oi < 0 || oi >= N) continue;
      const si = im + k; if (si < 0 || si >= src.length) continue;
      out[oi] += src[si] * (0.5 - 0.5 * Math.cos(Math.PI * (k + half) / half)) * gain;
    }
    outPos += Pt;
    mi += dir;                                            // マーク列をピンポンして定常母音を持続
    if (mi >= marks.length - 1) { mi = marks.length - 1; dir = -1; }
    else if (mi <= 0) { mi = 0; dir = 1; }
  }
  return out;
}

/* ---- 1音を合成: 固定頭(前母音→子音→母音頭) + 母音PSOLA持続 ---- */
// 返り値の buf は 拍前(preOut)+音価+余裕 の長さ。配置と音間クロスフェードは呼び出し側。
function buildNote(rec, midi, durSamp, seed, phraseStart) {
  const src = readWav(rec.file).data;
  const offSamp = Math.max(0, ms(rec.offset));
  let cEnd = offSamp + ms(rec.cons);
  const rawEnd = rec.cutoff >= 0 ? src.length - ms(rec.cutoff) : offSamp + ms(-rec.cutoff);
  const end = Math.min(src.length, Math.max(cEnd + ms(40), rawEnd));
  cEnd = Math.min(cEnd, end - ms(40));
  if (cEnd <= offSamp) cEnd = Math.min(offSamp + ms(40), end - ms(10));

  // 先行発声(頭の前母音)が長いと、前の音が次の子音直前まで届かず境界に音量の谷ができる。
  // 前母音は子音直前ぶんだけ残して切り詰める(語頭はさらに短く)。
  let s0 = offSamp, preMs = rec.pre;
  const leadCap = phraseStart ? 35 : 90;
  if (rec.pre > leadCap) { s0 = Math.min(offSamp + ms(rec.pre - leadCap), cEnd - ms(5)); preMs = leadCap; }

  const f0 = sampleF0(rec.file, cEnd, end);
  const r = midiToF(midi) / f0;                       // サンプル毎の実測基準で移調
  const preOut = Math.round(ms(preMs) / r);           // 出力での先行発声(拍までの前置き)
  const ovOut = Math.max(1, Math.round(ms(rec.ov) / r)); // 出力でのオーバーラップ

  const head = resample(src, s0, cEnd, r);            // 固定頭(子音+母音頭, 1回だけ)

  // 母音持続は PSOLA でフォルマント保持移調&伸長(ループのうなり無し)
  const total = Math.round(preOut + durSamp + ms(450)); // 次音とのXF分の余裕を含む
  const nRem = Math.max(0, total - head.length);
  const sustain = psolaSustain(src, cEnd, end, f0, midiToF(midi), nRem, seed);

  // 子音→母音の継ぎ目を短くクロスフェード
  const j = Math.min(ms(12), head.length, sustain.length);
  const buf = new Float32Array(head.length + sustain.length - j);
  buf.set(head, 0);
  for (let i = 0; i < sustain.length; i++) {
    const idx = head.length - j + i;
    if (i < j) buf[idx] = buf[idx] * Math.cos(0.5 * Math.PI * i / j) + sustain[i] * Math.sin(0.5 * Math.PI * i / j);
    else buf[idx] = sustain[i];
  }
  return {buf, preOut, ovOut};
}

// 軽いシュレーダー・リバーブ(コム4+オールパス2)
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
  const outb = new Float32Array(buf.length);
  for (let i = 0; i < outb.length; i++) outb[i] = buf[i] * (1 - wet) + tmp[i] * (wet / 4);
  return outb;
}

/* ---- メイン ---- */
const song = Utau.parse(fs.readFileSync(input, 'utf8'));
if (song.mode === 'かたり') {
  console.error('かたりモードはテトサンプル再生に未対応です(うたモードの譜面をどうぞ)。');
  process.exit(1);
}
const st = 60 / song.tempo / 4;
const notes = [...song.notes].sort((a, b) => a.start - b.start);
const totalSec = notes.reduce((m, n) => Math.max(m, (n.start + n.len) * st), 0) + 1.0;
let master = new Float32Array(Math.ceil(totalSec * SR) + SR);

// --- パスA: 各音を合成(prevVを連鎖させて連続音のエイリアスを決める) ---
const jobs = [];
let prevV = '-', missing = new Set();
for (const n of notes) {
  const ph = Utau.parseMora(n.lyric);
  const beat = Math.round(n.start * st * SR);
  if (ph.rest) { jobs.push({rest: true, beat}); prevV = '-'; continue; }
  let vowel = ph.v === 'N' ? 'n' : (ph.v || 'a');
  let kana = n.lyric;
  if (ph.ext) { kana = VOWEL_KANA[prevV] || 'あ'; vowel = prevV === '-' ? 'a' : prevV; }
  let rec = resolveAlias(kana, prevV);
  if (!rec) { const vk = VOWEL_KANA[vowel] || 'あ'; rec = resolveAlias(vk, prevV); if (rec) missing.add(`${n.lyric}→${vk}`); }
  if (!rec) { missing.add(`${n.lyric}(欠)`); prevV = vowel; continue; }
  const built = buildNote(rec, n.midi, Math.round(n.len * st * SR), jobs.length + 1, prevV === '-');
  const g = (n.mods || '').includes('!') ? 1.25 : (n.mods || '').includes('?') ? 0.7 : 1;
  jobs.push({rest: false, beat, built, g});
  prevV = vowel;
}

// --- パスB: 配置 + 音間の等パワークロスフェード ---
let placed = 0;
for (let i = 0; i < jobs.length; i++) {
  const job = jobs[i];
  if (job.rest || !job.built) continue;
  const {buf, preOut, ovOut} = job.built;
  const start = Math.max(0, job.beat - preOut);
  // クロスフェード長(前母音を切り詰めたので少し長めでも重なりは短く、うなりを抑えられる)
  const XFMAX = ms(60);
  const fiLen = Math.max(ms(6), Math.min(ovOut, XFMAX));           // この音の入り(前音とXF)
  // 次の非休符ジョブ(休符が挟まれば無し=リリース)
  let nxt = null;
  for (let k = i + 1; k < jobs.length; k++) { if (jobs[k].rest) break; if (jobs[k].built) { nxt = jobs[k]; break; } }
  let outLen, foLen;
  if (nxt) {
    const nStart = Math.max(0, nxt.beat - nxt.built.preOut);
    const nFi = Math.max(ms(6), Math.min(nxt.built.ovOut, XFMAX));  // 次の音の入りに合わせて出る
    outLen = Math.min(buf.length, Math.max(fiLen + ms(20), nStart + nFi - start));
    foLen = Math.max(ms(6), Math.min(outLen - fiLen, nFi));
  } else {
    outLen = Math.min(buf.length, preOut + ms(400));
    foLen = ms(60);
  }
  for (let k = 0; k < outLen && start + k < master.length; k++) {
    let s = buf[k];
    if (k < fiLen) s *= Math.sin(0.5 * Math.PI * k / fiLen);          // 前音とのXF(フェードイン)
    const dEnd = outLen - 1 - k;
    if (dEnd < foLen) s *= Math.sin(0.5 * Math.PI * dEnd / foLen);    // 次音とのXF(フェードアウト)
    master[start + k] += s * job.g;
  }
  placed++;
}

/* ---- 仕上げ ---- */
if (useReverb) master = reverb(master, 0.18);
let peak = 0;
for (let i = 0; i < master.length; i++) { const a = Math.abs(master[i]); if (a > peak) peak = a; }
if (peak > 0) { const s = 0.89 / peak; for (let i = 0; i < master.length; i++) master[i] *= s; }
fs.writeFileSync(out, Buffer.from(Utau.toWav(master)));

console.log(`🎤×重音テト [${OTO.vcv ? '連続音VCV' : '単独音CV'}] / ♩=${song.tempo} / ${placed}音 / ${totalSec.toFixed(1)}秒`
  + ` / ビブ:${useVib ? '有' : '無'} / 残響:${useReverb ? '有' : '無'}`);
console.log(`   音源: ${BANK.replace(os.homedir(), '~')}`);
console.log(`   → ${out}`);
if (missing.size) console.log(`   ※ 代替/欠落: ${[...missing].join(', ')}`);
