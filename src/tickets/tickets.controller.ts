import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../generated/prisma/enums';
import { AssignTicketDto } from './dto/assign-ticket.dto';
import { ChangeStatusDto } from './dto/change-status.dto';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { QueryTicketsDto } from './dto/query-tickets.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketResponse } from './ticket-response';
import { PaginatedTickets, TicketsService } from './tickets.service';

/**
 * There is no `DELETE`, and that is a decision rather than an omission.
 *
 * A ticket is the subject of an audit trail, and deleting it would delete what
 * the trail is about. `CLOSED` is the terminal state and takes the role a
 * delete would otherwise play.
 *
 * `@Roles` is per-handler rather than on the class because the split is the
 * point of this controller, and it now runs three ways. Reading and editing are
 * open to anyone authenticated, narrowed per caller by the service's visibility
 * rule rather than by a guard — a guard sees the route, not the rows. Opening
 * belongs to the ADMIN and the REQUESTER. Status belongs to the ADMIN and the
 * AGENT, and assignment to the ADMIN alone.
 */
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  // Not "any authenticated user" any more. The role that *works* a ticket is
  // not the role that *opens* it: an AGENT answering a phone call opens
  // nothing — the person with the problem does, or an ADMIN does. Leaving this
  // open to an AGENT would also hand it a way around the visibility rule,
  // because the author of a ticket sees it.
  //
  // ADMIN_MASTER is absent on purpose, and the 403 is an improvement on what
  // it used to get: the reserved platform tenant has no ticket_counters row,
  // so this route answered the operator with a 500.
  @Roles(UserRole.ADMIN, UserRole.REQUESTER)
  @Post()
  create(
    @Body() dto: CreateTicketDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<TicketResponse> {
    return this.tickets.create(dto, requester);
  }

  // No @Roles: a REQUESTER gets their own tickets and staff get all of them,
  // decided in the service. A guard could not express that — it sees the route,
  // not the rows.
  @Get()
  findAll(
    @Query() query: QueryTicketsDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<PaginatedTickets> {
    return this.tickets.findAll(query, requester);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<TicketResponse> {
    return this.tickets.findOne(id, requester);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<TicketResponse> {
    return this.tickets.update(id, dto, requester);
  }

  // Staff only: moving a ticket through its lifecycle is the work, and the
  // person who opened it does not get to declare it resolved. Unchanged by the
  // visibility rule, and it does not need to change — the guard answers "may
  // this role, ever" and `load()` answers "on which rows", so an agent moves
  // the tickets assigned to it and 404s on the rest.
  @Roles(UserRole.ADMIN, UserRole.AGENT)
  @Patch(':id/status')
  changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeStatusDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<TicketResponse> {
    return this.tickets.changeStatus(id, dto, requester);
  }

  // ADMIN alone, and this is a grant of access rather than a step in a
  // workflow: assignment is now the thing that decides who can *see* a ticket.
  // An agent assigning one to itself would be an agent granting itself
  // visibility, and an agent unassigning itself would be one erasing a ticket
  // from the only queue that shows it. Neither was ever reachable anyway —
  // `load()` 404s an unassigned ticket before `mutate()` gets to the write —
  // so the guard states out loud what the scope already enforced.
  @Roles(UserRole.ADMIN)
  @Patch(':id/assignee')
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignTicketDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<TicketResponse> {
    return this.tickets.assign(id, dto, requester);
  }
}
