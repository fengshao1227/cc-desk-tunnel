#!/usr/bin/env node
// ccbot: lets a bot (Grok) drive CC Desk Tunnel sessions on this server. Reads go straight to the service's
// SQLite store (read-only); changes go through the service's own WebSocket as a client named "Grok Bot", so the
// GUI, ccdt and the web workbench see everything it does.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import * as lib from './lib.mjs';

const HOME = homedir();
const APP = process.env.CCBOT_APP ?? join(HOME, 'apps/cc-desk-tunnel/current');
const ENV_FILE = process.env.CCBOT_ENV ?? join(HOME, '.config/cc-desk-tunnel/service.env');
const DEVICE_FILE = join(HOME, '.config/cc-desk-tunnel/ccbot-device-id');
const USAGE = `ccbot：让 Grok 操作 CC Desk Tunnel 上的 Claude Code 会话。自由文本一律从标准输入给。

  ccbot ls [--all]                     最近的会话（--all 全部）
  ccbot projects                       可开会话的项目
  ccbot new <项目> [--title 标题] [--mode default|acceptEdits|plan|bypassPermissions] [--no-wait] [--timeout 秒]
                                       新建服务端会话并把标准输入作为第一个任务发出
  ccbot send <会话> [--no-wait] [--timeout 秒]   给会话发标准输入里的消息，默认等这一轮结束
  ccbot wait <会话> [--timeout 秒]     等当前这一轮结束或停在审批上
  ccbot show <会话>                    最近一轮的结果
  ccbot approve <会话> [--deny]        批准（或拒绝）正在等的那个工具调用
  ccbot answer <会话>                  回答 Claude 的提问：标准输入写答案（多个问题用 JSON {"问题":"答案"}）
  ccbot stop <会话>                    停止当前这一轮

退出码：0 完成  3 停在审批/提问上  4 等待超时仍在运行  1 出错`;

function config() {
  const env = lib.parseEnvFile(readFileSync(ENV_FILE, 'utf8'));
  const mapFile = env.CCDT_PROJECT_MAP;
  return {
    token: env.PROXY_TOKEN,
    port: Number(env.PROXY_PORT || 8787),
    cert: env.PROXY_TLS_CERT ? readFileSync(env.PROXY_TLS_CERT) : undefined,
    dataDir: env.PROXY_DATA_DIR,
    projects: mapFile && existsSync(mapFile) ? lib.parseProjectMap(readFileSync(mapFile, 'utf8')) : [],
  };
}

// ---------- reading the store ----------
function openStore(cfg) {
  return new DatabaseSync(join(cfg.dataDir, 'sessions.sqlite'), { readOnly: true });
}
function listSessions(db) {
  return db
    .prepare('SELECT metadata FROM sessions')
    .all()
    .map((row) => JSON.parse(row.metadata))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function getSession(db, id) {
  const row = db.prepare('SELECT metadata FROM sessions WHERE id = ?').get(id);
  if (!row) throw new Error(`会话不存在：${id}`);
  return JSON.parse(row.metadata);
}
function lastSequence(db, id) {
  return Number(db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM events WHERE session_id = ?').get(id).n);
}
// The latest run of a session (after `after`, if given) and its events.
function latestRun(db, id, after = 0) {
  const row = db
    .prepare('SELECT run_id FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence DESC LIMIT 1')
    .get(id, after);
  if (!row) return { runId: undefined, events: [] };
  const events = db
    .prepare('SELECT data FROM events WHERE session_id = ? AND run_id = ? ORDER BY sequence')
    .all(id, row.run_id)
    .map((r) => JSON.parse(r.data));
  return { runId: row.run_id, events };
}

// ---------- talking to the service ----------
async function connect(cfg) {
  const { PROTOCOL_VERSION } = await import(pathToFileURL(join(APP, 'packages/protocol/src/index.ts')).href);
  const WebSocket = createRequire(join(APP, 'package.json'))('ws');
  if (!existsSync(DEVICE_FILE)) writeFileSync(DEVICE_FILE, randomUUID() + '\n', { mode: 0o600 });
  const deviceId = readFileSync(DEVICE_FILE, 'utf8').trim();
  const socket = new WebSocket(`wss://127.0.0.1:${cfg.port}/ws`, {
    ca: cfg.cert,
    rejectUnauthorized: !!cfg.cert,
    checkServerIdentity: () => undefined, // pinned to the service's own certificate; its name is the public one
  });
  const pending = new Map();
  let ready;
  const opened = new Promise((resolve, reject) => {
    ready = { resolve, reject };
    socket.once('error', reject);
    socket.once('close', (code, reason) => reject(new Error(`连接关闭 ${code} ${reason}`)));
  });
  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'auth', protocolVersion: PROTOCOL_VERSION, token: cfg.token, deviceName: 'Grok Bot', tunnel: false }));
    socket.send(JSON.stringify({ type: 'device', id: deviceId, platform: 'linux' }));
  });
  socket.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.type === 'ready') ready.resolve();
    else if (message.type === 'connection.error') ready.reject(new Error(message.message));
    else if (message.type === 'response' && pending.has(message.requestId)) {
      const { resolve, reject } = pending.get(message.requestId);
      pending.delete(message.requestId);
      if (message.ok) resolve(message);
      else reject(new Error(`${message.code ?? 'error'}: ${message.message ?? ''}`));
    }
  });
  await opened;
  return {
    request(command) {
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ ...command, requestId }));
        setTimeout(() => pending.has(requestId) && (pending.delete(requestId), reject(new Error('服务端 30 秒没有回应'))), 30_000);
      });
    },
    close() {
      socket.send(JSON.stringify({ type: 'leave' }));
      socket.close(1000);
    },
  };
}

async function withService(cfg, work) {
  const client = await connect(cfg);
  try {
    return await work(client);
  } finally {
    client.close();
  }
}

// ---------- waiting ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitRun(cfg, id, after, timeoutSeconds) {
  const limit = Math.min(Math.max(Number(timeoutSeconds) || 900, 5), 3600) * 1000;
  const started = Date.now();
  for (;;) {
    const db = openStore(cfg);
    try {
      const session = getSession(db, id);
      const { events } = latestRun(db, id, after);
      const summary = lib.summarizeRun(events);
      const state = lib.sessionState(session);
      const ran = events.length > 0;
      const done = (ran && lib.TERMINAL.has(summary.status)) || (!ran && after === 0 && state === 'idle');
      if (done || (ran && state === 'idle')) return report(session, summary, 0);
      if (state === 'approval' || state === 'question') return report(session, summary, 3);
      if (Date.now() - started > limit) return report(session, summary, 4);
    } finally {
      db.close();
    }
    await sleep(2000);
  }
}
function report(session, summary, code) {
  console.log(lib.formatSummary(session, summary));
  if (code === 3) console.log('\n→ 需要审批：ccbot approve <会话> 或 --deny；提问用 ccbot answer <会话>');
  if (code === 4) console.log('\n→ 还在运行：稍后 ccbot wait <会话>');
  return code;
}

// ---------- commands ----------
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}
function pick(cfg, ref) {
  const db = openStore(cfg);
  try {
    return lib.findSession(listSessions(db), ref);
  } finally {
    db.close();
  }
}
function pendingApproval(cfg, session) {
  const db = openStore(cfg);
  try {
    const { runId, events } = latestRun(db, session.id);
    const [item] = lib.summarizeRun(events).pending;
    if (!item) throw new Error('这个会话没有在等审批');
    return { runId, ...item };
  } finally {
    db.close();
  }
}
async function send(cfg, session, text, flags) {
  if (!text) throw new Error('消息为空：从标准输入给');
  const db = openStore(cfg);
  const after = lastSequence(db, session.id);
  db.close();
  await withService(cfg, (c) => c.request({ type: 'message.send', sessionId: session.id, text, scenario: 'chat' }));
  if (flags['no-wait']) return console.log(`已发送到 ${session.id.slice(0, 8)}`), 0;
  return waitRun(cfg, session.id, after, flags.timeout);
}
// A new server session gets the project's server folder as its working directory, the way CCDT_PROJECT_MAP does
// for device sessions: a link made before its first run, so the CLI never creates a plain directory there.
function linkProject(cfg, session, project) {
  const link = join(cfg.dataDir, 'native', session.nativeRoot ?? session.id);
  try {
    lstatSync(link);
    throw new Error(`工作目录已存在，不能再链接：${link}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  mkdirSync(join(cfg.dataDir, 'native'), { recursive: true, mode: 0o700 });
  symlinkSync(project.server, link);
}

const commands = {
  help: () => (console.log(USAGE), 0),
  projects: (cfg) => {
    for (const p of cfg.projects) console.log(`${p.name.padEnd(22)} ${p.device}`);
    return 0;
  },
  ls: (cfg, { flags }) => {
    const db = openStore(cfg);
    const sessions = listSessions(db);
    db.close();
    for (const s of flags.all ? sessions : sessions.slice(0, 15)) console.log(lib.describeSession(s, cfg.projects));
    return 0;
  },
  show: (cfg, { args }) => {
    const session = pick(cfg, args[0]);
    const db = openStore(cfg);
    const { events } = latestRun(db, session.id);
    db.close();
    return report(session, lib.summarizeRun(events), 0);
  },
  wait: (cfg, { args, flags }) => waitRun(cfg, pick(cfg, args[0]).id, 0, flags.timeout),
  send: async (cfg, { args, flags }) => send(cfg, pick(cfg, args[0]), await readStdin(), flags),
  new: async (cfg, { args, flags }) => {
    const project = lib.resolveProject(cfg.projects, args[0]);
    const mode = flags.mode ?? process.env.CCBOT_DEFAULT_MODE ?? 'default';
    if (!lib.MODES.includes(mode)) throw new Error(`--mode 只能是 ${lib.MODES.join(' / ')}`);
    const task = await readStdin();
    if (!task) throw new Error('第一个任务为空：从标准输入给');
    const title = String(flags.title ?? `Grok·${project.name}`).slice(0, 120);
    const id = await withService(cfg, async (c) => {
      const { sessionId } = await c.request({ type: 'server.session.create', title });
      const db = openStore(cfg);
      const session = getSession(db, sessionId);
      db.close();
      linkProject(cfg, session, project);
      await c.request({ type: 'session.configure', sessionId, permissionMode: mode });
      return sessionId;
    });
    console.log(`新会话 ${id}（${project.name}，审批模式 ${mode}）`);
    return send(cfg, { id }, lib.preamble(project) + task, flags);
  },
  approve: async (cfg, { args, flags }) => {
    const session = pick(cfg, args[0]);
    const item = pendingApproval(cfg, session);
    const allowed = !flags.deny;
    await withService(cfg, (c) =>
      c.request({ type: 'approval.reply', sessionId: session.id, runId: item.runId, approvalId: item.approvalId, allowed }),
    );
    console.log(`${allowed ? '已批准' : '已拒绝'}：${item.tool}`);
    return 0;
  },
  answer: async (cfg, { args }) => {
    const session = pick(cfg, args[0]);
    const item = pendingApproval(cfg, session);
    if (item.tool !== 'AskUserQuestion') throw new Error(`在等的是 ${item.tool} 的审批，不是提问`);
    const text = await readStdin();
    const questions = JSON.parse(item.input || '{}').questions ?? [];
    let answers;
    if (text.startsWith('{')) answers = JSON.parse(text);
    else if (questions.length === 1) answers = { [questions[0].question]: text };
    else throw new Error('有多个问题：请用 JSON {"问题原文":"答案"}');
    await withService(cfg, (c) =>
      c.request({ type: 'approval.reply', sessionId: session.id, runId: item.runId, approvalId: item.approvalId, allowed: true, answers }),
    );
    console.log('已回答');
    return 0;
  },
  stop: async (cfg, { args }) => {
    const session = pick(cfg, args[0]);
    if (!session.activeRun) return console.log('没有在运行'), 0;
    await withService(cfg, (c) => c.request({ type: 'run.cancel', sessionId: session.id, runId: session.activeRun.id }));
    console.log('已停止');
    return 0;
  },
};

// Under the SSH forced command the arguments come in SSH_ORIGINAL_COMMAND; each call is logged, never stdin.
function argvOf() {
  const argv = process.argv.slice(2);
  if (argv[0] !== '--from-ssh') return argv;
  const parts = lib.splitForcedCommand(process.env.SSH_ORIGINAL_COMMAND);
  const dir = join(HOME, '.local/state/ccbot');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const from = (process.env.SSH_CLIENT ?? '').split(' ')[0];
  writeFileSync(join(dir, 'audit.log'), `${new Date().toISOString()} ${from} ${parts.join(' ')}\n`, { flag: 'a', mode: 0o600 });
  return parts;
}

async function main() {
  const parsed = lib.parseArgs(argvOf());
  const command = commands[parsed.flags.help ? 'help' : parsed.command];
  if (!command) throw new Error(`不认识的命令：${parsed.command}\n\n${USAGE}`);
  return command(parsed.command === 'help' ? undefined : config(), parsed);
}

main().then(
  (code) => process.exit(code ?? 0),
  (error) => {
    console.error(`ccbot: ${error.message}`);
    process.exit(1);
  },
);
