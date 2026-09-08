import { Module } from '@nestjs/common';
import { DomainEventsModule } from '../tenancy/domain-events.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TicketsModule } from '../tickets/tickets.module';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  // TicketsModule for `requireTicket()`. Resolving the parent ticket by hand
  // here would be a second copy of the visibility rule, and two copies of an
  // access-control rule is one copy too many.
  imports: [PrismaModule, DomainEventsModule, TicketsModule],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
