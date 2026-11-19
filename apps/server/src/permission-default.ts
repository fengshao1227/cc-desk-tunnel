// The approval mode of new sessions, and of sessions still on upstream's default, when CCDT_DEFAULT_PERMISSION_MODE
// names one. Upstream starts every session in `auto` and never defaults to `bypassPermissions`; a single user who
// runs their own server may prefer otherwise. A mode chosen for a session by hand is always kept. Unset or invalid,
// nothing changes.
import { permissionModeSchema } from '@cc-desk-tunnel/protocol';
import type { PermissionMode } from '@cc-desk-tunnel/protocol';

export function defaultPermissionMode(value = process.env.CCDT_DEFAULT_PERMISSION_MODE): PermissionMode {
  const parsed = permissionModeSchema.safeParse(value);
  return parsed.success ? parsed.data : 'auto';
}

// `auto` is what every session created before the setting has, so it reads as "the default".
export function effectivePermissionMode(mode: PermissionMode, fallback = defaultPermissionMode()) {
  return mode === 'auto' ? fallback : mode;
}
