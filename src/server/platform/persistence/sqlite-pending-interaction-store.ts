import type { DatabaseSync } from 'node:sqlite';

import type { PendingInteraction } from '../../features/sessions/model/relay-session.js';

export class SqlitePendingInteractionStore {
  constructor(private readonly db: DatabaseSync) {}
  add(sessionId: string, interaction: PendingInteraction): void {
    this.db
      .prepare(
        'INSERT INTO pending_interactions (session_id,request_id,kind,payload_json) VALUES (?,?,?,?)',
      )
      .run(sessionId, interaction.requestId, interaction.kind, JSON.stringify(interaction.payload));
  }
  resolve(sessionId: string, requestId: string, resolvedAt: string): boolean {
    return (
      this.db
        .prepare(
          'UPDATE pending_interactions SET resolved_at = ? WHERE session_id = ? AND request_id = ? AND resolved_at IS NULL',
        )
        .run(resolvedAt, sessionId, requestId).changes === 1
    );
  }
}
