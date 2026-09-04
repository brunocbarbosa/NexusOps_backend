import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CommentResponse } from './comment-response';
import { CommentsService, PaginatedComments } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { QueryCommentsDto } from './dto/query-comments.dto';

/**
 * Mounted under the ticket, because a comment has no life without one.
 *
 * No `@Roles()` anywhere in this file, and that is deliberate rather than an
 * omission: who may read a thread is decided by whether they can see the
 * ticket, and who may leave an internal note is decided by the payload plus the
 * role. A guard sees the route, not the row, so neither question is one it can
 * answer.
 *
 * There is no `PATCH` and no `DELETE`. Comments are append-only.
 */
@Controller('tickets/:ticketId/comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Post()
  create(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() author: AuthenticatedUser,
  ): Promise<CommentResponse> {
    return this.comments.create(ticketId, dto, author);
  }

  @Get()
  findAll(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Query() query: QueryCommentsDto,
    @CurrentUser() reader: AuthenticatedUser,
  ): Promise<PaginatedComments> {
    return this.comments.findAll(ticketId, query, reader);
  }
}
