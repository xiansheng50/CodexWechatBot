export const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
export function isTerminal(turn) { return TERMINAL.has(turn.status); }

export function deliveryInTurn(turn, marker, operation = 'send') {
  if (typeof marker !== 'string' || !marker) return false;
  if (operation === 'create' && turn.items?.some(i => i.type === 'userMessage' && i.truncated !== true &&
      Array.isArray(i.content) && i.content.some(c => ['text', 'inputText'].includes(c.type) &&
        typeof c.text === 'string' && c.text.split(/\r?\n/, 1)[0] === marker))) return true;
  const toolName = operation === 'create' ? 'create_thread' : 'send_message_to_thread';
  return turn.items?.some(i => i.type === 'functionCallOutput' && i.name === toolName &&
    typeof i.output?.text === 'string' && i.output.truncated !== true &&
    i.output.text.split(/\r?\n/).some(line => line.trim() === `  <input>${marker}` || line.trim() === `<input>${marker}`));
}

export function truncate(text, max = 1500) {
  const points = Array.from(text);
  if (points.length <= max) return text;
  const suffix = '\n…内容已截断，请在桌面查看完整结果。';
  return points.slice(0, max - Array.from(suffix).length).join('') + suffix;
}

export function finalText(chat, turn, selectedNumber, mode = 'full') {
  const label = { completed: '本轮已结束', failed: '执行失败', interrupted: '已中断' }[turn.status];
  if (!label) throw new Error('Turn is not terminal');
  if (mode === 'brief') return `[#${chat.number} ${chat.title}] ${label}，请在 Codex 查看结果。`;
  const result = turn.items?.findLast(i => i.type === 'agentMessage' && i.phase === 'final_answer' &&
    typeof i.text === 'string' && i.text.trim())?.text.trim();
  const excerpt = result ? result.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/```[^\n]*\n/g, '').replace(/```/g, '') : '本轮没有最终文字回复，请回桌面查看实际状态。';
  const footer = `\n继续此聊天：#${chat.number} 你的要求\n当前普通消息目标${selectedNumber ? `仍为 #${selectedNumber}` : '尚未选择'}。`;
  const header = `[#${chat.number} ${chat.title}] ${label}\n`;
  const budget = Math.max(100, 1500 - Array.from(header + footer).length);
  return header + truncate(excerpt, budget) + footer;
}

export function addNotice(state, notice) {
  const existing = state.notifications.find(n => n.id === notice.id);
  if (existing) {
    if (notice.requested) {
      existing.requested = true;
      if (existing.status === 'cancelled') existing.status = 'pending';
    }
    return existing;
  }
  const next = { status: 'pending', createdAt: new Date().toISOString(), ...notice };
  state.notifications.push(next);
  return next;
}

export function recoverState(state) {
  for (const m of state.inbound) if (m.status === 'submitting') m.status = 'unknown';
  for (const n of state.notifications) {
    if (n.status === 'sending') { n.status = 'unknown'; n.error = '上次发送期间进程退出，送达状态未知'; }
    if (n.status === 'awaiting_context') { n.status = 'rejected'; n.error = '旧版发送被拒绝，请核对后手动重试'; }
    delete n.contextVersion;
  }
}
