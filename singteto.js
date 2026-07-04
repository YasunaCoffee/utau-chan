#!/usr/bin/env node
/*
 * うたうちゃん × 重音テト — うたテキスト譜面を「実録音サンプル(UTAU音源)」で歌わせる
 *
 *   node singteto.js songs/kirakira.uta            → songs/kirakira.teto.wav
 *   node singteto.js songs/kirakira.uta -o out.wav
 *   node singteto.js songs/kirakira.uta --bank /path/to/音源フォルダ
 *   オプション: --no-vib(ビブラート無効) --dry(残響無効)
 *
 * 通常の sing.js はフォルマント合成(録音なし)。こちらは録音WAV+oto.iniを
 * 切り貼りして歌わせるミニUTAUリサンプラー。合成コアは tetoengine.js
 * (ブラウザのindex.htmlと共通)で、このファイルはCLIラッパー:
 *   引数処理 / 音源フォルダの探索 / ファイル読み込み / WAV書き出し
 *
 * ※ 音源ファイルは同梱しない。重音テト音源(小山乃舞世)の再配布は規約で禁止。
 *   各自ダウンロードしたフォルダを --bank / UTAU_BANK で指す。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const Utau = require('./engine.js');
const Teto = require('./tetoengine.js');

/* ---- 引数 ---- */
const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) {
  console.log(`うたうちゃん × 重音テト — 譜面を実録音サンプルで歌わせる
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

/* ---- 読み込み → 合成(tetoengine.js) → WAV書き出し ---- */
const otoText = new TextDecoder('shift_jis').decode(fs.readFileSync(path.join(BANK, 'oto.ini')));
const oto = Teto.parseOto(otoText);
const song = Utau.parse(fs.readFileSync(input, 'utf8'));

const bank = {
  oto,
  getFile: async (file) => {
    const buf = fs.readFileSync(path.join(BANK, file));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
};

Teto.render(song, bank, {useVib, useReverb}).then(res => {
  fs.writeFileSync(out, Buffer.from(Utau.toWav(res.samples)));
  console.log(`🎤×重音テト [${res.vcv ? '連続音VCV' : '単独音CV'}] / ♩=${song.tempo} / ${res.placed}音 / ${res.duration.toFixed(1)}秒`
    + ` / ビブ:${useVib ? '有' : '無'} / 残響:${useReverb ? '有' : '無'}`);
  console.log(`   音源: ${BANK.replace(os.homedir(), '~')}`);
  console.log(`   → ${out}`);
  if (res.missing.length) console.log(`   ※ 代替/欠落: ${res.missing.join(', ')}`);
}).catch(e => {
  console.error(e.message);
  process.exit(1);
});
