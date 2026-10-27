import { readFile, writeFile, copyFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BEGIN = '# BEGIN wechatbot managed';
const END = '# END wechatbot managed';
export function changeMcpConfig(text, install) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new Error('Malformed wechatbot managed block; refusing to edit');
  if (start >= 0) {
    if (text.indexOf(BEGIN, start + 1) >= 0 || text.indexOf(END, end + 1) >= 0) throw new Error('Duplicate managed blocks');
    // Remove only our exact marked block; preserve all unrelated configuration.
    if (!install) return text.slice(0, start) + text.slice(end + END.length);
    return text;
  }
  if (!install) return text;
  if (/^\s*\[mcp_servers\.wechatbot(?:\]|\.)/m.test(text)) throw new Error('Unmanaged wechatbot entry already exists; refusing overwrite');
  return text + `\n${BEGIN}\n[mcp_servers.wechatbot]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fileURLToPath(new URL('./mcp.mjs', import.meta.url)))}]\nenv_vars = ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_APP_TOOLS_CALLER_HOST_ID"]\nstartup_timeout_sec = 20\n${END}\n`;
}
export async function configureMcp(path, install) {
  const before = await readFile(path, 'utf8');
  const after = changeMcpConfig(before, install);
  if (before === after) return { changed: false, config: path };
  const backup = `${path}.wechatbot-${Date.now()}.bak`;
  const temp = `${path}.wechatbot-${randomUUID()}.tmp`;
  await copyFile(path, backup);
  try {
    await writeFile(temp, after, { flag: 'wx' });
    if (await readFile(path, 'utf8') !== before) throw new Error('Codex config changed concurrently; retry without replacing it');
    await rename(temp, path);
  } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  return { changed: true, config: path, backup };
}
