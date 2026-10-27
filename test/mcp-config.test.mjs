import test from 'node:test';
import assert from 'node:assert/strict';
import { changeMcpConfig } from '../src/mcp-config.mjs';

test('install is idempotent and uninstall preserves unrelated MCP settings', () => {
  const before = '[mcp_servers.other]\ncommand = "other"\n[features]\na = true\n';
  const installed = changeMcpConfig(before, true);
  assert.equal(installed.startsWith(before), true);
  assert.equal(changeMcpConfig(installed, true), installed);
  assert.equal(changeMcpConfig(installed, false).trimEnd(), before.trimEnd());
  assert.match(installed, /env_vars = \["CODEX_APP_TOOLS_PIPE_PATH"/);
  assert.equal(installed.includes('CODEX_THREAD_ID'), false);
});

test('unmanaged or damaged configuration is never overwritten', () => {
  assert.throws(() => changeMcpConfig('[mcp_servers.wechatbot]\ncommand="owned"', true), /Unmanaged/);
  assert.throws(() => changeMcpConfig('# BEGIN wechatbot managed\n', false), /Malformed/);
});
