import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { acquireOwnership, getWindowsProcessStartedAt } from '../src/local-runtime.mjs';

const previousBirth = '2020-01-01T00:00:00.000Z';
const currentBirth = '2020-01-01T00:00:02.000Z';

async function fixture(t, owner) {
  const dir = await mkdtemp(join(tmpdir(), 'wechatbot-owner-identity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'owner.lock');
  if (owner) await writeFile(path, JSON.stringify(owner));
  return { dir, path };
}

function previousOwner(fields = {}) {
  // Use our real, live PID: only the independently queried birth time is simulated.
  return { pid: process.pid, instanceId: randomUUID(), startedAt: '2020-01-01T00:00:01.000Z', ...fields };
}

function identity(birth = currentBirth) {
  return { getProcessStartedAt: async pid => {
    assert.equal(pid, process.pid);
    return birth;
  } };
}

test('a reused live PID with a different recorded process birth is recovered', async t => {
  const old = previousOwner({ processStartedAt: previousBirth });
  const { dir, path } = await fixture(t, old);
  const lock = await acquireOwnership(dir, identity());
  assert.notEqual(lock.owner.instanceId, old.instanceId);
  assert.equal(lock.owner.pid, process.pid);
  assert.equal(lock.owner.processStartedAt, currentBirth);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), lock.owner);
  await lock.release();
  await assert.rejects(access(path), { code: 'ENOENT' });
});

test('a legacy lock is recovered only when live process birth is later than lock creation', async t => {
  const old = previousOwner();
  const { dir } = await fixture(t, old);
  const lock = await acquireOwnership(dir, identity());
  assert.notEqual(lock.owner.instanceId, old.instanceId);
  await lock.release();
});

test('an invalid recorded birth cannot silently downgrade to a legacy lock', async t => {
  const { dir, path } = await fixture(t, previousOwner({ processStartedAt: 'not-a-date' }));
  const before = await readFile(path, 'utf8');
  await assert.rejects(acquireOwnership(dir, identity()));
  assert.equal(await readFile(path, 'utf8'), before);
});

test('a parseable non-ISO process birth is rejected without replacing the owner', async t => {
  const { dir, path } = await fixture(t, previousOwner({ processStartedAt: '1' }));
  const before = await readFile(path, 'utf8');
  await assert.rejects(acquireOwnership(dir, identity()));
  assert.equal(await readFile(path, 'utf8'), before);
});

test('an impossible calendar date in the owner cannot be normalized into a replacement', async t => {
  const { dir, path } = await fixture(t, previousOwner({ processStartedAt: '2020-02-31T00:00:00.000Z' }));
  const before = await readFile(path, 'utf8');
  await assert.rejects(acquireOwnership(dir, identity()));
  assert.equal(await readFile(path, 'utf8'), before);
});

test('an impossible own process date cannot create an unverifiable owner', async t => {
  const { dir, path } = await fixture(t);
  await assert.rejects(acquireOwnership(dir, identity('2020-02-31T00:00:00.000Z')));
  await assert.rejects(access(path), { code: 'ENOENT' });
});

test('an impossible existing process date after a valid own lookup preserves the owner', async t => {
  const { dir, path } = await fixture(t, previousOwner({ pid: process.ppid, processStartedAt: previousBirth }));
  const before = await readFile(path, 'utf8');
  const queried = [];
  await assert.rejects(acquireOwnership(dir, { getProcessStartedAt: async pid => {
    queried.push(pid);
    return pid === process.pid ? currentBirth : '2020-02-31T00:00:00.000Z';
  } }));
  assert.deepEqual(queried, [process.pid, process.ppid]);
  assert.equal(await readFile(path, 'utf8'), before);
});

for (const [name, old, birth] of [
  ['matching process birth', previousOwner({ processStartedAt: previousBirth }), previousBirth],
  ['legacy process born before lock', previousOwner(), previousBirth],
  ['legacy process born at lock creation', previousOwner(), '2020-01-01T00:00:01.000Z'],
]) {
  test(`${name} remains held and leaves lock bytes unchanged`, async t => {
    const { dir, path } = await fixture(t, old);
    const before = await readFile(path, 'utf8');
    await assert.rejects(acquireOwnership(dir, identity(birth)), /held by process/);
    assert.equal(await readFile(path, 'utf8'), before);
  });
}

for (const [name, lookup] of [
  ['unknown', async () => null],
  ['invalid', async () => 'not-a-date'],
  ['failed', async () => { throw new Error('identity lookup unavailable'); }],
]) {
  test(`${name} birth lookup cannot replace an existing lock`, async t => {
    const { dir, path } = await fixture(t, previousOwner({ processStartedAt: previousBirth }));
    const before = await readFile(path, 'utf8');
    await assert.rejects(acquireOwnership(dir, { getProcessStartedAt: lookup }));
    assert.equal(await readFile(path, 'utf8'), before);
  });

  test(`${name} own birth lookup cannot create an unverifiable owner`, async t => {
    const { dir, path } = await fixture(t);
    await assert.rejects(acquireOwnership(dir, { getProcessStartedAt: lookup }));
    await assert.rejects(access(path), { code: 'ENOENT' });
  });
}

for (const [name, lookup] of [
  ['unknown', async () => null],
  ['invalid', async () => 'not-a-date'],
  ['failed', async () => { throw new Error('existing identity unavailable'); }],
]) {
  test(`${name} existing-pid lookup after a valid own lookup preserves the lock`, async t => {
    const { dir, path } = await fixture(t, previousOwner({ pid: process.ppid, processStartedAt: previousBirth }));
    const before = await readFile(path, 'utf8');
    const queried = [];
    await assert.rejects(acquireOwnership(dir, { getProcessStartedAt: async pid => {
      queried.push(pid);
      if (pid === process.pid) return currentBirth;
      assert.equal(pid, process.ppid);
      return lookup();
    } }));
    assert.deepEqual(queried, [process.pid, process.ppid]);
    assert.equal(await readFile(path, 'utf8'), before);
  });
}

test('fresh ownership persists process birth, allows one concurrent owner and scopes release to instance', async t => {
  const { dir, path } = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireOwnership(dir, identity())));
  const successes = results.filter(result => result.status === 'fulfilled');
  assert.equal(successes.length, 1);
  const lock = successes[0].value;
  assert.equal(lock.owner.processStartedAt, currentBirth);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), lock.owner);
  await assert.rejects(acquireOwnership(dir, identity()), /held by process/);
  const replacement = { ...lock.owner, instanceId: randomUUID() };
  await writeFile(path, JSON.stringify(replacement));
  await lock.release();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), replacement);
});

test('Windows process birth is stable and agrees with the running Node process age', { skip: process.platform !== 'win32' }, async () => {
  const estimatedBirth = Date.now() - process.uptime() * 1000;
  const first = await getWindowsProcessStartedAt(process.pid);
  const second = await getWindowsProcessStartedAt(process.pid);
  assert.match(first, /Z$/);
  assert.equal(second, first);
  // Node uptime starts shortly after OS process creation. This also catches
  // local-time values accidentally labelled UTC or a different process's time.
  assert.ok(Math.abs(Date.parse(first) - estimatedBirth) < 5000,
    `Process birth ${first} disagrees with Node uptime estimate ${new Date(estimatedBirth).toISOString()}`);
});
