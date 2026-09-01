import { AuditLog, User } from '../generated/prisma/client';
import { UserResponse, toUserResponse } from '../users/user-response';

export const AUDIT_ACTOR = { user: true } as const;

export type AuditLogWithUser = AuditLog & { user: User | null };

/**
 * One entry of the trail on the way out.
 *
 * `oldValues` and `newValues` are `JSONB` and deliberately typed as `unknown`
 * here: their shape depends on the action, and pretending otherwise would be a
 * type that lies. The contract for each action is documented in HELPDESK.md
 * rather than encoded, because the whole reason the column is JSONB is that it
 * outlives the shapes.
 *
 * `user` is null when the actor is gone — `audit_logs.user_id` is nullable so a
 * user deletion can anonymise the trail instead of being blocked by it.
 */
export type AuditResponse = {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  oldValues: unknown;
  newValues: unknown;
  user: UserResponse | null;
  createdAt: Date;
};

export function toAuditResponse(entry: AuditLogWithUser): AuditResponse {
  return {
    id: entry.id,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    oldValues: entry.oldValues,
    newValues: entry.newValues,
    user: entry.user === null ? null : toUserResponse(entry.user),
    createdAt: entry.createdAt,
  };
}
