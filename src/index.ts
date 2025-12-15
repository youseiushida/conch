// src/index.ts
import * as pty from '@lydell/node-pty';
import { Terminal } from '@xterm/headless';
import * as net from 'net';
import * as os from 'os';

// 設定
const SHELL = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
const PORT = 3007;

// 1. ヘッドレスターミナルの作成
const term = new Terminal({
  allowProposedApi: true,
  cols: 80,
  rows: 24,
});

// 2. PTYプロセスの起動
const ptyProcess = pty.spawn(SHELL, [], {
  name: 'xterm-color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
  encoding: 'utf8', // 文字コードを明示
});

// 【追加】Windowsの場合、起動直後に文字コードをUTF-8に変更するコマンドを打っておく
if (os.platform() === 'win32') {
  ptyProcess.write('chcp 65001\r');
  // プロンプトが崩れるのを防ぐため画面クリアもしておく
  ptyProcess.write('Clear-Host\r');
}

console.log(`🚀 Headless Terminal started (PID: ${ptyProcess.pid})`);

// 3. データフロー: PTY -> xterm
ptyProcess.onData((data) => {
  term.write(data);
});

// 4. TCPサーバー
const server = net.createServer((socket) => {
  console.log('👤 Human connected via TCP');

  // Telnet交渉 (ローカルエコーOFFのおまじない)
  socket.write(Buffer.from([0xFF, 0xFB, 0x01, 0xFF, 0xFB, 0x03]));

  // A. PTY -> Human
  const onData = (data: string) => {
    // 改行コード補正 (\n -> \r\n)
    const fixedData = data.replace(/\n/g, '\r\n');
    if (socket.writable) socket.write(fixedData);
  };
  const disposable = ptyProcess.onData(onData);

  // B. Human -> PTY
  socket.on('data', (data) => {
    // 【修正】入力側の改行コード補正
    // TelnetのEnter(\r\n) を PTY用のEnter(\r) に変換する
    // これで「lsの位置が変」な問題が直ります
    const input = data.toString().replace(/\r\n/g, '\r');
    ptyProcess.write(input);
  });

  const cleanup = () => {
    console.log('👋 Human disconnected');
    disposable.dispose();
  };
  socket.on('close', cleanup);
  socket.on('error', (err) => {
    console.error('⚠️ Socket error:', err.message);
    cleanup();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔌 Intervention Server listening on port ${PORT}`);
});

// 定期スナップショット
setInterval(() => {
  const buffer = term.buffer.active;
  let screenText = '';
  
  const cursorY = buffer.cursorY;
  const viewportHeight = 20;
  const startLine = Math.max(0, cursorY - viewportHeight);
  const endLine = cursorY;

  for (let i = startLine; i <= endLine; i++) {
    const line = buffer.getLine(i);
    if (line) {
      screenText += line.translateToString(true) + '\n';
    }
  }

  console.log(`\n--- 🤖 Agent View (Rows: ${startLine} - ${endLine}, Cursor: ${cursorY}) ---`);
  console.log(screenText);
  console.log('------------------------------------------------------------');
}, 5000);