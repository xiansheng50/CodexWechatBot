import { mkdir, open, readFile, unlink, rmdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Desktop calibration can wait for two consecutive 20-second pipe requests.
export const DAEMON_START_TIMEOUT_MS = 45000;

export function defaultDataDir() {
  if (process.env.WECHATBOT_DATA_DIR) return resolve(process.env.WECHATBOT_DATA_DIR);
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required; set WECHATBOT_DATA_DIR explicitly');
  return join(process.env.LOCALAPPDATA, 'WeChatBot');
}

export async function secureDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') return chmod(dir, 0o700);
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('../scripts/secure-data.ps1', import.meta.url)), '-Directory', resolve(dir)], { windowsHide: true });
}

async function ownershipGuard(dir, operation) {
  const guard = join(dir, 'owner.lock.guard');
  try { await mkdir(guard); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Ownership operation is in progress or interrupted; inspect owner.lock.guard before recovery');
    throw error;
  }
  try { return await operation(); }
  finally { await rmdir(guard); }
}

function validateOwner(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !uuid.test(owner.instanceId) ||
      typeof owner.startedAt !== 'string' || !Number.isFinite(Date.parse(owner.startedAt)) ||
      owner.processStartedAt !== undefined && !validProcessTime(owner.processStartedAt)) {
    throw new Error('Invalid ownership file; refusing automatic recovery');
  }
  return owner;
}

function validProcessTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

export async function getWindowsProcessStartedAt(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) throw new Error('Invalid process id');
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('../scripts/process-started-at.ps1', import.meta.url)), '-ProcessId', String(pid)], { windowsHide: true, timeout: 10000 });
  const value = stdout.trim();
  if (!validProcessTime(value)) throw new Error('Cannot verify process creation time');
  return value;
}

export async function acquireOwnership(dir, { getProcessStartedAt = process.platform === 'win32' ? getWindowsProcessStartedAt : null } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'owner.lock');
  async function processTime(pid) {
    const value = await getProcessStartedAt(pid);
    if (!validProcessTime(value)) throw new Error('Cannot verify process creation time; refusing automatic recovery');
    return value;
  }
  const ownProcessStartedAt = getProcessStartedAt ? await processTime(process.pid) : undefined;
  const owner = { pid: process.pid, instanceId: randomUUID(), startedAt: new Date().toISOString(),
    ...(ownProcessStartedAt ? { processStartedAt: ownProcessStartedAt } : {}) };
  await ownershipGuard(dir, async () => {
    let existing;
    try { existing = validateOwner(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      try { process.kill(existing.pid, 0); }
      catch (error) { if (error.code !== 'ESRCH') throw new Error('Cannot prove previous owner has exited', { cause: error });
        await unlink(path); existing = null;
      }
      if (existing && getProcessStartedAt) {
        const currentStartedAt = existing.pid === process.pid ? ownProcessStartedAt : await processTime(existing.pid);
        const replaced = existing.processStartedAt !== undefined
          ? Date.parse(currentStartedAt) !== Date.parse(existing.processStartedAt)
          : Date.parse(currentStartedAt) > Date.parse(existing.startedAt);
        // A live PID can belong to a different process after the owner exits.
        // Legacy locks lack the birth time; a later birth still proves reuse.
        if (replaced) { await unlink(path); existing = null; }
      }
      if (existing) throw new Error(`Daemon ownership is held by process ${existing.pid}`);
    }
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
    finally { await handle.close(); }
  });
  return {
    owner,
    async release() {
      await ownershipGuard(dir, async () => {
        let current;
        try { current = JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (current.instanceId === owner.instanceId) await unlink(path);
      });
    },
  };
}

export async function readRuntime(dir) {
  let runtime;
  try { runtime = JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!runtime || runtime.host !== '127.0.0.1' || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535 ||
      !Number.isSafeInteger(runtime.pid) || runtime.pid <= 0 || !uuid.test(runtime.instanceId) ||
      typeof runtime.token !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(runtime.token)) {
    throw new Error('Invalid local runtime file');
  }
  return runtime;
}

export async function localCall(dir, path, body = {}, { timeoutMs = 20000 } = {}) {
  if (typeof path !== 'string' || !/^\/[a-zA-Z0-9/_-]*$/.test(path) || path.startsWith('//')) throw new Error('Invalid local API path');
  const runtime = await readRuntime(dir);
  if (!runtime) throw new Error('WeChatBot daemon is not running');
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${runtime.token}`,
        'x-wechatbot-instance': runtime.instanceId }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('WeChatBot 本地服务不可达或响应超时，请运行 node src/cli.mjs start 并用 doctor 检查；不会自动重试写入。');
  }
  const value = await response.json();
  if (value.instanceId !== runtime.instanceId) throw new Error('Local daemon instance identity mismatch');
  if (!response.ok || value.error) throw new Error(typeof value.error === 'string' ? value.error : `Local API failed (${response.status})`);
  return value.result;
}
