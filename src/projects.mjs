import { win32 } from 'node:path';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const fold = value => value.toLowerCase();
const directory = value => win32.normalize(value).replace(/[\\/]+$/, '');

export function localProjects(raw) {
  if (!raw || !Array.isArray(raw.projects)) throw new Error('Desktop 项目列表结构不兼容，请运行 doctor');
  const projects = [];
  for (const project of raw.projects) {
    if (!project || typeof project !== 'object' || !nonempty(project.projectKind)) {
      throw new Error('Desktop 项目结构不兼容，请运行 doctor');
    }
    if (project.projectKind !== 'local') continue;
    if (!nonempty(project.hostId)) throw new Error('Desktop 本地项目缺少主机信息');
    if (project.hostId !== 'local') continue;
    if (!nonempty(project.projectId) || !nonempty(project.label) || !nonempty(project.path) ||
        !win32.isAbsolute(project.path) || !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(project.path) ||
        directory(project.path) === directory(win32.parse(project.path).root)) {
      throw new Error('Desktop 本地项目缺少有效名称、ID 或完整目录');
    }
    projects.push(project);
  }
  return projects;
}

export function resolveProject(raw, selector) {
  const projects = localProjects(raw);
  if (!nonempty(selector)) throw new Error('请指定项目，可先发送“项目”查看列表');
  const query = fold(selector.trim());
  const matches = projects.filter(project =>
    [project.projectId, project.label, win32.basename(directory(project.path))].some(value => fold(value) === query) ||
    fold(directory(project.path)) === fold(directory(selector.trim())));
  if (!matches.length) throw new Error('未找到指定的本地主机项目，请发送“项目”查看列表');
  if (matches.length !== 1) throw new Error('项目名称有歧义，请使用完整目录或项目 ID');
  return matches[0];
}

export function projectListText(raw, page = 1, pageSize = 10) {
  const projects = localProjects(raw);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('项目页码或分页大小无效');
  const pages = Math.max(1, Math.ceil(projects.length / pageSize));
  if (page > pages) throw new Error(`项目列表只有 ${pages} 页`);
  const lines = [`本地主机项目（第 ${page}/${pages} 页，共 ${projects.length} 个）`];
  for (const project of projects.slice((page - 1) * pageSize, page * pageSize)) {
    lines.push(`${project.label}（目录别名：${win32.basename(directory(project.path))}）`, `  ${project.path}`);
  }
  if (!projects.length) lines.push('暂无可用的本地主机目录项目');
  if (page < pages) lines.push(`下一页：项目 ${page + 1}`);
  const example = projects[(page - 1) * pageSize];
  lines.push(`新建示例：新建 ${example ? win32.basename(directory(example.path)) : '项目名'}｜首条要求`);
  return lines.join('\n');
}
