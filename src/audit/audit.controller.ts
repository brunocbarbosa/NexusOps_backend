import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../generated/prisma/enums';
import { AuditService, PaginatedAudit } from './audit.service';
import { QueryAuditDto } from './dto/query-audit.dto';

/**
 * The company-wide feed. `ADMIN` only: it spans every ticket, so the ticket
 * visibility rule cannot narrow it and a role check is the only thing that can.
 */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Roles(UserRole.ADMIN)
  @Get()
  findAll(@Query() query: QueryAuditDto): Promise<PaginatedAudit> {
    return this.audit.findAll(query);
  }
}

/**
 * One ticket's history, open to anyone who can see the ticket — which is what
 * the service checks first, so no `@Roles()` here.
 */
@Controller('tickets/:ticketId/timeline')
export class TicketTimelineController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  timeline(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Query() query: QueryAuditDto,
    @CurrentUser() reader: AuthenticatedUser,
  ): Promise<PaginatedAudit> {
    return this.audit.timeline(ticketId, query, reader);
  }
}
