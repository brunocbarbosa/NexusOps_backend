import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TicketsModule } from '../tickets/tickets.module';
import { AuditController, TicketTimelineController } from './audit.controller';
import { AuditListener } from './audit.listener';
import { AuditService } from './audit.service';

@Module({
  // TicketsModule for `requireTicket()`: the timeline is only visible to
  // whoever can see the ticket, and that rule lives in one place.
  //
  // Nothing imports *this* module. That is the shape the Observer wants — the
  // domain services emit and never know a listener exists.
  imports: [PrismaModule, TicketsModule],
  controllers: [AuditController, TicketTimelineController],
  providers: [AuditService, AuditListener],
})
export class AuditModule {}
