import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callerFromMetadata } from './desktop-client.mjs';
import { defaultDataDir, localCall, DAEMON_START_TIMEOUT_MS } from './local-runtime.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dataDir = defaultDataDir();
const discovered = { pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH,
  hostId: process.env.CODEX_APP_TOOLS_CALLER_HOST_ID || 'local', codeVersion: process.env.CODEX_VERSION || null };
// Recovery runs once per MCP process, independently of the stdio handshake.
// Reuse the CLI's ownership checks and hidden, detached daemon launcher.
const startup = (async () => {
  try {
    try { await localCall(dataDir, '/health', {}, { timeoutMs: 1000 }); }
    catch {
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'start'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, WECHATBOT_DATA_DIR: dataDir },
        windowsHide: true, timeout: DAEMON_START_TIMEOUT_MS + 5000, maxBuffer: 64 * 1024,
      });
    }
  } catch {
    const error = new Error(`WeChatBot 本地服务启动恢复失败；请运行 node "${fileURLToPath(new URL('./cli.mjs', import.meta.url))}" start，并检查 ${join(dataDir, 'logs', 'startup.log')}。不会自动重复启动或重试写入。`);
    console.error(error.message);
    return error;
  }
  try { await localCall(dataDir, '/desktop-discovery', discovered, { timeoutMs: 10000 }); }
  catch { console.error('WeChatBot 桌面连接注册未完成；请在当前 Codex 聊天调用 wechat_status 重新注册。'); }
  return null;
})();

const tools = [
  { name: 'wechat_set_notifications', description: '仅在用户明确要求时，为当前调用聊天持续开启或关闭微信完成通知。', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false } },
  { name: 'wechat_select_current_chat', description: '仅在用户明确要求时，把当前调用聊天设为微信普通消息目标，开启其持续完成通知，并关闭原目标的持续完成通知。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'wechat_status', description: '读取微信桥接状态及当前调用聊天身份；不改变通知或选择。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
const server = new Server({ name: 'wechatbot', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    if (!tools.some(t => t.name === request.params.name)) throw new Error('Unknown tool');
    const caller = callerFromMetadata(request.params._meta);
    const startupError = await startup;
    const result = await localCall(dataDir, '/mcp', {
      connection: { ...discovered, callerThreadId: caller.threadId, callerTurnId: caller.turnId },
      caller, tool: request.params.name, arguments: request.params.arguments || {},
    }).catch(error => { throw startupError ? new Error(`${error.message}\n${startupError.message}`) : error; });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
});
await server.connect(new StdioServerTransport());
