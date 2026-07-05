#!/usr/bin/env node
/*
 * うたうちゃん → 本家UTAU — うたテキストをUSTプロジェクトファイルに書き出す
 *
 *   node bin/export-ust.js songs/kirakira.uta              → songs/kirakira.ust
 *   node bin/export-ust.js songs/kirakira.uta -o 出力.ust
 *   cat 譜面.uta | node bin/export-ust.js -                → song.ust
 *   node bin/export-ust.js 譜面.uta --utf8                 Shift-JISでなくUTF-8で保存
 *
 * できたUSTは本家UTAU(https://utau2008.xrea.jp/)やOpenUtauでそのまま開けます。
 * 音源(VoiceDir)はUTAU側でプロジェクトのプロパティから選んでください。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Utau = require('../src/engine.js');

const HELP = `
うたうちゃん USTエクスポート — うたテキストを本家UTAUのプロジェクトファイルにします

つかいかた:
  node bin/export-ust.js <譜面ファイル.uta> [-o 出力.ust] [--utf8]
  cat 譜面.uta | node bin/export-ust.js -

  --utf8 を付けるとUTF-8で保存(既定はShift-JIS。本家UTAUはShift-JIS推奨、
  OpenUtauはどちらでもOK)

もっていける調教:
  しゃくり(<) / ポルタメント     → Mode2ピッチベンド(PBS/PBW/PBY)
  フォール(>)                    → 音尻のピッチ点
  ビブラート(~ / _ / スタイル)    → VBR
  !アクセント ?よわく             → Intensity
  ※こぶし(*)はUSTに相当機能がないため省略されます
`;

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(args.length ? 0 : 1);
}
let input = null, out = null, utf8 = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
  else if (args[i] === '--utf8') utf8 = true;
  else input = args[i];
}
const text = input === '-'
  ? fs.readFileSync(0, 'utf8')
  : fs.readFileSync(input, 'utf8');
const name = input === '-' ? 'song' : path.basename(input, path.extname(input));
if (!out) {
  out = input === '-' ? 'song.ust'
    : path.join(path.dirname(input), name + '.ust');
}

let song;
try {
  song = Utau.parse(text);
} catch (e) {
  console.error('譜面がよめませんでした:\n' + e.message);
  process.exit(1);
}
let ust;
try {
  ust = Utau.toUst(song, {name});
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
fs.writeFileSync(out, utf8 ? Buffer.from(ust, 'utf8') : Buffer.from(Utau.encodeSjis(ust)));
const noteCount = (ust.match(/^Lyric=(?!R)/gm) || []).length;
console.log(`📤 ${song.voice} / 調教:${song.style} / ♩=${song.tempo} / ${noteCount}音`);
console.log(`   → ${out} (${utf8 ? 'UTF-8' : 'Shift-JIS'} / UST Version1.2)`);
console.log('   UTAUで開いたら、プロジェクトのプロパティで音源を選んでね');
