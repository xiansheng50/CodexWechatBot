import { DesktopClient } from '../src/desktop-client.mjs';
import { writeFile } from 'node:fs/promises';

const [mode = 'read', target = process.env.CODEX_THREAD_ID, markerToFind] = process.argv.slice(2);
const client = new DesktopClient({ pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH,
  callerThreadId: process.env.CODEX_THREAD_ID, hostId: process.env.CODEX_APP_TOOLS_CALLER_HOST_ID || 'local' });
try {
  const check = await client.validate();
  const data = await client.read(target, { turnLimit: 3 });
  const receipt = { at: new Date().toISOString(), version: process.env.CODEX_VERSION,
    tools: check.tools, target: { id: data.thread.id, title: data.thread.title, hostId: data.thread.hostId, status: data.thread.status },
    turns: data.turns.map(t => ({ id: t.id, status: t.status })) };
  if (mode === 'send') {
    const marker = `WECHAT_MESSAGE_ID=P0-${Date.now()}`;
    receipt.marker = marker;
    receipt.send = await client.send(target, `${marker}\n这是用户授权的桥接测试。仅回复 ACK-${marker}，不要调用工具或修改文件；若正在执行任务，在 commentary 回复后继续原任务。`);
  } else if (mode === 'readback') {
    if (!markerToFind?.startsWith('WECHAT_MESSAGE_ID=P0-')) throw new Error('readback requires exact P0 marker');
    receipt.matches = data.turns.flatMap(t => {
      const delivery = t.items.find(i => i.type === 'functionCallOutput' && i.name === 'send_message_to_thread' && i.output?.text?.includes(markerToFind));
      const ack = t.items.find(i => i.type === 'agentMessage' && i.text?.trim() === `ACK-${markerToFind}`);
      return delivery && ack ? [{ turnId: t.id, status: t.status, deliveryItemId: delivery.id, phase: ack.phase, ack: ack.text }] : [];
    });
    if (!receipt.matches.length) throw new Error('Matching delivery and exact ACK were not found in recent turns');
  } else if (mode !== 'read') throw new Error('Usage: probe-desktop.mjs read|send|readback [threadId] [marker]');
  if (!/^[a-zA-Z0-9-]+$/.test(target)) throw new Error('Invalid receipt filename target');
  await writeFile(new URL(`../docs/p0-${mode}-${target}.json`, import.meta.url), JSON.stringify(receipt, null, 2));
  const { tools, ...summary } = receipt;
  console.log(JSON.stringify(summary, null, 2));
} finally { client.close(); }
