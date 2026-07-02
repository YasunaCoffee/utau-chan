---
name: run-utau
description: うたうくん(このリポジトリ)を起動して歌わせる。「うたを鳴らして」「うたわせて」「実行して」「WAVにして」「ブラウザで開いて」「run-utau」などと言われたとき、または譜面(.uta)を書いて音を確認したいときに使う。CLI(node sing.js)でWAV生成、ブラウザ(index.html)で口パク再生の両方に対応。
---

# run-utau — うたうくんの起動ランブック

このリポジトリは、テキスト譜面「うたテキスト(.uta)」を歌声WAVに合成する、依存ライブラリ不要のちいさな歌声合成器。声は録音を使わずフォルマント合成でその場生成する。起動方法は2つ:

- **CLI** — `node sing.js 譜面.uta` で WAV を書き出す(Node.jsだけ)
- **ブラウザ** — `index.html` を開いてキャラクターに口パクで歌わせる

## 前提の確認

- Node.js があること: `node --version`(v18+ 目安。追加の `npm install` は不要)
- 実行はリポジトリのルート(`sing.js` / `index.html` / `songs/` がある場所)から。

## いちばん速い起動(CLI)

```bash
node sing.js songs/kirakira.uta     # → songs/kirakira.wav ができる
```

成功すると `🎤 うた / うたこ / 調教:ふつう / ♩=104 / 42音 / 29.3秒` のような1行と出力先が表示される。出力は 16bit・モノラル・44.1kHz の WAV。

聴く: `aplay songs/kirakira.wav`(Linux)/ `afplay …`(mac)/ `xdg-open …` でOSの既定プレーヤ。

### サンプル譜面(songs/)

| ファイル | 内容 |
|---|---|
| `kirakira.uta` | きらきら星メロディ・うたこ・調教ふつう(基本デモ) |
| `mofumofu.uta` | メリーさんのひつじ・うたこ |
| `neko.uta` | かえるの合唱・ちびすけ |
| `robo.uta` | べたうち(無調教)のロボまる声デモ |
| `yozakura.uta` | 演歌・おじさま・調教スタイル「こぶし」 |
| `yoru.uta` | `@mode かたり` のポエトリーリーディングdemo(ささやき) |

全部書き出す例:

```bash
for f in songs/*.uta; do node sing.js "$f"; done
```

### CLIの他の使い方

```bash
node sing.js songs/kirakira.uta -o /tmp/out.wav   # 出力先を指定
echo "@tempo 120
ど4:ら ど4:ら そ4:そ:8" | node sing.js -           # 標準入力から(→ song.wav)
node sing.js --help                                # 書式ヘルプ
```

## ブラウザで起動

`index.html` をブラウザで開くだけ(ビルド不要・そのままファイルを開いて動く)。サンプルボタン(⭐🐱🐑🌸🤖)を押すとキャラが口をパクパクさせて歌う。ローカルで確実に見せたいときは簡易サーバ経由が安定:

```bash
python3 -m http.server 8000   # → http://localhost:8000/index.html
```

譜面はURLに埋め込まれるので、共有リンクとして送れる。GitHub Pages(Settings → Pages → main / root)で公開も可能。

## 新しい譜面を書いて鳴らす(要点)

`高さ:歌詞[:長さ][調教記号]` を空白区切りで並べる。詳細は `README.md` と `node sing.js --help`。

- **高さ**: `ど れ み ふぁ そ ら し` + オクターブ(`ど4`=C4)。`#`/`♭`・`C4`/`F#4` 式もOK
- **歌詞**: かな1音(`ー`のばす、`っ`やすむ、`にゃ`等の拗音OK)
- **長さ**: 16分音符いくつぶんか(省略=4=4分音符)。休符は `・:4`
- **ヘッダ**: `@mode うた|かたり` `@tempo` `@voice うたこ|ちびすけ|ロボまる|おじさま` `@style べたうち|ふつう|こぶし|ささやき|げんき`
- **調教記号**: `<`しゃくり `>`フォール `~`ビブ強 `_`ビブ無 `*`こぶし `!`アクセント `?`よわく
- `@mode かたり` にすると音符なしで詩をそのまま朗読(抑揚は自動)

書いたら `node sing.js 新譜面.uta` で即確認。パースエラーは「譜面がよめませんでした」と行が示されるので、その行を直す。

## 動作確認(スモークテスト)

変更後にサッと壊れていないか見るなら:

```bash
node sing.js songs/kirakira.uta -o /tmp/smoke.wav && \
  file /tmp/smoke.wav | grep -q "WAVE audio" && echo OK
```

`OK` が出れば合成パイプラインは生きている。
