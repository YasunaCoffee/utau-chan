/*
 * うたうちゃん テトエンジン — UTAU音源(oto.ini + 録音WAV)で譜面を歌わせる合成コア
 *
 * singteto.js(CLI)から合成部分を切り出したUMDモジュール。ブラウザ(index.htmlの
 * 「テト音源をよみこむ」)とNode(singteto.js)の両方から使う。ファイルの読み方だけ
 * 呼び出し側が bank.getFile で注入する(fsにもFile APIにも依存しない)。
 *
 *   const oto = Teto.parseOto(shiftJisをデコードしたテキスト);
 *   const {samples, placed, missing} = await Teto.render(song, {
 *     oto,
 *     getFile: async (ファイル名) => ArrayBuffer,   // WAVの中身
 *   }, {useVib: true, useReverb: true});
 *
 *   - 連続音(VCV)/単独音(CV)を oto から自動判別
 *   - 移調はサンプル毎の実測ピッチ(YIN)基準
 *   - 母音は TD-PSOLA でフォルマント保持のまま伸長+ビブラート
 *   - 音のつなぎは等パワークロスフェード、仕上げにシュレーダー残響
 *
 * ※ 音源ファイルは同梱しない。重音テト音源(小山乃舞世)の再配布は規約で禁止。
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Teto = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

let Utau = (typeof globalThis !== 'undefined' && globalThis.Utau) || null;
if (!Utau && typeof require !== 'undefined') {
  try { Utau = require('./engine.js'); } catch (_) { /* ブラウザ内requireなど */ }
}

const SR = 44100;
const BASE_MIDI = 63;          // 実測できなかった時の既定(重音テト単独音 ≈ D#4)
const midiToF = m => 440 * Math.pow(2, (m - 69) / 12);
const ms = m => Math.round(m * SR / 1000);
const VOWEL_KANA = {a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お', n: 'ん'};

/* ---- oto.ini(デコード済みテキスト)を読む ---- */
// filename=alias,offset,consonant,cutoff,preutterance,overlap  (ms)
function parseOto(text) {
  const map = new Map();
  let vcv = false;
  for (const line of String(text).split(/\r?\n/)) {
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

// かな + 直前の母音(a/i/u/e/o/n/-) → oto レコード
function resolveAlias(oto, kana, prevV) {
  if (oto.vcv) {
    return oto.map.get(`${prevV} ${kana}`) || oto.map.get(`- ${kana}`)
      // 語頭で「- き」が無い音源向け: 母音付きを借りる(先頭母音は buildNote で切る)
      || ['a', 'e', 'o', 'u', 'i', 'n'].map(v => oto.map.get(`${v} ${kana}`)).find(Boolean) || null;
  }
  return oto.map.get(kana) || oto.map.get(`- ${kana}`) || oto.map.get(`* ${kana}`) || null;
}

/* ---- WAV(16bit PCM)を読む: ArrayBuffer → Float32Array(ch0) ---- */
function decodeWav(ab) {
  const dv = new DataView(ab);
  const ascii = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(o + i)); return s; };
  let p = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (p + 8 <= dv.byteLength) {
    const id = ascii(p, 4), sz = dv.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = {ch: dv.getUint16(p + 10, true), bits: dv.getUint16(p + 22, true)};
    else if (id === 'data') { dataOff = p + 8; dataLen = sz; }
    p += 8 + sz + (sz & 1);
  }
  const ch = fmt ? fmt.ch : 1, bytes = (fmt ? fmt.bits : 16) / 8;
  const frames = Math.floor(Math.min(dataLen, dv.byteLength - dataOff) / (bytes * ch));
  const f = new Float32Array(Math.max(0, frames));
  for (let i = 0; i < frames; i++) f[i] = dv.getInt16(dataOff + i * bytes * ch, true) / 32768; // ch0
  return f;
}

/* ---- DSP小物 ---- */
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

// TD-PSOLA: 母音の定常部をピッチ同期の波形粒(2周期Hann)で重畳し、
// フォルマントを保ったまま目標ピッチへ移調&任意長へ伸長する。ループのうなりも出ない。
function psolaSustain(src, cEnd, end, f0src, fTarget, N, seed, useVib) {
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
function buildNote(src, rec, midi, durSamp, seed, phraseStart, useVib, f0Cache) {
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

  // サンプルの基準ピッチ(YIN、ファイル+子音位置でキャッシュ)
  const f0Key = rec.file + '@' + cEnd;
  let f0 = f0Cache.get(f0Key);
  if (f0 === undefined) {
    let a = cEnd + ms(25), b = Math.min(end - ms(15), a + ms(220));
    if (b - a < ms(60)) { a = Math.max(0, cEnd); b = Math.min(src.length, a + ms(240)); }
    f0 = yinF0(src, a, Math.min(b, src.length));
    if (!(f0 >= 130 && f0 <= 520)) f0 = midiToF(BASE_MIDI);
    f0Cache.set(f0Key, f0);
  }

  const r = midiToF(midi) / f0;                       // サンプル毎の実測基準で移調
  const preOut = Math.round(ms(preMs) / r);           // 出力での先行発声(拍までの前置き)
  const ovOut = Math.max(1, Math.round(ms(rec.ov) / r)); // 出力でのオーバーラップ

  const head = resample(src, s0, cEnd, r);            // 固定頭(子音+母音頭, 1回だけ)

  // 母音持続は PSOLA でフォルマント保持移調&伸長(ループのうなり無し)
  const total = Math.round(preOut + durSamp + ms(450)); // 次音とのXF分の余裕を含む
  const nRem = Math.max(0, total - head.length);
  const sustain = psolaSustain(src, cEnd, end, f0, midiToF(midi), nRem, seed, useVib);

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

/* ---- メイン: 譜面 + 音源 → 歌声波形 ---- */
async function render(song, bank, opts = {}) {
  if (!Utau) throw new Error('engine.js(Utau)が読み込めていません');
  if (song.mode === 'かたり') throw new Error('かたりモードはテトサンプル再生に未対応です(うたモードの譜面をどうぞ)');
  const useVib = opts.useVib !== false, useReverb = opts.useReverb !== false;
  const oto = bank.oto;
  const st = 60 / song.tempo / 4;
  const notes = [...song.notes].sort((a, b) => a.start - b.start);
  const totalSec = notes.reduce((m, n) => Math.max(m, (n.start + n.len) * st), 0) + 1.0;
  let master = new Float32Array(Math.ceil(totalSec * SR) + SR);

  // --- パス0: エイリアス解決(prevVを連鎖させて連続音のエイリアスを決める) ---
  const plan = [];
  let prevV = '-';
  const missing = new Set();
  for (const n of notes) {
    const ph = Utau.parseMora(n.lyric);
    const beat = Math.round(n.start * st * SR);
    if (ph.rest) { plan.push({rest: true, beat}); prevV = '-'; continue; }
    let vowel = ph.v === 'N' ? 'n' : (ph.v || 'a');
    let kana = n.lyric;
    if (ph.ext) { kana = VOWEL_KANA[prevV] || 'あ'; vowel = prevV === '-' ? 'a' : prevV; }
    let rec = resolveAlias(oto, kana, prevV);
    if (!rec) { const vk = VOWEL_KANA[vowel] || 'あ'; rec = resolveAlias(oto, vk, prevV); if (rec) missing.add(`${n.lyric}→${vk}`); }
    if (!rec) { missing.add(`${n.lyric}(欠)`); prevV = vowel; continue; }
    plan.push({rest: false, beat, rec, midi: n.midi, durSamp: Math.round(n.len * st * SR),
      mods: n.mods || '', phraseStart: prevV === '-'});
    prevV = vowel;
  }

  // --- 使うWAVだけ読み込む(getFileはasync: ブラウザのFile APIにもfsにも合う) ---
  const wavs = new Map();
  for (const p of plan) {
    if (p.rest || wavs.has(p.rec.file)) continue;
    let ab = null;
    try { ab = await bank.getFile(p.rec.file); } catch (_) { /* 下でmissing扱い */ }
    if (ab) wavs.set(p.rec.file, decodeWav(ab));
    else { missing.add(`${p.rec.file}(WAV欠)`); }
  }

  // --- パスA: 各音を合成 ---
  const jobs = [];
  const f0Cache = new Map();
  for (const p of plan) {
    if (p.rest) { jobs.push({rest: true, beat: p.beat}); continue; }
    const src = wavs.get(p.rec.file);
    if (!src || !src.length) { continue; }
    const built = buildNote(src, p.rec, p.midi, p.durSamp, jobs.length + 1, p.phraseStart, useVib, f0Cache);
    const g = p.mods.includes('!') ? 1.25 : p.mods.includes('?') ? 0.7 : 1;
    jobs.push({rest: false, beat: p.beat, built, g});
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

  // 再生ハイライト用のタイムライン(engine.jsのrenderと同形式)
  const timeline = notes
    .filter(n => !Utau.parseMora(n.lyric).rest)
    .map(n => {
      const ph = Utau.parseMora(n.lyric);
      return {t0: n.start * st, t1: (n.start + n.len) * st, v: ph.ext ? 'a' : ph.v, lyric: n.lyric, midi: n.midi};
    });

  return {samples: master, duration: totalSec, timeline, placed, missing: [...missing], vcv: oto.vcv};
}

return {SR, parseOto, resolveAlias, decodeWav, render};
});
