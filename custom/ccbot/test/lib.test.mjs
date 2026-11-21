import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lib from '../lib.mjs';

const MAP = `# comment
/Users/li/a/new-api|/home/claude/projects/new-api|/mem
/Users/li/b/new-api|/home/claude/projects/new-api|
/Users/li/c/api|/home/claude/projects/api
broken line
`;

test('env file: comments, quotes, values with =', () => {
  const env = lib.parseEnvFile(`# x\nA=1\nB="two words"\nC='q'\nD=a=b\n\nbad\n`);
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'q', D: 'a=b' });
});

test('project map keeps one entry per server folder', () => {
  const projects = lib.parseProjectMap(MAP);
  assert.deepEqual(projects.map((p) => p.name), ['new-api', 'api']);
  assert.equal(projects[0].device, '/Users/li/a/new-api');
  assert.equal(lib.resolveProject(projects, 'api').server, '/home/claude/projects/api');
  assert.throws(() => lib.resolveProject(projects, 'nope'), /没有这个项目/);
});

test('args: flags with and without =, booleans, missing value', () => {
  assert.deepEqual(lib.parseArgs(['new', 'api', '--title=x', '--mode', 'plan', '--no-wait']), {
    command: 'new',
    args: ['api'],
    flags: { title: 'x', mode: 'plan', 'no-wait': true },
  });
  assert.throws(() => lib.parseArgs(['new', '--title']), /缺少值/);
  assert.equal(lib.parseArgs([]).command, 'help');
});

test('forced command refuses shell characters and spaces inside arguments', () => {
  assert.deepEqual(lib.splitForcedCommand('ccbot send 1a2b3c4d --timeout 600'), ['send', '1a2b3c4d', '--timeout', '600']);
  assert.deepEqual(lib.splitForcedCommand('new new-api --title=修复登录'), ['new', 'new-api', '--title=修复登录']);
  for (const bad of ['ls; rm -rf ~', 'ls $(id)', 'ls `id`', 'ls | sh', "ls 'x'", 'ls >x'])
    assert.throws(() => lib.splitForcedCommand(bad), /参数不允许/, bad);
  assert.deepEqual(lib.splitForcedCommand(undefined), []);
});

test('session lookup by prefix', () => {
  const sessions = [{ id: 'abcdef12-0000' }, { id: 'abcdef34-0000' }, { id: '99999999-0000' }];
  assert.equal(lib.findSession(sessions, '999999').id, '99999999-0000');
  assert.throws(() => lib.findSession(sessions, 'abcdef'), /歧义/);
  assert.throws(() => lib.findSession(sessions, 'abc'), /至少/);
  assert.throws(() => lib.findSession(sessions, '777777'), /没有这个会话/);
});

test('session state reads the active run', () => {
  assert.equal(lib.sessionState({ activeRun: null }), 'idle');
  assert.equal(lib.sessionState({ activeRun: { status: 'awaiting_approval', waiting: 'question' } }), 'question');
  assert.equal(lib.sessionState({ activeRun: { status: 'awaiting_approval', waiting: 'approval' } }), 'approval');
  assert.equal(lib.sessionState({ activeRun: { status: 'running', waiting: 'background' } }), 'background');
  assert.equal(lib.sessionState({ activeRun: { status: 'running' } }), 'running');
});

const ev = (payload) => ({ payload });
test('run summary: reply, tools, pending approval, errors', () => {
  const events = [
    ev({ type: 'message.user', messageId: 'u', text: '修一下', scenario: 'chat' }),
    ev({ type: 'run.status', status: 'running' }),
    ev({ type: 'text.delta', messageId: 'm1', text: '先看' }),
    ev({ type: 'text.delta', messageId: 'm1', text: '代码' }),
    ev({ type: 'tool.requested', toolId: 't1', name: 'Bash', input: 'ls' }),
    ev({ type: 'tool.result', toolId: 't1', status: 'failed', output: '', exitCode: 1 }),
    ev({ type: 'tool.requested', toolId: 't2', name: 'Bash', input: 'git push' }),
    ev({ type: 'approval.requested', approvalId: 'a1', toolId: 't2' }),
    ev({ type: 'tool.requested', toolId: 't3', name: 'Edit', input: '{}' }),
    ev({ type: 'approval.requested', approvalId: 'a2', toolId: 't3' }),
    ev({ type: 'approval.resolved', approvalId: 'a2', allowed: true }),
    ev({ type: 'run.status', status: 'awaiting_approval' }),
  ];
  const s = lib.summarizeRun(events);
  assert.equal(s.user, '修一下');
  assert.equal(s.reply, '先看代码');
  assert.deepEqual(s.counts, { Bash: 2, Edit: 1 });
  assert.deepEqual(s.failed, ['Bash']);
  assert.deepEqual(s.pending, [{ approvalId: 'a1', tool: 'Bash', input: 'git push' }]);
  const done = lib.summarizeRun([...events, ev({ type: 'run.error', code: 'x', message: 'y' }), ev({ type: 'run.status', status: 'failed' })]);
  assert.deepEqual(done.pending, []);
  assert.deepEqual(done.errors, ['x: y']);
  const text = lib.formatSummary({ id: '12345678-x', title: 'T', activeRun: null }, s);
  assert.match(text, /等待审批 a1：Bash/);
  assert.match(text, /Bash×2 Edit×1；失败：Bash/);
});

test('long replies keep their end', () => {
  const s = lib.summarizeRun([ev({ type: 'text.delta', messageId: 'm', text: 'x'.repeat(7000) + '结论' })]);
  assert.ok(s.reply.endsWith('结论'));
  assert.ok(s.reply.length < 6100);
});

test('preamble names the project and the Macs', () => {
  const text = lib.preamble({ name: 'new-api', device: '/Users/li/a/new-api' });
  assert.match(text, /new-api/);
  assert.match(text, /ssh mac-dev/);
  assert.ok(text.endsWith('任务：'));
});
