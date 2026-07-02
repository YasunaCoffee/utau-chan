#!/usr/bin/env node
/*
 * うたうくん CLI — うたテキスト → WAV
 *
 *   node sing.js songs/kirakira.uta            → songs/kirakira.wav
 *   node sing.js songs/kirakira.uta -o out.wav
 *   echo "@tempo 120 ..." | node sing.js -     → song.wav
 *   node sing.js --help                        書式の説明
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Utau = require('./engine.js');

const HELP = `
うたうくん CLI — テキスト譜面をうたごえWAVにします

つかいかた:
  node sing.js <譜面ファイル.uta> [-o 出力.wav]
  cat 譜面.uta | node sing.js -

譜面のかきかた(うたテキスト形式):
  # コメント
  @mode うた              うた(デフォルト) / かたり(ポエトリーリーディング)
  @tempo 110              テンポ(かたりモードでは1分あたりのモーラ数。省略=320)
  @voice うたこ            うたこ / ちびすけ / ロボまる / おじさま
  @style ふつう            べたうち / ふつう / こぶし / ささやき / げんき

  ── うたモード ──
  ど4:き ど4:ら そ4:き:8 ・:4 …

  音符 = 高さ:歌詞[:長さ][調教記号]
    高さ   ど れ み ふぁ そ ら し + オクターブ(ど4=C4)。#/♭やC4式もOK
    歌詞   かな1音(「ー」のばす 「っ」やすむ 「にゃ」など拗音OK)
    長さ   16分音符いくつぶんか。省略=4(4分音符)
    休符   ・:4
  調教記号: <しゃくり >フォール ~ビブ強 _ビブ無 *こぶし !アクセント ?よわく

  ── かたりモード ──
  ふつうの詩をひらがな/カタカナでそのまま書く。抑揚は自動でつく。
  「、」小さな間 「。!?」大きな間(「?」は語尾上げ) 空行=もっと大きな間
  @style ささやき で囁き系、@voice ロボまる + @style べたうち で機械よみ
`;

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(args.length ? 0 : 1);
}
let input = null, out = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
  else input = args[i];
}
const text = input === '-'
  ? fs.readFileSync(0, 'utf8')
  : fs.readFileSync(input, 'utf8');
if (!out) {
  out = input === '-' ? 'song.wav'
    : path.join(path.dirname(input), path.basename(input, path.extname(input)) + '.wav');
}

let song;
try {
  song = Utau.parse(text);
} catch (e) {
  console.error('譜面がよめませんでした:\n' + e.message);
  process.exit(1);
}
const t = Date.now();
const {samples, duration, timeline} = Utau.render(song);
fs.writeFileSync(out, Buffer.from(Utau.toWav(samples)));
console.log(`🎤 ${song.mode} / ${song.voice} / 調教:${song.style} / ♩=${song.tempo} / ${timeline.length}音 / ${duration.toFixed(1)}秒`);
console.log(`   → ${out} (${(Date.now() - t) / 1000}秒でレンダリング)`);
