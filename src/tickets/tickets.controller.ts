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
 * point of this controller: opening, reading and editing a ticket are open to
 * anyone authenticated — narrowed per caller by the service's visibility rule,
 * not by a guard — while status and assignment belong to staff.
 */
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  // Any authenticated user opens a ticket; that is the whole point of a
  // helpdesk. The requester is the caller, taken from the token.
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
  // person who opened it does not get to declare it resolved.
  @Roles(UserRole.ADMIN, UserRole.AGENT)
  @Patch(':id/status')
  changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeStatusDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<TicketResponse> {
    return this.tickets.changeStatus(id, dto, requester);
  }

  @Roles(UserRole.ADMIN, UserRole.AGENT)
  @Patch(':id/assignee')
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignTicketDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<TicketResponse> {
    return this.tickets.assign(id, dto, requester);
  }
}
