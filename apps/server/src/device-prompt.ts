// The device part of the system prompt, from a template of the user's own when CCDT_DEVICE_PROMPT names one.
//
// Upstream tells Claude to do all project work over `ssh device-*` and never to use this host's tools. A setup
// that also gives Claude other ways to the device (workspace MCP servers, a reverse tunnel) can describe them in
// a template instead. Placeholders: {{device}} {{project}} {{script}} {{command}} {{session}}. An unset variable,
// a missing file or an empty one keeps the upstream prompt.
//
// The text goes into --append-system-prompt / systemPrompt.append, so editing the template changes the prompt of
// later turns and costs every open session one prompt-cache miss.
import { readFileSync } from 'node:fs';
import { deviceTerms } from './device-terms.ts';
import type { Execution } from './device-terms.ts';

export function templateDevicePrompt(
  projectPath: string,
  sessionId: string,
  execution: Execution,
  file = process.env.CCDT_DEVICE_PROMPT,
) {
  if (!file) return undefined;
  let template: string;
  try {
    template = readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (!template) return undefined;
  const terms = deviceTerms(execution, projectPath);
  const values: Record<string, string> = {
    device: terms.name,
    project: JSON.stringify(projectPath),
    script: terms.script,
    command: terms.command,
    session: sessionId,
  };
  return template.replace(
    /\{\{(device|project|script|command|session)\}\}/g,
    (_, key: string) => values[key],
  );
}
