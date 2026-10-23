// Shared app types.  Realtime message payloads will be added here in later
// milestones, along with runtime guards that check them at the boundary.

export const DISPLAY_NAME_MAX = 24;

export interface Player {
  id: string;
  displayName: string;
}

/** Trims a display name and returns it, or an error message if it's invalid. */
export function validateDisplayName(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: 'Pick a name.' };
  if (value.length > DISPLAY_NAME_MAX) {
    return { ok: false, error: `Keep it to ${DISPLAY_NAME_MAX} characters or fewer.` };
  }
  return { ok: true, value };
}
