import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { acquireOwnership, readRuntime, localCall, secureDirectory } from '../src/local-runtime.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wechatbot-runtime-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('only one concurrent owner wins; release is scoped to its identity', async t => {
  const dir = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireOwnership(dir)));
  const successes = results.filter(r => r.status === 'fulfilled');
  assert.equal(successes.length, 1);
  const lock = successes[0].value;
  await assert.rejects(acquireOwnership(dir), /held by process/);
  const different = { ...lock.owner, instanceId: randomUUID() };
  await writeFile(join(dir, 'owner.lock'), JSON.stringify(different));
  await lock.release();
  assert.equal(JSON.parse(await readFile(join(dir, 'owner.lock'))).instanceId, different.instanceId);
  await rm(join(dir, 'owner.lock'));
  const next = await acquireOwnership(dir); await next.release();
  await assert.rejects(access(join(dir, 'owner.lock')), { code: 'ENOENT' });
});

test('proven exited PID is recovered; corrupt locks and interrupted guards fail closed', async t => {
  const dir = await fixture(t);
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await once(child, 'exit');
  await writeFile(join(dir, 'owner.lock'), JSON.stringify({ pid: child.pid, instanceId: randomUUID(), startedAt: new Date().toISOString() }));
  const lock = await acquireOwnership(dir); await lock.release();
  await writeFile(join(dir, 'owner.lock'), '{bad');
  await assert.rejects(acquireOwnership(dir), SyntaxError);
  assert.equal(await readFile(join(dir, 'owner.lock'), 'utf8'), '{bad');
  await mkdir(join(dir, 'owner.lock.guard'));
  await assert.rejects(acquireOwnership(dir), /interrupted/);
});

test('loopback RPC authenticates request and validates response identity', async t => {
  const dir = await fixture(t);
  assert.equal(await readRuntime(dir), null);
  const runtime = { host: '127.0.0.1', pid: process.pid, instanceId: randomUUID(), token: 'x'.repeat(48) };
  let replyId = runtime.instanceId;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${runtime.token}`);
    assert.equal(req.headers['x-wechatbot-instance'], runtime.instanceId);
    assert.equal(req.method, 'POST');
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ instanceId: replyId, result: JSON.parse(body) }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  runtime.port = server.address().port;
  await writeFile(join(dir, 'runtime.json'), JSON.stringify(runtime));
  assert.deepEqual(await localCall(dir, '/status', { check: 1 }), { check: 1 });
  replyId = randomUUID();
  await assert.rejects(localCall(dir, '/status'), /identity mismatch/);
  await assert.rejects(localCall(dir, '//example.com'), /Invalid local API path/);
  await assert.rejects(localCall(dir, 'https://example.com'), /Invalid local API path/);
  await writeFile(join(dir, 'runtime.json'), JSON.stringify({ ...runtime, host: 'example.com' }));
  await assert.rejects(localCall(dir, '/status'), /Invalid local runtime/);
});

test('Windows directory ACL grants only current user and SYSTEM', { skip: process.platform !== 'win32' }, async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'credential.json'), '{}');
  await secureDirectory(dir);
  const script = `$a=[System.IO.Directory]::GetAccessControl('${dir.replaceAll("'", "''")}'); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules=@($a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }); @{protected=$a.AreAccessRulesProtected;sid=$sid;rules=$rules} | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  const value = JSON.parse(stdout);
  assert.equal(value.protected, true);
  assert.deepEqual(value.rules.sort(), [value.sid, 'S-1-5-18'].sort());
});

test('stale runtime reports the local startup action instead of an opaque fetch failure', async t => {
  const dir = await fixture(t);
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(dir, 'runtime.json'), JSON.stringify({ host: '127.0.0.1', port, pid: process.pid, instanceId: randomUUID(), token: 'x'.repeat(48) }));
  await assert.rejects(localCall(dir, '/status', {}, { timeoutMs: 500 }), /node src\/cli.mjs start/);
});
