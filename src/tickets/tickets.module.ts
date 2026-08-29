import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  // PrismaModule only. Assignee validation reads the users table directly
  // rather than going through UsersService, because the question here is
  // "may this row hold a ticket", not "show me this user" — and importing the
  // users module for one role check would couple two verticals for nothing.
  imports: [PrismaModule],
  controllers: [TicketsController],
  providers: [TicketsService],
  // Exported for CommentsModule: comments hang off a ticket and have to resolve
  // the parent through `requireTicket()`, so the visibility rule lives in one
  // place instead of two.
  exports: [TicketsService],
})
export class TicketsModule {}
