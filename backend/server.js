// AtCoder用ローカルジャッジ(C / C++版) バックエンド
// WSL(Ubuntu)の中で動かす。依存パッケージなし。Node.js 18以上で動作。
//   起動: node backend/server.js  →  Windowsのブラウザで http://localhost:2435
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const HOST = process.env.HOST || '127.0.0.1'; // ループバックのみで待ち受け(外部公開しない)
const PORT = Number(process.env.PORT) || 2435; // JS版(2434)と同時に起動できるよう別ポート
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

const LIMITS = {
  bodyBytes: 20 * 1024 * 1024, // リクエスト全体
  codeBytes: 512 * 1024,       // ソースコード(AtCoderと同じ512KiB)
  cases: 100,
  timeMsMin: 100,
  timeMsMax: 20000,
  compileMs: 30000,            // コンパイルの制限時間
  stdoutBytes: 32 * 1024 * 1024,
  stderrBytes: 64 * 1024,
  compileMsgBytes: 256 * 1024, // テンプレートのエラーは長くなりがちなので多めに
};

// スタックサイズ(KiB)。深い再帰でも手元だけ落ちないよう1GiBまで広げる
// (unlimited にすると AddressSanitizer が動かないことがあるので有限値にしている)
const STACK_KIB = 1024 * 1024;

/* ---------- コンパイラの設定 ---------- */

// AtCoder Library(git clone https://github.com/atcoder/ac-library ~/ac-library)があれば使う
const ACL_DIR = process.env.ACL_DIR || path.join(os.homedir(), 'ac-library');
const HAS_ACL = fs.existsSync(path.join(ACL_DIR, 'atcoder'));

// -Wno-unused-result: Ubuntuのgccは scanf の戻り値を無視すると毎回警告するので黙らせる
const COMMON_FLAGS = ['-DONLINE_JUDGE', '-DATCODER', '-Wall', '-Wno-unused-result', '-fdiagnostics-color=never'];
const RELEASE_FLAGS = ['-O2'];
// デバッグ実行: 配列外参照・未定義動作を行番号付きで検出する(そのぶん遅くなる)
const DEBUG_FLAGS = [
  '-O1', '-g',
  '-fsanitize=address,undefined',
  '-fno-omit-frame-pointer',
  '-fno-sanitize-recover=all',
];

const LANGS = {
  cpp: {
    compiler: process.env.CXX || 'g++',
    source: 'Main.cpp',
    flags: ['-std=gnu++20', ...(HAS_ACL ? ['-I', ACL_DIR] : [])],
    debugFlags: ['-D_GLIBCXX_DEBUG'], // vector[] の範囲外なども検出
    libs: [],
  },
  c: {
    compiler: process.env.CC || 'gcc',
    source: 'Main.c',
    flags: ['-std=gnu11'],
    debugFlags: [],
    libs: ['-lm'],
  },
};

for (const L of Object.values(LANGS)) {
  try {
    L.version = execFileSync(L.compiler, ['-dumpfullversion'], { encoding: 'utf8' }).trim();
  } catch {
    L.version = null; // 見つからない
  }
}

function compilerLabel(lang) {
  const L = LANGS[lang];
  return L.version ? `${L.compiler} ${L.version}` : L.compiler;
}

/* ---------- 判定 ---------- */

// 行末の空白と末尾の空行を無視して比較(AtCoderの判定に近い挙動)
function normalize(s) {
  const lines = s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/* ---------- コンパイル ---------- */

function compile(lang, debug, dir, ctl) {
  const L = LANGS[lang];
  const args = [
    ...L.flags,
    ...COMMON_FLAGS,
    ...(debug ? [...DEBUG_FLAGS, ...L.debugFlags] : RELEASE_FLAGS),
    '-o', 'a.out',
    L.source, // cwd基準の相対パスにして、エラーが「Main.cpp:3:5:」の形で出るようにする
    ...L.libs,
  ];
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const child = spawn(L.compiler, args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
    });
    ctl.kill = () => child.kill('SIGKILL');

    let message = '';
    let truncated = false;
    let timedOut = false;
    const collect = (chunk) => {
      if (message.length < LIMITS.compileMsgBytes) message += chunk.toString('utf8');
      else truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, LIMITS.compileMs);

    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        message: `コンパイラ(${L.compiler})を起動できませんでした: ${err.message}\nWSLで sudo apt install build-essential を実行してください。`,
        timeMs: 0,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timeMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
      if (truncated) message = message.slice(0, LIMITS.compileMsgBytes) + '\n…(長すぎるので以降は省略)';
      if (timedOut) message += `\nコンパイルが${LIMITS.compileMs / 1000}秒以内に終わりませんでした。`;
      resolve({ ok: code === 0 && !timedOut, message, timeMs });
    });
  });
}

// 直前にコンパイルした実行ファイル。同じコード・言語・モードならコンパイルを省略する
let cache = null; // { key, dir, message }

async function getBinary(lang, debug, code, ctl) {
  const key = crypto.createHash('sha256').update(JSON.stringify([lang, debug, code])).digest('hex');
  if (cache?.key === key) {
    return { ok: true, message: cache.message, timeMs: 0, cached: true, dir: cache.dir };
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atcoder-judge-c-'));
  await fsp.writeFile(path.join(dir, LANGS[lang].source), code, 'utf8');
  const r = await compile(lang, debug, dir, ctl);
  if (!r.ok || ctl.aborted) {
    await fsp.rm(dir, { recursive: true, force: true });
    return { ...r, ok: r.ok && !ctl.aborted, cached: false };
  }

  const old = cache;
  cache = { key, dir, message: r.message };
  if (old) await fsp.rm(old.dir, { recursive: true, force: true });
  return { ...r, cached: false, dir };
}

/* ---------- 1ケース実行 ---------- */

function runOne(dir, input, timeLimitMs, ctl) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    // sh でスタックサイズを広げてから exec で置き換える(PIDは同じなのでkillもそのまま効く)
    const child = spawn('/bin/sh', ['-c', `ulimit -s ${STACK_KIB} 2>/dev/null; exec ./a.out`], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH, // 親の環境変数は渡さない
        LANG: 'C.UTF-8',
        ASAN_OPTIONS: 'detect_leaks=0', // 競プロではメモリリークは問題にしない
        UBSAN_OPTIONS: 'print_stacktrace=1',
      },
    });
    // ブラウザ側が途中で切断したとき、実行中のプロセスを止められるようにする
    ctl.kill = () => child.kill('SIGKILL');

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let outputLimitExceeded = false;
    let killedByTimer = false;

    // TLEでもどれくらい遅いか分かるよう、制限の2倍(最大+5秒)まで待ってから強制終了
    const hardKillMs = Math.min(timeLimitMs * 2, timeLimitMs + 5000);
    const timer = setTimeout(() => {
      killedByTimer = true;
      child.kill('SIGKILL');
    }, hardKillMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > LIMITS.stdoutBytes) {
        outputLimitExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < LIMITS.stderrBytes) stderr += chunk.toString('utf8');
    });

    // 入力を読まずに終了するコードだとEPIPEになるので握りつぶす
    child.stdin.on('error', () => {});
    child.stdin.end(input);

    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: `プロセスを起動できませんでした: ${err.message}` });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timeMs = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({
        stdout,
        stderr: stderr.slice(0, LIMITS.stderrBytes),
        exitCode: code,
        signal,
        timeMs: Math.round(timeMs),
        killedByTimer,
        outputLimitExceeded,
      });
    });
  });
}

/* ---------- 全ケース実行 ---------- */

function decide(r, tc, timeLimitMs) {
  if (r.error) return 'IE';
  if (r.outputLimitExceeded) return 'OLE';
  if (r.killedByTimer || r.timeMs > timeLimitMs) return 'TLE';
  if (r.exitCode !== 0 || r.signal) return 'RE';
  if (tc.expected.trim() === '') return 'DONE'; // 期待出力なし=実行のみ
  return normalize(r.stdout) === normalize(tc.expected) ? 'AC' : 'WA';
}

function summarize(results, lang) {
  const judged = results.filter((r) => r.status !== 'DONE');
  const priority = ['IE', 'RE', 'OLE', 'TLE', 'WA'];
  const overall =
    judged.length === 0
      ? 'DONE'
      : priority.find((p) => judged.some((r) => r.status === p)) ?? 'AC';
  return {
    overall,
    maxTimeMs: Math.max(0, ...results.map((r) => r.timeMs ?? 0)),
    compiler: compilerLabel(lang),
  };
}

// 送る行の種類:
//   { type: 'compile', ok, message, timeMs, cached }  … 最初に1回
//   { type: 'summary', summary }                      … コンパイルエラーのときだけ
//   { type: 'case', index, result, summary? }         … 1ケースごと。最後のケースに総合判定が付く
async function judge({ code, language, debug, testCases, timeLimitMs }, send, ctl) {
  const bin = await getBinary(language, debug, code, ctl);
  if (ctl.aborted) return;
  send({ type: 'compile', ok: bin.ok, message: bin.message, timeMs: bin.timeMs, cached: bin.cached });
  if (!bin.ok) {
    send({ type: 'summary', summary: { overall: 'CE', maxTimeMs: 0, compiler: compilerLabel(language) } });
    return;
  }

  // 実行時間を正確に測るため、並列ではなく1ケースずつ順番に実行
  const results = [];
  for (let i = 0; i < testCases.length; i++) {
    if (ctl.aborted) return;
    const tc = testCases[i];
    const r = await runOne(bin.dir, tc.input, timeLimitMs, ctl);
    if (ctl.aborted) return;

    const result = {
      status: decide(r, tc, timeLimitMs),
      timeMs: r.timeMs ?? null,
      stdout: r.stdout ?? '',
      stderr: r.error ?? r.stderr ?? '',
      exitCode: r.exitCode ?? null,
      signal: r.signal ?? null,
    };
    results.push(result);

    const line = { type: 'case', index: i, result };
    if (i === testCases.length - 1) line.summary = summarize(results, language);
    send(line);
  }
}

/* ---------- 入力検証 ---------- */

function validate(body) {
  if (typeof body !== 'object' || body === null) return 'JSONの形式が不正です';
  const { code, language, debug, testCases, timeLimitMs } = body;
  if (!Object.hasOwn(LANGS, language)) return '言語の指定が不正です';
  if (debug !== undefined && typeof debug !== 'boolean') return 'デバッグ指定の形式が不正です';
  if (typeof code !== 'string' || code.trim() === '') return 'コードが空です';
  if (Buffer.byteLength(code) > LIMITS.codeBytes) return 'コードが512KiBを超えています';
  if (!Array.isArray(testCases) || testCases.length === 0) return 'テストケースが1つもありません';
  if (testCases.length > LIMITS.cases) return `テストケースは${LIMITS.cases}個までです`;
  for (const tc of testCases) {
    if (typeof tc?.input !== 'string' || typeof tc?.expected !== 'string') {
      return 'テストケースの形式が不正です';
    }
  }
  if (!Number.isFinite(timeLimitMs) || timeLimitMs < LIMITS.timeMsMin || timeLimitMs > LIMITS.timeMsMax) {
    return `実行時間制限は${LIMITS.timeMsMin}〜${LIMITS.timeMsMax}msで指定してください`;
  }
  return null;
}

/* ---------- HTTP ---------- */

// DNSリバインディング対策: Hostヘッダがlocalhost系以外なら拒否
function isLocalHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

// 他サイトのページからコード実行APIを叩かれないようOriginを確認
function isAllowedOrigin(origin) {
  if (!origin) return true; // curl等
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.join(FRONTEND_DIR, rel);
  // ディレクトリトラバーサル防止
  if (!filePath.startsWith(FRONTEND_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

let busy = false; // 同時実行はしない(計測がぶれるため)

const server = http.createServer((req, res) => {
  if (!isLocalHost(req.headers.host)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (req.method === 'GET' && req.url === '/api/info') {
    sendJson(res, 200, {
      languages: Object.fromEntries(
        Object.entries(LANGS).map(([k, L]) => [k, { compiler: L.compiler, version: L.version }]),
      ),
      acl: HAS_ACL,
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/run') {
    if (!isAllowedOrigin(req.headers.origin)) {
      sendJson(res, 403, { error: '許可されていないOriginです' });
      return;
    }
    if (busy) {
      sendJson(res, 409, { error: '別の実行が進行中です。終わってから再実行してください' });
      return;
    }

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.bodyBytes) {
        sendJson(res, 413, { error: 'リクエストが大きすぎます' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        sendJson(res, 400, { error: 'JSONを解析できませんでした' });
        return;
      }
      const problem = validate(body);
      if (problem) {
        sendJson(res, 400, { error: problem });
        return;
      }
      body.debug = body.debug === true;

      // ここから先は NDJSON(1行に1つのJSON)で、段階が進むたびに1行ずつ送る
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.flushHeaders();
      const sendLine = (obj) => {
        if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
      };

      // ブラウザを閉じた・再読み込みしたなどで接続が切れたら、残りは実行しない
      const ctl = { aborted: false, kill: null };
      res.on('close', () => {
        if (!res.writableFinished) {
          ctl.aborted = true;
          ctl.kill?.();
        }
      });

      busy = true;
      try {
        await judge(body, sendLine, ctl);
      } catch (e) {
        sendLine({ type: 'error', error: `内部エラー: ${e.message}` });
      } finally {
        busy = false;
        res.end();
      }
    });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405).end();
});

// 前回の起動で残った作業フォルダを片付ける
for (const name of fs.readdirSync(os.tmpdir())) {
  if (name.startsWith('atcoder-judge-c-')) {
    try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); } catch { /* 無視 */ }
  }
}

// 終了時にコンパイル済みファイルを片付ける
function cleanup() {
  if (cache) {
    try { fs.rmSync(cache.dir, { recursive: true, force: true }); } catch { /* 無視 */ }
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log(`ローカルジャッジ(C / C++)起動: http://localhost:${PORT}  (Node ${process.version})`);
  for (const [name, L] of Object.entries(LANGS)) {
    console.log(`  ${name.padEnd(3)}: ${L.version ? `${L.compiler} ${L.version}` : `${L.compiler} が見つかりません(sudo apt install build-essential)`}`);
  }
  console.log(`  ACL: ${HAS_ACL ? ACL_DIR : 'なし(使うなら git clone https://github.com/atcoder/ac-library ~/ac-library)'}`);
});
