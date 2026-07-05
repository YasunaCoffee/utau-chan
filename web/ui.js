/* うたうちゃん / バンドちゃん 共有UIヘルパ
 * index.html と band.html の両方から、ページ固有スクリプトより前に読み込む。
 * ここで宣言した関数・定数は後続の <script> から参照できる(古典スクリプトの共有グローバル環境)。
 * そのため各ページ側では同名の再宣言をしないこと(const の二重宣言はエラーになる)。 */

/* ---- トースト通知 ---- */
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---- 左カラムの吹き出しテキスト ---- */
function setSpeech(s){ document.getElementById('speech').textContent = s; }

/* ---- メタ情報バッジ(<span class="b">…</span>) ---- */
function badge(t){ return '<span class="b">' + t + '</span>'; }

/* ---- HiDPI対応の2Dキャンバス初期化 ---- */
function setupCanvas(cv, cssW, cssH){
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
  cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

/* ---- ジャケット画像(好きな画像を設定・localStorageに保存。両ページ共有) ---- */
const coverImg = document.getElementById('coverImg');
const coverEmpty = document.getElementById('coverEmpty');
const coverFile = document.getElementById('coverFile');
const COVER_KEY = 'utauchan-cover';   // うたうちゃん/バンドちゃんで共有
function showCover(dataUrl){
  if (dataUrl){
    coverImg.src = dataUrl;
    coverImg.style.display = 'block';
    coverEmpty.style.display = 'none';
  } else {
    coverImg.removeAttribute('src');
    coverImg.style.display = 'none';
    coverEmpty.style.display = 'block';
  }
}
function setCoverFromFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    // localStorageに収まるよう縮小して保存(長辺512px)
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 512 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * scale));
      cv.height = Math.max(1, Math.round(img.height * scale));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const dataUrl = cv.toDataURL('image/jpeg', 0.85);
      try { localStorage.setItem(COVER_KEY, dataUrl); } catch(_){ toast('画像が大きすぎて保存できなかったよ'); }
      showCover(dataUrl);
      toast('画像をせっていしたよ');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
document.getElementById('btnCover').addEventListener('click', () => coverFile.click());
coverFile.addEventListener('change', () => {
  if (coverFile.files && coverFile.files[0]) setCoverFromFile(coverFile.files[0]);
  coverFile.value = '';
});
document.getElementById('btnCoverClear').addEventListener('click', () => {
  try { localStorage.removeItem(COVER_KEY); } catch(_){}
  showCover(null);
  toast('画像をはずしたよ');
});
try { showCover(localStorage.getItem(COVER_KEY) || localStorage.getItem('utaukun-cover')); } catch(_){ showCover(null); }
