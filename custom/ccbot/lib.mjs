// Pure helpers for ccbot: parsing, project lookup and run summaries. No I/O here, so the tests cover it whole.
import { basename } from 'node:path';

export const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
export const TERMINAL = new Set(['completed', 'cancelled', 'failed']);
// One argument as the SSH forced command accepts it: no spaces, quotes or shell characters. Free text goes on stdin.
const TOKEN = /^[\p{L}\p{N}._:/=@+,-]{1,200}$/u;

export function parseEnvFile(text) {
  const values = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    let value = line.slice(at + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    values[line.slice(0, at).trim()] = value;
  }
  return values;
}

// CCDT_PROJECT_MAP lines are `device_folder|server_folder[|memory]`; one project per server folder.
export function parseProjectMap(text) {
  const seen = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [device, server] = line.split('|');
    if (!device || !server?.startsWith('/')) continue;
    const folder = server.replace(/\/$/, '');
    if (!seen.has(folder)) seen.set(folder, { name: basename(folder), server: folder, device });
  }
  return [...seen.values()];
}

export function resolveProject(projects, wanted) {
  const exact = projects.filter((p) => p.name === wanted || p.server === wanted);
  if (exact.length === 1) return exact[0];
  const names = projects.map((p) => p.name).join(', ');
  if (!exact.length) throw new Error(`没有这个项目：${wanted}。可用：${names}`);
  throw new Error(`项目名有歧义：${wanted}，请写服务器路径。`);
}

// argv → { command, args, flags }. `--x v` and `--x=v` both work; a flag in `booleans` takes no value.
export function parseArgs(argv, booleans = new Set(['all', 'json', 'deny', 'no-wait', 'help'])) {
  const [command = 'help', ...rest] = argv;
  const args = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    if (!item.startsWith('--')) {
      args.push(item);
      continue;
    }
    const [key, inline] = item.slice(2).split(/=(.*)/s);
    if (booleans.has(key)) flags[key] = true;
    else if (inline !== undefined) flags[key] = inline;
    else if (i + 1 < rest.length) flags[key] = rest[++i];
    else throw new Error(`--${key} 缺少值`);
  }
  return { command, args, flags };
}

// The SSH forced command gets the client's command line as one string; split it without any shell.
export function splitForcedCommand(line) {
  const parts = (line ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts[0] === 'ccbot') parts.shift();
  for (const part of parts)
    if (!TOKEN.test(part)) throw new Error(`参数不允许：${JSON.stringify(part.slice(0, 40))}（自由文本请走标准输入）`);
  return parts;
}

export function findSession(sessions, ref) {
  if (!ref || ref.length < 6) throw new Error('会话 ID 至少写前 6 位');
  const hits = sessions.filter((s) => s.id.startsWith(ref));
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length ? `会话 ID 前缀有歧义：${ref}` : `没有这个会话：${ref}`);
}

export function sessionState(session) {
  const run = session.activeRun;
  if (!run) return 'idle';
  if (run.status === 'awaiting_approval') return run.waiting === 'question' ? 'question' : 'approval';
  if (run.waiting === 'background') return 'background';
  return run.status;
}

export function describeSession(session, projects = []) {
  const linked = projects.find((p) => session.projectPath === p.device);
  const where =
    session.device?.name === '服务端'
      ? '服务端'
      : `${session.device?.name ?? '?'}:${linked?.name ?? basename(session.projectPath)}`;
  const time = session.updatedAt.slice(5, 16).replace('T', ' ');
  return `${session.id.slice(0, 8)}  ${sessionState(session).padEnd(10)} ${time}  ${where}  ${session.title}`;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…（截断）` : text);
const tail = (text, max) => (text.length > max ? `…（前文略）${text.slice(-max)}` : text);

// What one run did, from its recorded events: the reply, the tools it used, and what it waits on.
export function summarizeRun(events) {
  const texts = new Map();
  const tools = new Map();
  const approvals = new Map();
  const errors = [];
  let status = 'running';
  let user = '';
  for (const { payload: p } of events) {
    if (p.type === 'message.user') user = p.text.split('\n任务：\n').pop();
    else if (p.type === 'text.delta') texts.set(p.messageId, (texts.get(p.messageId) ?? '') + p.text);
    else if (p.type === 'tool.requested') tools.set(p.toolId, { name: p.name, input: p.input, status: 'running' });
    else if (p.type === 'tool.input') {
      const tool = tools.get(p.toolId);
      if (tool) tool.input = p.input;
    } else if (p.type === 'tool.result') {
      const tool = tools.get(p.toolId);
      if (tool) tool.status = p.status;
    } else if (p.type === 'approval.requested') approvals.set(p.approvalId, p.toolId);
    else if (p.type === 'approval.resolved') approvals.delete(p.approvalId);
    else if (p.type === 'run.status') status = p.status;
    else if (p.type === 'run.error') errors.push(`${p.code}: ${p.message}`);
  }
  const counts = {};
  for (const tool of tools.values()) counts[tool.name] = (counts[tool.name] ?? 0) + 1;
  const failed = [...tools.values()].filter((t) => t.status === 'failed').map((t) => t.name);
  const pending = TERMINAL.has(status)
    ? []
    : [...approvals].map(([approvalId, toolId]) => {
        const tool = tools.get(toolId);
        return { approvalId, tool: tool?.name ?? '?', input: clip(tool?.input ?? '', 1500) };
      });
  const reply = [...texts.values()].filter((t) => t.trim()).join('\n\n');
  return { status, user: clip(user, 300), reply: tail(reply, 6000), counts, failed, pending, errors };
}

export function formatSummary(session, summary) {
  const state = sessionState(session);
  // A terminal run records no end of its own; an idle session has none going on.
  const round = state === 'idle' && !TERMINAL.has(summary.status) ? 'ended' : summary.status;
  const lines = [`会话 ${session.id.slice(0, 8)}「${session.title}」 状态：${state}（本轮 ${round}）`];
  if (summary.user) lines.push(`任务：${summary.user}`);
  const used = Object.entries(summary.counts).map(([name, n]) => `${name}×${n}`).join(' ');
  if (used) lines.push(`用了工具：${used}${summary.failed.length ? `；失败：${summary.failed.join(' ')}` : ''}`);
  for (const error of summary.errors) lines.push(`错误：${error}`);
  for (const item of summary.pending)
    lines.push(`等待审批 ${item.approvalId.slice(0, 8)}：${item.tool}\n${item.input}`);
  lines.push('', summary.reply || '（这一轮还没有文字回复）');
  return lines.join('\n');
}

// What a session started by the bot is told first, ahead of the user's task.
export function preamble(project) {
  return [
    `[Grok Bot 远程任务] 这是服务端会话，运行在服务器上，没有 device-zsh 通道。`,
    `项目 ${project.name}：Mac 上的路径是 ${project.device}。按全局规则访问 Mac：M4 用 ssh mac-dev（常年在线），Air 用 ssh mac-new（可能合盖离线）。`,
    `用户此时多半不在电脑前，消息经 Grok 转达。生产改库、推 main、部署、删除之前先停下来问；做完用简短中文写：做了什么、怎么验证的、还要用户拍板什么。`,
    '',
    '任务：',
  ].join('\n');
}
