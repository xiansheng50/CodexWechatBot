#!/usr/bin/env node
import { readFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { configureMcp } from './mcp-config.mjs';
import { defaultDataDir, localCall, readRuntime, secureDirectory, DAEMON_START_TIMEOUT_MS } from './local-runtime.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const dir = defaultDataDir();
const configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
const print = value => console.log(JSON.stringify(value, null, 2));
async function start() {
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  try { const health = await localCall(dir, '/health', {}, { timeoutMs: 500 }); return { alreadyRunning: true, ...health }; } catch { /* daemon enforces ownership */ }
  await secureDirectory(dir);
  await mkdir(join(dir, 'logs'), { recursive: true });
  const file = await open(join(dir, 'logs', 'startup.log'), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, WECHATBOT_DATA_DIR: dir },
    detached: true, windowsHide: true, stdio: ['ignore', file.fd, file.fd],
  });
  let failure;
  child.once('error', e => { failure = e; });
  child.unref();
  await file.close();
  while (Date.now() < deadline) {
    if (failure) throw failure;
    try { return { alreadyRunning: false, ...await localCall(dir, '/health', {}, { timeoutMs: Math.max(1, Math.min(500, deadline - Date.now())) }) }; } catch { /* starting */ }
    await delay(100);
  }
  throw new Error(`启动未完成；查看 ${join(dir, 'logs', 'startup.log')}。无法确认旧进程退出时不会强杀。`);
}
async function login() {
  await start();
  const qr = await localCall(dir, '/login/start');
  const { default: QRCode } = await import('qrcode');
  const path = join(dir, 'login-qr.png');
  await QRCode.toFile(path, qr.payload, { width: 400, margin: 3 });
  print({ qrPath: path, note: '请用本人微信扫码确认，再在 ClawBot 发一条“帮助”。二维码5分钟内有效。' });
  if (args.includes('--qr-only')) return;
  let last;
  for (let i = 0; i < 300; i++) {
    const state = await localCall(dir, '/login/status');
    if (last !== state.status) { console.log(`登录状态：${state.status}`); last = state.status; }
    if (state.status === 'confirmed') { console.log('扫码已确认。请向 ClawBot 发一条“帮助”以取得回复上下文。'); return; }
    if (['error', 'expired', 'verify_code_blocked', 'binded_redirect'].includes(state.status)) throw new Error(state.error || `登录停止：${state.status}`);
    if (state.status === 'need_verifycode') {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { await localCall(dir, '/login/verify', { code: await prompt.question('请输入微信展示的配对码：') }); }
      finally { prompt.close(); }
    }
    await delay(1000);
  }
  throw new Error('登录等待超时，请重新运行 login');
}
async function autostart(action) {
  if (!['enable', 'disable'].includes(action)) throw new Error('用法：autostart enable|disable');
  if (process.platform !== 'win32') throw new Error('自启动仅支持 Windows');
  const script = fileURLToPath(new URL('../scripts/autostart.ps1', import.meta.url));
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Action', action, '-NodePath', process.execPath, '-CliPath', fileURLToPath(import.meta.url)], { windowsHide: true });
  console.log(stdout.trim());
}
try {
  if (command === 'start') print(await start());
  else if (command === 'stop') {
    const runtime = await readRuntime(dir);
    if (!runtime) print({ stopped: true, alreadyStopped: true });
    else {
      await localCall(dir, '/stop');
      let stopped = false;
      for (let i = 0; i < 250; i++) {
        const current = await readRuntime(dir);
        if (!current || current.instanceId !== runtime.instanceId) { stopped = true; break; }
        await delay(100);
      }
      if (!stopped) throw new Error('已请求正常停止，仍在等待进行中的操作结束；未强杀进程。');
      print({ stopped: true });
    }
  }
  else if (command === 'status' || command === 'doctor') {
    try {
      print({ ...await localCall(dir, '/health'), ...await localCall(dir, command === 'doctor' ? '/doctor' : '/status'), ...(command === 'doctor' ? { dataDir: dir, node: process.version,
        mcpConfigured: (await readFile(configPath, 'utf8')).includes('[mcp_servers.wechatbot]') } : {}) });
    } catch (e) { print({ running: false, error: e.message, dataDir: dir }); process.exitCode = 1; }
  } else if (command === 'login') await login();
  else if (command === 'login-status') print(await localCall(dir, '/login/status'));
  else if (command === 'login-verify') {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { print(await localCall(dir, '/login/verify', { code: await prompt.question('请输入微信展示的配对码：') })); }
    finally { prompt.close(); }
  } else if (['install-mcp', 'uninstall-mcp'].includes(command)) print(await configureMcp(configPath, command === 'install-mcp'));
  else if (command === 'notifications') print(await localCall(dir, '/notifications'));
  else if (command === 'retry-notification') {
    const n = (await localCall(dir, '/notifications')).find(n => n.id === args[0]);
    if (!n) throw new Error('未找到通知ID，先运行 notifications');
    print(n);
    console.log('重发可能造成重复通知。');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if ((await prompt.question('输入 resend 确认仅重发此通知：')).trim() !== 'resend') throw new Error('已取消');
      print(await localCall(dir, '/retry-notification', { id: n.id }));
    } finally { prompt.close(); }
  } else if (command === 'autostart') await autostart(args[0]);
  else if (command === 'help') console.log('wechatbot start | stop | status | doctor | login [--qr-only] | login-status | login-verify\nwechatbot install-mcp | uninstall-mcp | notifications | retry-notification <id> | autostart enable|disable\n也可使用 node src/cli.mjs <命令>。');
  else throw new Error(`未知命令 ${command}；运行 help 查看用法`);
} catch (e) { console.error(e.message); process.exitCode = 1; }
