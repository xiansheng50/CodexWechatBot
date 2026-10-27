import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/state-store.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wechatbot-store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'state.json');
}

test('serial updates persist without loss and do not expose mutable state', async t => {
  const path = await fixture(t);
  const defaults = { count: 0, nested: { ok: true } };
  const store = new JsonStore(path, defaults);
  await store.load();
  defaults.count = 99;
  await Promise.all(Array.from({ length: 30 }, () => store.update(s => { s.count++; })));
  const copy = store.read(); copy.nested.ok = false;
  assert.equal(store.read().nested.ok, true);
  assert.equal(store.read().count, 30);
  const recovered = new JsonStore(path, {});
  assert.equal((await recovered.load()).count, 30);
  assert.deepEqual(JSON.parse(await readFile(path)), store.read());
});

test('mutator errors and failed disk writes cannot publish changes; queue recovers', async t => {
  const path = await fixture(t);
  await writeFile(path, '{"count":7}');
  let fail = true;
  const store = new JsonStore(path, {}, { write: async (target, state) => {
    if (fail) throw Object.assign(new Error('disk failure'), { code: 'ENOSPC' });
    await writeFile(target, JSON.stringify(state));
  } });
  await store.load();
  await assert.rejects(store.update(s => { s.count = 8; }), /disk failure/);
  assert.equal(store.read().count, 7);
  assert.equal(JSON.parse(await readFile(path)).count, 7);
  await assert.rejects(store.update(s => { s.count = 99; throw new Error('bad mutation'); }), /bad mutation/);
  await assert.rejects(store.update(async s => { s.count = 999; }), /synchronous/);
  fail = false;
  assert.equal((await store.update(s => { s.count++; })).count, 8);
});

test('corrupt JSON is preserved and cannot fall back to defaults', async t => {
  const path = await fixture(t);
  await writeFile(path, '{broken');
  const store = new JsonStore(path, { count: 0 });
  await assert.rejects(store.load(), SyntaxError);
  assert.throws(() => store.read(), /not been loaded/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('actual filesystem replacement failure leaves committed memory unchanged and removes temporary file', async t => {
  const path = await fixture(t);
  const store = new JsonStore(path, { count: 4 }); await store.load();
  await rm(path); await mkdir(path);
  await assert.rejects(store.update(s => { s.count = 5; }));
  assert.equal(store.read().count, 4);
  assert.deepEqual(await readdir(join(path, '..')), ['state.json']);
});
