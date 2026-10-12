# ローカルジャッジ(C / C++)

JS版ローカルジャッジのC / C++版。サーバはWSL(Ubuntu)の中で動き、gcc / g++ でコンパイル・実行する。
画面はWindowsのブラウザで http://localhost:2435 を開く(JS版の2434と同時に起動できる)。

## 準備(WSLのUbuntuで1回だけ)

```bash
sudo apt update
sudo apt install -y build-essential   # gcc / g++
node --version                         # 18以上。なければ nvm などで入れる

# AtCoder Library を使う場合(任意)
git clone https://github.com/atcoder/ac-library ~/ac-library
```

## 起動

- Windowsから: `start.bat` をダブルクリック
- WSLのターミナルから: `node backend/server.js`

フォルダはWindows側(`C:\...`)に置いたままでよい。コンパイルと実行はWSL内の `/tmp` で行うので遅くならない。

## JS版から増えたもの

- 言語切り替え(C++ gnu++20 / C gnu11)。言語ごとにコードを別々に保存
- コンパイル段階と **CE** 判定。エラーや警告はテストケース欄の上に表示
- 同じコードを再実行するときはコンパイルを省略
- **デバッグ実行**: AddressSanitizer / UBSan / `_GLIBCXX_DEBUG` で、配列外参照や未定義動作を行番号付きで検出(遅くなるのでTLE判定は参考程度)
- REのとき、シグナル(SIGSEGV など)や終了コードの説明を表示
- スタックを1GiBに広げて実行(深い再帰でも手元だけ落ちないように)
- コンパイルオプション: `-O2 -DONLINE_JUDGE -DATCODER -Wall`

## 環境変数(任意)

| 変数 | 意味 | 既定値 |
| --- | --- | --- |
| `PORT` | 待ち受けポート | 2435 |
| `CXX` / `CC` | 使うコンパイラ(例: `g++-12`) | `g++` / `gcc` |
| `ACL_DIR` | AtCoder Library の場所 | `~/ac-library` |
