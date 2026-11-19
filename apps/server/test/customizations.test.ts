import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readlinkSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { linkProjectRoot, mappedServerFolder } from '../src/project-links.ts';
import { templateDevicePrompt } from '../src/device-prompt.ts';
import { defaultPermissionMode, effectivePermissionMode } from '../src/permission-default.ts';
import { remotePrompt } from '../src/claude.ts';
import type { Execution } from '../src/device-terms.ts';

const MAP = [
  '# comment',
  '/Users/me/work/app|/srv/projects/app|/ignored/memory',
  '/Users/me/work|/srv/projects/work',
  'relative|not/absolute',
].join('\n');

test('project map: longest device folder wins, subfolders follow, unmapped and escapes are refused', () => {
  assert.equal(mappedServerFolder(MAP, '/Users/me/work/app'), '/srv/projects/app');
  assert.equal(mappedServerFolder(MAP, '/Users/me/work/app/sub/dir'), '/srv/projects/app/sub/dir');
  assert.equal(mappedServerFolder(MAP, '/Users/me/work/other'), '/srv/projects/work/other');
  assert.equal(mappedServerFolder(MAP, '/Users/me/workshop'), undefined);
  assert.equal(mappedServerFolder(MAP, '/Users/me/work/app/../../../etc'), undefined);
  assert.equal(mappedServerFolder(MAP, 'relative/x'), undefined);
});

test('project link: a new root becomes a symlink, an existing one is left alone, no map means no change', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'links-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const map = join(dir, 'projects.conf');
  writeFileSync(map, `/Users/me/app|${join(dir, 'server', 'app')}\n`);
  const data = join(dir, 'data');

  linkProjectRoot(data, 'r1', '/Users/me/app', map);
  assert.ok(lstatSync(join(data, 'native', 'r1')).isSymbolicLink());
  assert.equal(readlinkSync(join(data, 'native', 'r1')), join(dir, 'server', 'app'));
  assert.ok(existsSync(join(dir, 'server', 'app')));

  linkProjectRoot(data, 'r1', '/Users/me/app', map); // second call: untouched
  assert.ok(lstatSync(join(data, 'native', 'r1')).isSymbolicLink());

  linkProjectRoot(data, 'r2', '/Users/me/elsewhere', map);
  linkProjectRoot(data, 'r3', 'C:\\Users\\me\\app', map);
  linkProjectRoot(data, 'r4', '/Users/me/app', undefined);
  for (const root of ['r2', 'r3', 'r4']) assert.equal(existsSync(join(data, 'native', root)), false);
});

test('device prompt: template replaces placeholders, missing or empty template keeps upstream', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'prompt.md');
  const execution: Execution = { platform: 'darwin', shells: ['zsh'], shell: undefined };
  writeFileSync(file, 'Device {{device}} at {{project}}, session {{session}}. {{script}}');
  const text = templateDevicePrompt('/Users/me/app', 'S1', execution, file)!;
  assert.match(text, /^Device macOS at "\/Users\/me\/app", session S1\. Send a script/);
  assert.doesNotMatch(text, /\{\{/);

  writeFileSync(file, '   \n');
  assert.equal(templateDevicePrompt('/Users/me/app', 'S1', execution, file), undefined);
  assert.equal(templateDevicePrompt('/Users/me/app', 'S1', execution, join(dir, 'missing.md')), undefined);
  assert.equal(templateDevicePrompt('/Users/me/app', 'S1', execution, undefined), undefined);
  if (!process.env.CCDT_DEVICE_PROMPT)
    assert.match(remotePrompt('/Users/me/app', 'S1', execution), /NOT on this Linux host/);
});

test('permission default: only a valid mode is taken, and only `auto` follows it', () => {
  assert.equal(defaultPermissionMode(undefined), 'auto');
  assert.equal(defaultPermissionMode('nonsense'), 'auto');
  assert.equal(defaultPermissionMode('bypassPermissions'), 'bypassPermissions');
  assert.equal(effectivePermissionMode('auto', 'bypassPermissions'), 'bypassPermissions');
  assert.equal(effectivePermissionMode('plan', 'bypassPermissions'), 'plan');
  assert.equal(effectivePermissionMode('auto', 'auto'), 'auto');
});
