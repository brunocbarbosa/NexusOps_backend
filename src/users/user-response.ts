import { User } from '../generated/prisma/client';

/**
 * What a user looks like on the way out.
 *
 * Built by listing the fields to keep, never by deleting the ones to drop. The
 * difference matters the day a column is added: an allowlist leaves it out of
 * the response until somebody decides otherwise, while a denylist ships it.
 */
export type UserResponse = {
  id: string;
  email: string;
  role: User['role'];
  createdAt: Date;
  deletedAt: Date | null;
};

export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    deletedAt: user.deletedAt,
  };
}
