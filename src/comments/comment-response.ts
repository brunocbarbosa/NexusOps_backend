import { Comment, User } from '../generated/prisma/client';
import { UserResponse, toUserResponse } from '../users/user-response';

export const COMMENT_AUTHOR = { author: true } as const;

export type CommentWithAuthor = Comment & { author: User };

/**
 * What a comment looks like on the way out.
 *
 * An allowlist, like every response type here. `ticketId` is deliberately in
 * it — a client fetching a thread already knows the ticket, but the timeline
 * screen merges comments with audit entries and needs to say which ticket a
 * row belongs to without tracking the request it came from.
 *
 * `isInternal` is on the wire on purpose, and only staff ever see a `true`: a
 * requester's page is filtered before it is built, so for them the field is
 * always `false`. Agents need it to render the note differently from a reply
 * the customer can read, and hiding the flag would leave them unable to tell.
 */
export type CommentResponse = {
  id: string;
  ticketId: string;
  body: string;
  isInternal: boolean;
  author: UserResponse;
  createdAt: Date;
};

export function toCommentResponse(comment: CommentWithAuthor): CommentResponse {
  return {
    id: comment.id,
    ticketId: comment.ticketId,
    body: comment.body,
    isInternal: comment.isInternal,
    author: toUserResponse(comment.author),
    createdAt: comment.createdAt,
  };
}
