import { open, readFile, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const clone = value => JSON.parse(JSON.stringify(value));

export async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Single-process writer. The daemon must hold directory ownership. */
export class JsonStore {
  #path; #defaults; #value; #loaded = false; #tail = Promise.resolve(); #write;
  constructor(path, defaults, { write = writeJsonAtomic } = {}) {
    this.#path = path;
    this.#defaults = clone(defaults);
    this.#write = write;
  }
  #serial(operation) {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }
  load() {
    return this.#serial(async () => {
      if (this.#loaded) return this.read();
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      let value;
      try { value = JSON.parse(await readFile(this.#path, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        value = clone(this.#defaults);
        await this.#write(this.#path, value);
      }
      this.#value = clone(value);
      this.#loaded = true;
      return this.read();
    });
  }
  read() {
    if (!this.#loaded) throw new Error('State store has not been loaded');
    return clone(this.#value);
  }
  update(mutator) {
    return this.#serial(async () => {
      const next = this.read();
      const result = mutator(next);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new TypeError('State mutators must be synchronous');
      }
      const saved = clone(next);
      await this.#write(this.#path, saved);
      this.#value = saved;
      return this.read();
    });
  }
}
