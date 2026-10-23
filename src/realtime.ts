// Pure helpers for Realtime payloads.  No client import, so unit tests can use them.

/** True for Realtime's "Subscribed to PostgreSQL" system message. */
export function isPostgresChangesReady(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'extension' in payload &&
    payload.extension === 'postgres_changes' &&
    'status' in payload &&
    payload.status === 'ok'
  );
}
