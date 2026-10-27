import test from 'node:test';
import assert from 'node:assert/strict';
import { localProjects, resolveProject, projectListText } from '../src/projects.mjs';

const bot = { projectId: 'bot-id', projectKind: 'local', label: '微信机器人', path: 'D:\\Projects\\WeChatBot', hostId: 'local', isGitRepository: false };
const server = { ...bot, projectId: 'server-id', label: '教链+腾讯会议代理', path: 'D:\\Projects\\EduForgeServer', isGitRepository: true };
const raw = { schemaVersion: 2, projects: [bot, server,
  { ...bot, projectId: 'remote-id', hostId: 'remote' },
  { projectId: 'cloud-id', projectKind: 'chatgpt', label: 'cloud' }] };

test('project resolution uses exact IDs, labels, Windows directory aliases and paths', () => {
  assert.deepEqual(localProjects(raw), [bot, server]);
  for (const selector of ['bot-id', '微信机器人', 'wechatbot', 'D:\\PROJECTS\\WECHATBOT\\', 'D:/Projects/WeChatBot']) {
    assert.equal(resolveProject(raw, selector), bot);
  }
  assert.equal(resolveProject(raw, '教链+腾讯会议代理'), server);
  assert.equal(resolveProject(raw, 'EduForgeServer'), server);
  for (const selector of ['wechat', 'remote-id', 'cloud-id', '不存在', '']) assert.throws(() => resolveProject(raw, selector));
});

test('ambiguous labels and directory aliases fail without guessing', () => {
  const duplicate = { ...bot, projectId: 'other-id', path: 'E:\\Other\\WeChatBot' };
  const data = { projects: [bot, duplicate] };
  assert.throws(() => resolveProject(data, '微信机器人'), /歧义/);
  assert.throws(() => resolveProject(data, 'wechatbot'), /歧义/);
  assert.equal(resolveProject(data, bot.path), bot);
  assert.equal(resolveProject(data, 'other-id'), duplicate);
  assert.throws(() => resolveProject({ projects: [bot, { ...duplicate, projectId: bot.label }] }, bot.label), /歧义/);
});

test('malformed local directory project data fails closed', () => {
  for (const data of [null, {}, { projects: {} }, { projects: [null] }, { projects: [{}] }]) assert.throws(() => localProjects(data));
  for (const patch of [{ path: '' }, { path: 'relative' }, { path: '\\rooted' }, { path: 'D:\\' }, { hostId: undefined }, { projectId: '' }, { label: '' }]) {
    assert.throws(() => localProjects({ projects: [bot, { ...server, ...patch }] }));
  }
  assert.deepEqual(localProjects({ projects: [{ ...bot, projectKind: 'projectless' }] }), []);
});

test('project list paginates local projects and gives usable creation examples', () => {
  const text = projectListText(raw, 1, 1);
  assert.match(text, /第 1\/2 页/);
  assert.match(text, /微信机器人（目录别名：WeChatBot）/);
  assert.match(text, /新建 WeChatBot｜首条要求/);
  assert.match(text, /下一页：项目 2/);
  assert.doesNotMatch(text, /remote|cloud|EduForgeServer/);
  const next = projectListText(raw, 2, 1);
  assert.match(next, /教链\+腾讯会议代理/);
  assert.doesNotMatch(next, /下一页/);
  assert.throws(() => projectListText(raw, 3, 1), /只有 2 页/);
  assert.throws(() => projectListText(raw, 0), /无效/);
  assert.throws(() => projectListText(raw, 1, 0), /无效/);
  assert.match(projectListText({ projects: [] }), /暂无/);
});
