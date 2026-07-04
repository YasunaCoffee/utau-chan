# バンドちゃん 設計仕様

Strudel (https://strudel.cc/) 風のライブコーディング・シンセサイザーを、うたうちゃんに追加した際の設計メモ。実装は `synth.js`(パーサ + Web Audio演奏エンジン)と `band.html`(GUI)。

## 成果物

- `synth.js` — バンドテキストのパーサ + 演奏エンジン(UMD、`engine.js` と同じラッパー形式で `global.Band` にエクスポート)
- `band.html` — Strudel風ライブGUI
- `songs/*.band` — サンプル曲(テクノ風・ポップス風・うた入りバラード)
- README.md の「バンドちゃん」セクション

外部依存・ビルド工程は一切なし。フラット構成を維持。

## バンドテキスト形式

```
# コメント行
@tempo 120              テンポBPM(省略時100)
@voice うたこ           [うた]トラックの声(engine.jsに渡す)
@style ふつう           [うた]トラックのスタイル
@swing 0.1              スウィング(0〜0.3、省略時0。偶数番目の16分を遅らせる)

[ドラム] どつたつ どつたち | どつたつ ぱつたち
[ベース] ど2:4 ど2:4 ら1:4 そ1:4
[コード] Am:16 F:16 | C:16 G:16
[リード] み4:2 そ4:2 ら4:4 ・:8
[うた]   ど4:き ど4:ら そ4:き そ4:ら
```

- 行頭 `[トラック名]` でトラック指定。同名トラックの複数行は時間方向に連結。`[トラック名]`のない音符行はエラーではなく直前のトラックに連結。
- `|` と空白は読み飛ばし(飾り)。`#`はコメント。
- **[ドラム]**: 1文字=16分音符。`ど`=キック `た`=スネア `つ`=閉ハット `ち`=開ハット `ぱ`=クラップ `・`=休符。カタカナも正規化(`toHiragana`相当)。
- **[ベース]/[リード]**: `高さ[:長さ]`。高さは `engine.js` の `parsePitch` と同じ規則(`ど4`=C4、`#`/`♭`、`C4` 式もOK)。長さ=16分いくつ分、省略時4。休符 `・:4` / `R:4`。
- **[コード]**: `コード名[:長さ]`。対応: メジャー(C, F)、マイナー(Am, Dm)、7th(C7, Am7)、maj7(Cmaj7)、dim, sus4, add9。ルート(オクターブ3)+3〜4声。add9等の広い音程は自然にオクターブ4へ伸びる。
- **[うた]**: 行の中身をそのままうたテキストとして `engine.js`(`Utau.parse`)に委譲。`@tempo`/`@voice`/`@style` を合成して渡す。
- parse結果: `{tempo, swing, voice, style, tracks: {ドラム:[...], ベース:[...], ...}, loopLen16}`。`loopLen16` = 最長トラック長を1小節(16×16分)単位に切り上げ。全トラックは `loopLen16` でループ(短いトラックは自トラック長で繰り返してループ全体を埋める)。
- パースエラーは行番号付き日本語メッセージで `throw`(`engine.js` と同様、`.bandErrors` に配列も添付)。

## 演奏エンジン(Web Audio、リアルタイム)

- 先読みスケジューラ方式: `setInterval(25ms)` で `currentTime+0.1s` 先までのイベントをAudioContextに予約(Chris Wilson "A Tale of Two Clocks" 方式)。
- 楽器はWeb Audioノードで都度生成:
  - キック: sine 150→50Hzピッチエンベロープ + 短いディケイ
  - スネア: noise(bandpass 1800Hz) + triangle 180Hz、短ディケイ
  - ハット: noise(highpass 7000Hz)、閉=0.04s/開=0.25s
  - クラップ: noise(bandpass 1200Hz)を3連バースト
  - ベース: sawtooth + lowpass(cutoff 600Hz, Q2) + ADSR
  - コード: 各構成音をtriangle×2(軽くデチューン) + lowpass 2000Hz、ゆるいアタック(パッド)
  - リード: square + lowpass 3000Hz + 軽いビブラート(5.5Hz、LFO→detune)
- **[うた]トラック**: 評価時に `Utau.render()` でFloat32Arrayを事前レンダーし、AudioBufferとしてループ頭(トラック長の境界)で予約。
- マスター: 各トラック→GainNode(ミュート/音量)→コンプレッサ(DynamicsCompressorNode)→destination。
- **ライブ差し替え**: `player.apply(text)` を再生中に呼ぶと新しいparse結果を保持し、次の小節境界(16ステップごと)から新パターンで鳴らす(Strudelの核)。ループ長が変わってもOK。
- **コールバック**: `player.onStep(cb)` を毎16分で発火(`cb(step, bar)`。GUI可視化用)。
- **オフラインWAV書き出し**: `Band.renderWav(text)` が `OfflineAudioContext` でループ×2周をレンダーし、`engine.js` の `toWav` と同形式(16bit/44.1kHz/モノラル)でArrayBufferを返す(Promise)。
- パーサ部分(`parse`, コード展開, ドラム正規化)は `scheduleStep` などのWeb Audio呼び出しと分離してあり、Nodeでも `require('./synth.js')` して `Band.parse` が動く。`createPlayer().play()` / `renderWav()` はブラウザ判定でガードし、Node実行時は日本語のエラーメッセージを投げる。

## band.html(GUI)の設計

- `index.html` のデザイントーン(クリーム色系・角丸カード・絵文字ボタン)を踏襲。
- 左: 簡易版うたうちゃんの顔canvas。ビートに合わせて頭が上下(`onStep`のパルスで一時的にバウンス)。`[うた]`再生中は口パク。
- 右: エディタ(サンプル曲チップ3つ)+ ボタン(▶えんそう/■とめる/✎差し替え/⬇WAV保存/🔗共有リンク)+ テンポスライダー(60-200) + ミキサー(トラックごとミュート+音量) + ステップ可視化(トラック×16ステップのグリッド、現在ステップをハイライト、小節番号表示)。
- 共有リンク: URLハッシュにテキストをそのまま `encodeURIComponent` して `#b=` プレフィックスで埋め込み(圧縮なし)。ロード時に復元。
- `localStorage`(`bandchan-score`)に自動保存。
- パースエラーは赤字表示(行番号つき)、鳴らせるときだけ再生。

## 検証結果(実装時)

- `node -e` で `Band.parse` のスモークテスト: サンプルバンドテキスト(ドラム/ベース/コード/リード/うた全部入り)をパースし、tempo/swing/トラック数/loopLen16が期待通りであることを確認。
- 不正なドラム文字・音名・コード名・トラック指定なしの音符行が、いずれも行番号つき日本語エラーになることを確認。
- `npm run smoke`(既存の `sing.js` スモークテスト)が引き続き通ることを確認。
- `band.html` のインラインスクリプトを抽出して `new Function` に通し、構文エラーがないことを確認。
- `synth.js` をNodeで `require` して `createPlayer().play()` / `Band.renderWav()` を呼び、ブラウザ外では日本語の案内エラーを投げることを確認。
