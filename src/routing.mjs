export const HELP = '列表 [页码]\n项目 [页码]\n新建 项目名｜首条要求（成功后自动切换）\n切换 #3\n#3 你的要求（单次，不切换目标）\n通知 #3 开 / 通知 #3 关\n状态 / 帮助\n普通文字发给上次明确选择的聊天。';

export function parseCommand(text) {
  text = text.trim();
  let m;
  if (text === '帮助') return { type: 'help' };
  if (text === '状态') return { type: 'status' };
  if ((m = /^项目(?:\s+([1-9]\d*))?$/.exec(text))) return { type: 'projects', page: Number(m[1] || 1) };
  if (/^新建(?:\s|[|｜]|$)/.test(text)) {
    m = /^新建\s+([^|｜\r\n]+)[|｜]([\s\S]*)$/.exec(text);
    if (!m || !m[1].trim() || !m[2].trim()) return { type: 'invalid_create' };
    return { type: 'create', project: m[1].trim(), text: m[2].trim() };
  }
  if ((m = /^列表(?:\s+([1-9]\d*))?$/.exec(text))) return { type: 'list', page: Number(m[1] || 1) };
  if ((m = /^切换\s+#([1-9]\d*)$/.exec(text))) return { type: 'select', number: Number(m[1]) };
  if ((m = /^通知\s+#([1-9]\d*)\s+(开|关)$/.exec(text))) return { type: 'notifications', number: Number(m[1]), enabled: m[2] === '开' };
  if ((m = /^#([1-9]\d*)(?:\s+([\s\S]+))?$/.exec(text))) return { type: 'message', number: Number(m[1]), text: m[2]?.trim() || '' };
  return { type: 'message', text };
}

export function ensureChat(state, thread) {
  if (thread.hostId !== 'local' || thread.kind !== 'codex' || thread.isSubagent || thread.parentThreadId || thread.archived || thread.status?.type === 'archived') {
    throw Object.assign(new Error('仅支持未归档的本地主聊天'), { code: 'TARGET_UNAVAILABLE' });
  }
  if (!state.chats[thread.id]) state.chats[thread.id] = {
    threadId: thread.id, hostId: 'local', number: state.nextNumber++, enabled: false,
    observation: { anchor: null, pending: [] },
  };
  const chat = state.chats[thread.id];
  chat.title = String(thread.title || '未命名聊天').slice(0, 120);
  chat.status = typeof thread.status === 'string' ? thread.status : thread.status?.type;
  return chat;
}

export function byNumber(state, number) {
  if (!Number.isSafeInteger(number)) throw new Error('无效聊天编号');
  const chat = Object.values(state.chats).find(c => c.number === number);
  if (!chat) throw new Error(`未知聊天 #${number}，请先发送“列表”`);
  return chat;
}

export function listText(state, page, pageSize = 10) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('无效页码');
  const chats = Object.values(state.chats).sort((a, b) => a.number - b.number);
  const pages = Math.max(1, Math.ceil(chats.length / pageSize));
  if (page > pages) throw new Error(`列表只有 ${pages} 页`);
  const lines = chats.slice((page - 1) * pageSize, page * pageSize).map(c =>
    `#${c.number} ${c.title}${c.threadId === state.selected ? ' [当前目标]' : ''}${c.enabled ? ' [通知开]' : ''}`);
  return `聊天列表 ${page}/${pages}\n${lines.join('\n') || '暂无聊天'}\n仅包含最近可发现及已注册聊天；旧聊天可在桌面调用微信工具注册。`;
}
