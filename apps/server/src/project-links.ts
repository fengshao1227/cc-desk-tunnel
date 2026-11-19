// Shares a project's working directory with plain Claude Code sessions on this host.
//
// Upstream gives each (device, project folder) pair its own directory under <data>/native/<uuid>, so GUI and
// ccdt sessions live in a Claude Code project slot of their own. With CCDT_PROJECT_MAP set, a pair whose device
// folder is listed there gets that directory as a symlink to the listed server directory instead, and its
// sessions share the slot (session list, project memory, project CLAUDE.md) with `claude` started there.
//
// Claude Code resolves its working directory to the real path, so a session started through the link is stored
// under the server directory, and the Agent SDK's getSessionInfo finds it through either path.
//
// The map uses the format of claudemax's projects.conf: one `device_folder|server_folder[|...]` per line, `#`
// comments, the longest device folder that contains the project wins, and a subfolder maps to the same subfolder.
// Only a directory being created is linked: one that exists may already hold native history under its own path.
// Anything unexpected leaves the upstream behaviour, a plain directory, in place.
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';

export function mappedServerFolder(map: string, devicePath: string) {
  let bestDevice = '';
  let bestServer = '';
  for (const raw of map.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const [device, server] = line.split('|');
    if (!device || !server || !isAbsolute(server)) continue;
    const inside = devicePath === device || devicePath.startsWith(device.replace(/\/$/, '') + '/');
    if (inside && device.length > bestDevice.length) {
      bestDevice = device.replace(/\/$/, '');
      bestServer = server.replace(/\/$/, '');
    }
  }
  if (!bestDevice) return undefined;
  const target = normalize(bestServer + devicePath.slice(bestDevice.length));
  return target === bestServer || target.startsWith(bestServer + '/') ? target : undefined;
}

export function linkProjectRoot(
  dataDir: string,
  root: string,
  devicePath: string | undefined,
  mapFile = process.env.CCDT_PROJECT_MAP,
) {
  if (!mapFile || !devicePath || !devicePath.startsWith('/')) return; // off, no project, or a Windows folder
  try {
    const target = mappedServerFolder(readFileSync(mapFile, 'utf8'), devicePath);
    if (!target) return;
    const link = join(dataDir, 'native', root);
    try {
      lstatSync(link);
      return; // never replace an existing directory or link
    } catch {}
    if (!existsSync(target)) mkdirSync(target, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
    symlinkSync(target, link);
    console.log(`Project ${devicePath} shares ${target} (root ${root})`);
  } catch (error) {
    console.error(`Project link for ${root} skipped: ${(error as Error).message}`);
  }
}
