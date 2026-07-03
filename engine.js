/*
 * うたうちゃん エンジン — テキスト譜面 → 歌声波形
 *
 * AIが書きやすい「うたテキスト」を解析し、フォルマント合成で
 * 歌声のFloat32Array(44.1kHz mono)を生成する。ブラウザとNodeの両方で動く。
 *
 *   const song = Utau.parse(text);
 *   const {samples, duration, timeline} = Utau.render(song);
 *   const wav = Utau.toWav(samples);   // ArrayBuffer
 *
 * ── うたテキスト形式 ──────────────────────────────
 *   # コメント
 *   @tempo 110          テンポ(BPM)
 *   @voice うたこ        うたこ / ちびすけ / ロボまる / おじさま
 *   @style ふつう        べたうち / ふつう / こぶし / ささやき / げんき
 *
 *   ど4:き ど4:ら そ4:き:8 ・:4 ふぁ4:よ …
 *
 *   音符 = 音の高さ:歌詞[:長さ][調教記号]
 *     高さ  … ど れ み ふぁ そ ら し + オクターブ (ど4=C4)。#/♭、C4式もOK
 *     歌詞  … かな1音。「ー」のばす 「っ」やすむ 「にゃ」等の拗音OK
 *     長さ  … 16分音符いくつ分か (省略=4 → 4分音符)
 *     休符  … ・:4 (または R:4)
 *   調教記号(音符の後ろに付ける):
 *     <しゃくり >フォール ~ビブラート強 _ビブラート無 *こぶし !アクセント ?よわく
 * ──────────────────────────────────────────────
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Utau = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

const SR = 44100;

/* ============ 1. かな → 音素 ============ */
const KMAP = {};
(function () {
  const rows = [
    ['あいうえお', ''], ['かきくけこ', 'k'], ['がぎぐげご', 'g'],
    ['さしすせそ', 's'], ['ざじずぜぞ', 'z'], ['たちつてと', 't'],
    ['だぢづでど', 'd'], ['なにぬねの', 'n'], ['はひふへほ', 'h'],
    ['ばびぶべぼ', 'b'], ['ぱぴぷぺぽ', 'p'], ['まみむめも', 'm'],
    ['らりるれろ', 'r']
  ];
  for (const [kana, c] of rows)
    for (let i = 0; i < 5; i++) KMAP[kana[i]] = [c, 'aiueo'[i]];
  Object.assign(KMAP, {
    'し': ['sh', 'i'], 'じ': ['j', 'i'], 'ち': ['ch', 'i'], 'ぢ': ['j', 'i'],
    'つ': ['ts', 'u'], 'づ': ['z', 'u'], 'ふ': ['f', 'u'],
    'や': ['y', 'a'], 'ゆ': ['y', 'u'], 'よ': ['y', 'o'],
    'わ': ['w', 'a'], 'を': ['', 'o'], 'ん': ['', 'N']
  });
})();
const SMALL_V = {'ゃ':'a','ゅ':'u','ょ':'o','ぁ':'a','ぃ':'i','ぅ':'u','ぇ':'e','ぉ':'o'};

function toHiragana(s) {
  return String(s).replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}
function splitMoras(text) {
  const s = toHiragana(text).replace(/[^ぁ-ゖー]/g, '');
  const out = [];
  for (const ch of s) {
    if (SMALL_V[ch] && out.length) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}
// mora → {c,v,pal} | {rest} | {ext}
function parseMora(m) {
  m = toHiragana(m || '');
  if (!m || m === 'っ') return {rest: true};
  if (m[0] === 'ー') return {ext: true};
  let pal = null, c = '', v = 'a';
  const base = KMAP[m[0]];
  if (base) { c = base[0]; v = base[1]; }
  if (m.length > 1 && SMALL_V[m[1]]) {
    v = SMALL_V[m[1]];
    if ('ゃゅょ'.includes(m[1])) pal = 'i';
  }
  if (c === 'y') { c = ''; pal = 'i'; }
  if (c === 'w') { c = ''; pal = 'u'; }
  return {c, v, pal};
}

/* ============ 2. 声・スタイル定義 ============ */
const VOWELS = {
  a: {f: [800, 1200, 2600, 3300], amp: [1.0, 0.35, 0.18, 0.08]},
  i: {f: [320, 2400, 3100, 3700], amp: [1.0, 0.20, 0.15, 0.06]},
  u: {f: [340, 1300, 2500, 3300], amp: [1.0, 0.25, 0.12, 0.05]},
  e: {f: [520, 1900, 2700, 3400], amp: [1.0, 0.30, 0.16, 0.07]},
  o: {f: [500, 850, 2600, 3300],  amp: [1.0, 0.35, 0.12, 0.05]},
  N: {f: [280, 1000, 2300, 3000], amp: [1.0, 0.15, 0.06, 0.03]}
};
const CONS = {
  k: {type:'stop', gap:0.020, f:1700, q:2.0, b:0.035, a:0.50},
  g: {type:'stop', gap:0.012, f:1400, q:2.0, b:0.025, a:0.35},
  t: {type:'stop', gap:0.020, f:4200, q:1.5, b:0.030, a:0.50},
  d: {type:'stop', gap:0.012, f:3500, q:1.5, b:0.022, a:0.35},
  p: {type:'stop', gap:0.020, f:800,  q:1.2, b:0.030, a:0.50},
  b: {type:'stop', gap:0.012, f:700,  q:1.2, b:0.022, a:0.35},
  s: {type:'fric', dur:0.090, f:6300, q:1.2, a:0.35},
  z: {type:'fric', dur:0.060, f:5800, q:1.2, a:0.30},
  sh:{type:'fric', dur:0.090, f:3200, q:1.6, a:0.40},
  j: {type:'fric', dur:0.060, f:3000, q:1.6, a:0.35},
  ch:{type:'fric', dur:0.070, f:3300, q:1.6, a:0.40},
  ts:{type:'fric', dur:0.060, f:5800, q:1.2, a:0.35},
  h: {type:'fric', dur:0.070, f:1600, q:0.7, a:0.30},
  f: {type:'fric', dur:0.080, f:1100, q:0.8, a:0.30},
  n: {type:'nasal', dur:0.055},
  m: {type:'nasal', dur:0.070},
  r: {type:'flap', dur:0.030}
};
const VOICES = {
  'うたこ':   {wave:'saw',    shift:1.00, pitch:0,   vibRate:5.6, vibDepth:22, breath:0.05},
  'ちびすけ': {wave:'saw',    shift:1.27, pitch:7,   vibRate:6.6, vibDepth:18, breath:0.04},
  'ロボまる': {wave:'square', shift:1.00, pitch:0,   vibRate:0,   vibDepth:0,  breath:0.00},
  'おじさま': {wave:'saw',    shift:0.80, pitch:-12, vibRate:4.8, vibDepth:35, breath:0.10}
};
const VOICE_ALIAS = {uta:'うたこ', chibi:'ちびすけ', robo:'ロボまる', oji:'おじさま'};

/* 調教スタイル:
 *  scoop      … 自動しゃくり量(0-1) / scoopDepth … しゃくりの深さ(半音)
 *  fall       … フレーズ末の自動フォール量(半音)
 *  vibScale   … ビブラート深さ倍率 / vibDelay … かかり始め(秒)
 *  kobushi    … 長い音に自動でこぶしを入れるか
 *  drift      … 音程のゆらぎ(セント)。0で機械的
 *  glide      … 音と音をなめらかにつなぐ(ポルタメント)
 */
const STYLES = {
  'べたうち': {scoop:0, scoopDepth:0,   fall:0,   vibScale:0,   vibDelay:0.25, kobushi:false, drift:0,  glide:false, breathScale:0.5, volume:1.0},
  'ふつう':   {scoop:1, scoopDepth:0.7, fall:0,   vibScale:1,   vibDelay:0.25, kobushi:false, drift:6,  glide:true,  breathScale:1.0, volume:1.0},
  'こぶし':   {scoop:1, scoopDepth:1.8, fall:1.2, vibScale:1.6, vibDelay:0.35, kobushi:true,  drift:10, glide:true,  breathScale:1.2, volume:1.0},
  'ささやき': {scoop:1, scoopDepth:0.5, fall:0.5, vibScale:0.5, vibDelay:0.30, kobushi:false, drift:4,  glide:true,  breathScale:3.4, volume:0.7},
  'げんき':   {scoop:1, scoopDepth:0.9, fall:0.4, vibScale:1.2, vibDelay:0.18, kobushi:false, drift:8,  glide:true,  breathScale:0.8, volume:1.1, bright:1.05}
};
const STYLE_ALIAS = {flat:'べたうち', normal:'ふつう', kobushi:'こぶし', whisper:'ささやき', genki:'げんき'};

const midiToF = m => 440 * Math.pow(2, (m - 69) / 12);

/* ============ 3. テキスト譜面パーサ ============ */
const PC_KANA = {'ど':0, 'れ':2, 'み':4, 'ふぁ':5, 'そ':7, 'ら':9, 'し':11};
const PC_ABC  = {c:0, d:2, e:4, f:5, g:7, a:9, b:11};
const MODS_RE = /[<>~_!?*＜＞！？]+$/;

function parsePitch(p) {
  p = toHiragana(p).toLowerCase();
  const m = p.match(/^(ど|れ|み|ふぁ|そ|ら|し|[a-g])([#♯b♭]?)(\d)$/);
  if (!m) return null;
  const pc = PC_KANA[m[1]] !== undefined ? PC_KANA[m[1]] : PC_ABC[m[1]];
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : (m[2] === 'b' || m[2] === '♭' ? -1 : 0);
  return 12 * (+m[3] + 1) + pc + acc;
}

const MODE_ALIAS = {song: 'うた', talk: 'かたり', poetry: 'かたり', 'ポエトリー': 'かたり'};

function parse(text) {
  const song = {mode: 'うた', tempo: 110, voice: 'うたこ', style: 'ふつう', notes: [], lines: []};
  const errors = [];
  let pos = 0, tempoSet = false;
  const body = [];                       // ディレクティブ以外の行(空行も間として残す)
  String(text).split('\n').forEach((raw, li) => {
    // コメントは行頭か空白のあとの # のみ (F#4 の # は音名の一部)
    const line = raw.replace(/(^|\s)[#＃].*$/, '$1').replace(/\/\/.*$/, '')
                    .replace(/[　\t]/g, ' ').trim();
    if (line[0] === '@' || line[0] === '＠') {
      const dm = line.slice(1).match(/^(\S+)\s+(\S+)/);
      if (!dm) { errors.push(`${li + 1}行目: "${line}" がよめません`); return; }
      const [, key, val] = dm;
      if (/^(tempo|てんぽ|テンポ|はやさ|speed)$/i.test(key)) {
        const t = parseInt(val, 10);
        if (t >= 40 && t <= 600) { song.tempo = t; tempoSet = true; }
        else errors.push(`${li + 1}行目: テンポは40〜600で`);
      } else if (/^(voice|こえ|声)$/i.test(key)) {
        const v = VOICE_ALIAS[val.toLowerCase()] || val;
        if (VOICES[v]) song.voice = v;
        else errors.push(`${li + 1}行目: こえ「${val}」はいないよ (${Object.keys(VOICES).join('/')})`);
      } else if (/^(style|すたいる|スタイル|調教)$/i.test(key)) {
        const s = STYLE_ALIAS[val.toLowerCase()] || val;
        if (STYLES[s]) song.style = s;
        else errors.push(`${li + 1}行目: スタイル「${val}」はないよ (${Object.keys(STYLES).join('/')})`);
      } else if (/^(mode|もーど|モード)$/i.test(key)) {
        const m = MODE_ALIAS[val.toLowerCase()] || val;
        if (m === 'うた' || m === 'かたり') song.mode = m;
        else errors.push(`${li + 1}行目: モードは「うた」か「かたり」だよ`);
      } else {
        errors.push(`${li + 1}行目: @${key} はしらないなあ`);
      }
      return;
    }
    body.push({line, li});
  });

  if (song.mode === 'かたり') {
    // かたり(ポエトリーリーディング)モード: 本文はふつうの詩のテキスト
    if (!tempoSet) song.tempo = 320;     // かたりのテンポは「1分あたりのモーラ数」
    for (const {line} of body) song.lines.push(line);
    while (song.lines.length && !song.lines[0]) song.lines.shift();
    while (song.lines.length && !song.lines[song.lines.length - 1]) song.lines.pop();
    if (errors.length) {
      const e = new Error(errors.join('\n'));
      e.utauErrors = errors;
      throw e;
    }
    return song;
  }

  for (const {line, li} of body) {
    if (!line) continue;
    for (let token of line.split(/\s+/)) {
      if (!token || token === '|' || token === '｜') continue;
      let mods = '';
      token = token.replace(MODS_RE, m => { mods = m; return ''; });
      mods = mods.replace('＜', '<').replace('＞', '>').replace('！', '!').replace('？', '?');
      const parts = token.split(/[:：]/);
      if (/^[・.rR]/.test(parts[0])) {                       // 休符
        const len = parseInt(parts[1] ?? parts[0].slice(1), 10) || 4;
        pos += len;
        continue;
      }
      const midi = parsePitch(parts[0]);
      if (midi === null) { errors.push(`${li + 1}行目: "${token}" がわかりません(例: ど4:き:4)`); continue; }
      if (midi < 24 || midi > 96) { errors.push(`${li + 1}行目: "${token}" は高すぎ/低すぎ`); continue; }
      const lyric = splitMoras(parts[1] || '')[0] || 'ら';
      const len = Math.max(1, Math.min(64, parseInt(parts[2], 10) || 4));
      song.notes.push({start: pos, len, midi, lyric, mods});
      pos += len;
    }
  }
  if (errors.length) {
    const e = new Error(errors.join('\n'));
    e.utauErrors = errors;
    throw e;
  }
  return song;
}

/* ============ 4. DSP部品 ============ */
class Biquad {
  constructor(f, q) { this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(f, q); }
  set(f, q) {                                   // RBJ bandpass (0dBピーク)
    f = Math.min(Math.max(f, 40), SR * 0.45);
    const w = 2 * Math.PI * f / SR, al = Math.sin(w) / (2 * q), a0 = 1 + al;
    this.b0 = al / a0; this.b2 = -al / a0;
    this.a1 = -2 * Math.cos(w) / a0; this.a2 = (1 - al) / a0;
  }
  process(x) {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}
function polyblep(ph, dt) {
  if (ph < dt) { const t = ph / dt; return t + t - t * t - 1; }
  if (ph > 1 - dt) { const t = (ph - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
const oscSaw = (ph, dt) => 2 * ph - 1 - polyblep(ph, dt);
const oscSquare = (ph, dt) =>
  (ph < 0.5 ? 1 : -1) + polyblep(ph, dt) - polyblep((ph + 0.5) % 1, dt);

function addNoiseBand(buf, t0, t1, f, q, amp, atk) {
  const bq = new Biquad(f, q);
  const i0 = Math.max(0, Math.floor(t0 * SR));
  const i1 = Math.min(buf.length, Math.floor(t1 * SR));
  const rel = 0.02 * SR, atkS = Math.max(1, atk * SR);
  for (let j = i0; j < i1; j++) {
    let env = Math.min(1, (j - i0) / atkS) * Math.min(1, (i1 - j) / rel);
    buf[j] += bq.process(Math.random() * 2 - 1) * env * amp;
  }
}
// 子音を書き込み、母音の開始時刻を返す
function addConsonant(buf, c, t0, f0) {
  switch (c.type) {
    case 'fric':
      addNoiseBand(buf, t0, t0 + c.dur + 0.02, c.f, c.q, c.a * 0.7, c.dur * 0.4);
      return t0 + c.dur * 0.6;
    case 'stop': {
      const tb = t0 + c.gap;
      addNoiseBand(buf, tb, tb + c.b, c.f, c.q, c.a * 0.7, 0.003);
      return tb + c.b * 0.8;
    }
    case 'nasal': {
      const i0 = Math.floor(t0 * SR), i1 = Math.min(buf.length, Math.floor((t0 + c.dur) * SR));
      const lp = 1 - Math.exp(-2 * Math.PI * 380 / SR);
      let y = 0;
      for (let j = i0; j < i1; j++) {
        const tn = (j - i0) / SR;
        const env = Math.min(1, tn / 0.015) * Math.min(1, (i1 - j) / (0.02 * SR)) * 0.4;
        y += lp * (Math.sin(2 * Math.PI * f0 * tn) - y);
        buf[j] += y * env;
      }
      return t0 + c.dur * 0.8;
    }
    case 'flap':
      addNoiseBand(buf, t0 + 0.008, t0 + 0.03, 900, 1.5, 0.18, 0.004);
      return t0 + c.dur;
  }
  return t0;
}

/* ============ 5a. かたりモード: 詩のテキスト → 話し言葉の抑揚 ============ */
function buildSpeechEvents(song) {
  const voice = VOICES[song.voice], style = STYLES[song.style];
  const moraDur = 60 / song.tempo;             // @tempo = 1分あたりのモーラ数
  const base = 57;                             // 話し声の基準(A3。声ごとのpitchは後段で加算)
  const flat = song.style === 'べたうち';      // べたうち = 抑揚ゼロの機械よみ
  const events = [];
  let t = 0.1;
  for (const line of song.lines) {
    if (!line) { t += 0.5; continue; }         // 空行 = おおきな間
    const phrases = line.match(/[^、。，．,.!?！？…‥\s]+[、。，．,.!?！？…‥]*/g) || [];
    for (const chunk of phrases) {
      const pm = chunk.match(/[、。，．,.!?！？…‥]+$/);
      const punct = pm ? pm[0] : '';
      const moras = splitMoras(chunk);
      const n = moras.length;
      if (!n) { if (punct) t += 0.4; continue; }
      const question = /[?？]/.test(punct);
      let acc = 0, prevMidi = null, prevVowel = 'a';
      for (let i = 0; i < n; i++) {
        const ph0 = parseMora(moras[i]);
        if (ph0.rest) { t += moraDur * 0.6; prevMidi = null; continue; }  // っ = つまり
        const ph = ph0.ext ? {c: '', v: prevVowel, pal: null} : ph0;
        // フレーズ頭は高く、おわりに向かって自然に下降(+ゆるいアクセントの揺れ)
        const decl = 1.5 - 4.0 * (n > 1 ? i / (n - 1) : 0.5);
        if (i > 0) acc = Math.max(-1.5, Math.min(1.5, acc + Math.random() * 1.4 - 0.7));
        const jitter = (Math.random() - 0.5) * 0.4;
        const midi = base + (flat ? 0 : decl + acc + jitter);
        const isLast = i === n - 1;
        let len = moraDur * (0.9 + Math.random() * 0.2) * (ph0.ext ? 1.3 : 1);
        let fall = 0;
        if (isLast) {                          // 文末: のばして落とす。「?」なら上げる
          len *= question ? 1.5 : 1.6;
          fall = flat ? 0 : (question ? -3 : 2.2);
        }
        events.push({
          t0: t, t1: t + len, midi, lyric: moras[i], c: ph.c, v: ph.v, pal: ph.pal,
          glideFrom: prevMidi, scoopSemi: 0, fallSemi: fall, kobushi: false,
          vibCents: 0, vol: style.volume * (isLast ? 0.85 : 1), speech: true
        });
        t += len; prevMidi = midi; prevVowel = ph.v;
      }
      t += /[。．.!?！？…‥]/.test(punct) ? 0.55 : punct ? 0.3 : 0.15;
    }
    t += 0.35;                                 // 行のおわりの間
  }
  const duration = events.length ? events[events.length - 1].t1 : 0;
  return {events, duration, voice, style};
}

/* ============ 5. 譜面 → イベント列(調教の決定) ============ */
function buildEvents(song) {
  if (song.mode === 'かたり') return buildSpeechEvents(song);
  const st = 60 / song.tempo / 4;
  const voice = VOICES[song.voice], style = STYLES[song.style];
  const notes = [...song.notes].sort((a, b) => a.start - b.start);
  const events = [];
  let prevVowel = 'a', prevEnd = -1e9, prevMidi = null;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    let ph = parseMora(n.lyric);
    if (ph.rest) { prevEnd = -1e9; continue; }        // っ = 息つぎ(レガート切り)
    if (ph.ext) ph = {c: '', v: prevVowel, pal: null};
    const legato = Math.abs(prevEnd - n.start) < 1e-6;
    const next = notes[i + 1];
    const phraseEnd = !next || parseMora(next.lyric).rest ||
                      Math.abs(n.start + n.len - next.start) > 1e-6;
    const m = n.mods || '';
    const jumpUp = legato ? n.midi - prevMidi : 0;
    // ここが「調教」: スタイルの自動判断 + 記号による指定
    const scoopSemi = m.includes('<') ? Math.max(1.2, style.scoopDepth)
      : (style.scoop && (!legato || jumpUp >= 4) ? style.scoopDepth : 0);
    const fallSemi = m.includes('>') ? Math.max(1.2, style.fall || 1.2)
      : (style.fall && phraseEnd && n.len >= 6 ? style.fall : 0);
    const kobushi = m.includes('*') || (style.kobushi && n.len * st >= 0.5);
    const vibCents = m.includes('_') ? 0
      : voice.vibDepth * style.vibScale * (m.includes('~') ? 1.7 : 1);
    const vol = style.volume * (m.includes('!') ? 1.3 : 1) * (m.includes('?') ? 0.65 : 1);
    events.push({
      t0: n.start * st, t1: (n.start + n.len) * st,
      midi: n.midi, lyric: n.lyric, c: ph.c, v: ph.v, pal: ph.pal,
      glideFrom: style.glide && legato && prevMidi !== null ? prevMidi : null,
      scoopSemi, fallSemi, kobushi, vibCents, vol
    });
    prevVowel = ph.v; prevEnd = n.start + n.len; prevMidi = n.midi;
  }
  const duration = events.reduce((m2, e) => Math.max(m2, e.t1), 0);
  return {events, duration, voice, style};
}

/* ============ 6. レンダリング ============ */
function renderEvent(buf, ev, voice, style) {
  const f0target = midiToF(ev.midi + voice.pitch);
  let vStart = ev.t0;
  const c = CONS[ev.c];
  if (c) vStart = addConsonant(buf, c, ev.t0, f0target);
  vStart = Math.min(vStart, Math.max(ev.t0, ev.t1 - 0.05));

  const shift = voice.shift * (style.bright || 1);
  const vw = VOWELS[ev.v] || VOWELS.a;
  const palFrom = ev.pal ? VOWELS[ev.pal] : null;
  const filters = vw.f.map((f, i) =>
    new Biquad((palFrom ? palFrom.f[i] : f) * shift, 9));
  // かたり(speech)は子音をまたいでも音程をつなぐ(話し言葉の連続感)
  const glideF = ev.glideFrom != null && (!c || ev.speech)
    ? midiToF(ev.glideFrom + voice.pitch) : 0;
  const vibRate = voice.vibRate || 5.5;
  const driftAmp = style.drift, driftPhase = Math.random() * 6.28;
  const wave = voice.wave === 'square' ? oscSquare : oscSaw;
  const atk = (ev.speech ? 0.015 : 0.025) * SR, rel = (ev.speech ? 0.045 : 0.06) * SR;
  const i0 = Math.max(0, Math.floor(vStart * SR));
  const i1 = Math.min(buf.length, Math.floor(ev.t1 * SR));
  let phase = 0;
  const B = 64;
  for (let bi = i0; bi < i1; bi += B) {
    const t = bi / SR, tn = t - vStart;
    // ピッチ軌道(しゃくり・フォール・ビブラート・こぶし・ゆらぎ)
    let f = f0target;
    if (glideF && tn < 0.06) f = glideF + (f0target - glideF) * (tn / 0.06);
    let cents = 0;
    if (ev.scoopSemi > 0 && tn < 0.13) cents -= ev.scoopSemi * 100 * (1 - tn / 0.13);
    if (ev.fallSemi) {                         // 正=フォール / 負=語尾上げ(疑問)
      const w = ev.speech ? 0.18 : 0.13;
      const tf = ev.t1 - t;
      if (tf < w) cents -= ev.fallSemi * 100 * (1 - tf / w);
    }
    if (ev.vibCents > 0 && tn > style.vibDelay) {
      const r = Math.min(1, (tn - style.vibDelay) / 0.35);
      cents += ev.vibCents * r * Math.sin(2 * Math.PI * vibRate * tn);
    }
    if (ev.kobushi) {
      const tk = tn - 0.10;
      if (tk > 0 && tk < 0.28)
        cents += 85 * Math.sin(Math.PI * tk / 0.28) * Math.sin(2 * Math.PI * 6.5 * tk);
    }
    if (driftAmp) cents += driftAmp * Math.sin(2 * Math.PI * 0.7 * t + driftPhase);
    f *= Math.pow(2, cents / 1200);
    const dt = f / SR;
    if (palFrom) {                                   // 「きゃ」等: い→あ のわたり
      const k = Math.min(1, tn / 0.09);
      for (let fi = 0; fi < filters.length; fi++)
        filters[fi].set((palFrom.f[fi] + (vw.f[fi] - palFrom.f[fi]) * k) * shift, 9);
    }
    const bEnd = Math.min(bi + B, i1);
    for (let j = bi; j < bEnd; j++) {
      let env = Math.min(1, (j - i0) / atk) * Math.min(1, (i1 - j) / rel);
      phase += dt; if (phase >= 1) phase -= 1;
      const s = wave(phase, dt);
      let y = 0;
      for (let fi = 0; fi < filters.length; fi++)
        y += filters[fi].process(s) * vw.amp[fi];
      buf[j] += y * env * ev.vol * 1.4;
    }
  }
  const breath = voice.breath * style.breathScale;
  if (breath > 0) addNoiseBand(buf, vStart, ev.t1, 3200, 0.6, breath, 0.03);
}

function applyReverb(buf, wet) {
  const combs = [[1687, .773], [1601, .802], [2053, .753], [2251, .733]]
    .map(([d, g]) => ({buf: new Float32Array(d), g, i: 0}));
  const aps = [[225, .7], [556, .7]]
    .map(([d, g]) => ({buf: new Float32Array(d), g, i: 0}));
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    let s = 0;
    for (const cb of combs) {
      const y = cb.buf[cb.i];
      cb.buf[cb.i] = x + y * cb.g;
      if (++cb.i >= cb.buf.length) cb.i = 0;
      s += y;
    }
    s /= 4;
    for (const ap of aps) {
      const z = ap.buf[ap.i];
      const y = -ap.g * s + z;
      ap.buf[ap.i] = s + ap.g * y;
      if (++ap.i >= ap.buf.length) ap.i = 0;
      s = y;
    }
    buf[i] = x + wet * s;
  }
}

function render(song) {
  const {events, duration, voice, style} = buildEvents(song);
  const total = Math.max(SR, Math.ceil((duration + 1.6) * SR));
  const buf = new Float32Array(total);
  for (const ev of events) renderEvent(buf, ev, voice, style);
  applyReverb(buf, 0.16);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  if (peak > 0) {
    const g = 0.89 / peak;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  const timeline = events.map(e => ({t0: e.t0, t1: e.t1, v: e.v, lyric: e.lyric, midi: e.midi}));
  return {samples: buf, duration: duration + 1.6, timeline};
}

/* ============ 7. WAV(16bit mono) ============ */
function toWav(f32) {
  const bytes = 44 + f32.length * 2;
  const ab = new ArrayBuffer(bytes), dv = new DataView(ab);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return ab;
}

/* ============ 8. USTエクスポート(本家UTAU用プロジェクトファイル) ============ */
/*
 * うたテキストの譜面を、本家UTAU(https://utau2008.xrea.jp/)で開ける
 * UST形式(UST Version1.2)のテキストに変換する。
 *
 *   長さ   … うたテキストの1(16分音符) = 120tick(USTは4分音符=480tick)
 *   調教   … スタイル/記号の判断は buildEvents と同じロジックで、
 *             しゃくり・ポルタメント → Mode2ピッチベンド(PBS/PBW/PBY)
 *             フォール             → 音尻のピッチ点
 *             ビブラート           → VBR
 *             !アクセント ?よわく  → Intensity
 *   歌詞   … 「ー」は直前の母音のかなに展開、「っ」は休符(R)に
 *
 * 本家UTAUはShift-JISのWindowsアプリなので、保存時は encodeSjis() で
 * Shift-JISのバイト列にしてから書き出すこと(CRLF改行はtoUstが付ける)。
 */
const VOWEL_KANA = {a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お', N: 'ん'};

function toUst(song, opts = {}) {
  if (song.mode === 'かたり') {
    throw new Error('かたりモードは音符がないのでUSTにできません(@mode うた の譜面でどうぞ)');
  }
  const style = STYLES[song.style], voice = VOICES[song.voice];
  const TICK = 120;                          // うたテキストの長さ1(16分) → 120tick
  const msPerLen = 15000 / song.tempo;       // 16分音符1つのミリ秒
  const name = opts.name || 'utau-chan-song';
  const lines = [
    '[#VERSION]',
    'UST Version1.2',
    '[#SETTING]',
    `Tempo=${song.tempo.toFixed(2)}`,
    'Tracks=1',
    `ProjectName=${name}`,
    'VoiceDir=%VOICE%',
    `OutFile=${name}.wav`,
    `CacheDir=${name}.cache`,
    'Tool1=wavtool.exe',
    'Tool2=resampler.exe',
    'Mode2=True'
  ];
  let idx = 0;
  const push = fields => {
    lines.push(`[#${String(idx++).padStart(4, '0')}]`);
    lines.push(...fields);
  };
  const rest = len => push([`Length=${len * TICK}`, 'Lyric=R', 'NoteNum=60', 'PreUtterance=']);

  const notes = [...song.notes].sort((a, b) => a.start - b.start);
  let pos = 0, prevVowel = 'a', prevEnd = -1e9, prevMidi = null;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.start > pos) rest(n.start - pos);  // 譜面上の休符(・:4)は間隔として現れる
    pos = n.start + n.len;
    const ph = parseMora(n.lyric);
    if (ph.rest) { rest(n.len); prevEnd = -1e9; continue; }   // っ = 息つぎ
    const lyric = ph.ext ? VOWEL_KANA[prevVowel] || 'あ' : n.lyric;
    if (!ph.ext) prevVowel = ph.v;

    // 調教の決定(buildEventsと同じ判断基準)
    const legato = prevEnd === n.start;
    const next = notes[i + 1];
    const phraseEnd = !next || parseMora(next.lyric).rest || n.start + n.len !== next.start;
    const m = n.mods || '';
    const jumpUp = legato ? n.midi - prevMidi : 0;
    const scoopSemi = m.includes('<') ? Math.max(1.2, style.scoopDepth)
      : (style.scoop && (!legato || jumpUp >= 4) ? style.scoopDepth : 0);
    const fallSemi = m.includes('>') ? Math.max(1.2, style.fall || 1.2)
      : (style.fall && phraseEnd && n.len >= 6 ? style.fall : 0);
    const vibCents = m.includes('_') ? 0
      : voice.vibDepth * style.vibScale * (m.includes('~') ? 1.7 : 1);
    const intensity = Math.round(100 * (m.includes('!') ? 1.2 : 1) * (m.includes('?') ? 0.7 : 1));

    const fields = [
      `Length=${n.len * TICK}`,
      `Lyric=${lyric}`,
      `NoteNum=${n.midi}`,
      'PreUtterance=',
      `Intensity=${intensity}`,
      'Modulation=0'
    ];
    // Mode2ピッチベンド: PBYの単位は10セント(半音=10)、PBWはミリ秒
    const startY = scoopSemi > 0 ? -scoopSemi * 10
      : (style.glide && legato && prevMidi !== null ? (prevMidi - n.midi) * 10 : 0);
    if (startY !== 0 || fallSemi > 0) {
      const durMs = n.len * msPerLen;
      const head = Math.round(Math.min(150, durMs * 0.4));
      const pbw = [head], pby = [0];
      if (fallSemi > 0) {
        const tail = Math.round(Math.min(130, durMs * 0.3));
        pbw.push(Math.max(0, Math.round(durMs) - head - tail), tail);
        pby.push(0, Math.round(-fallSemi * 10));
      }
      fields.push(`PBS=0;${Math.round(startY * 10) / 10}`);
      fields.push(`PBW=${pbw.join(',')}`);
      fields.push(`PBY=${pby.join(',')}`);
      fields.push(`PBM=${','.repeat(pbw.length - 1)}`);
    }
    if (vibCents > 0) {
      const cycleMs = Math.round(1000 / (voice.vibRate || 5.5));
      fields.push(`VBR=65,${cycleMs},${Math.round(vibCents)},20,20,0,0,0`);
    }
    push(fields);
    prevEnd = n.start + n.len; prevMidi = n.midi;
  }
  lines.push('[#TRACKEND]');
  return lines.join('\r\n') + '\r\n';
}

/* Shift-JISエンコーダ(依存ゼロのミニ実装)
 * USTで使う範囲だけ: ASCII / ひらがな / カタカナ / よく使う記号。
 * 表にない文字(漢字など)は '?' になる。 */
const SJIS_PUNCT = {
  0x3000: 0x8140, 0x3001: 0x8141, 0x3002: 0x8142, 0x30FB: 0x8145, 0x30FC: 0x815B,
  0x2018: 0x8165, 0x2019: 0x8166, 0x201C: 0x8167, 0x201D: 0x8168,
  0x300C: 0x8175, 0x300D: 0x8176, 0x3005: 0x8158,
  0xFF01: 0x8149, 0xFF1F: 0x8148, 0xFF0C: 0x8143, 0xFF0E: 0x8144,
  0xFF08: 0x8169, 0xFF09: 0x816A, 0xFF5E: 0x8160, 0x301C: 0x8160,
  0x309B: 0x814A, 0x309C: 0x814B, 0x2026: 0x8163
};
function encodeSjis(str) {
  const bytes = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { bytes.push(cp); continue; }
    let code = 0;
    if (cp >= 0x3041 && cp <= 0x3093) {                    // ひらがな ぁ〜ん
      code = 0x829F + (cp - 0x3041);
    } else if (cp >= 0x30A1 && cp <= 0x30F6) {             // カタカナ ァ〜ヶ
      let b2 = 0x40 + (cp - 0x30A1);
      if (b2 >= 0x7F) b2++;                                // 2バイト目の0x7Fは欠番
      code = 0x8300 | b2;
    } else if (SJIS_PUNCT[cp]) {
      code = SJIS_PUNCT[cp];
    }
    if (code) bytes.push(code >> 8, code & 0xFF);
    else bytes.push(0x3F);                                 // '?'
  }
  return new Uint8Array(bytes);
}

return {SR, parse, render, toWav, toUst, encodeSjis, splitMoras, parseMora, VOICES, STYLES};
});
