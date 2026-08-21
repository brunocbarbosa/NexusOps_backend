import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { ChangePasswordDto } from './dto/change-password.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponse } from './user-response';
import { PaginatedUsers, UsersService } from './users.service';

/**
 * Every route here is authenticated: `JwtAuthGuard` is global and nothing in
 * this file says `@Public()`. `@Roles()` narrows it further where the action
 * belongs to an administrator.
 *
 * `ParseUUIDPipe` on every id is not decoration. Without it a non-UUID reaches
 * PostgreSQL, which rejects the cast, and a mistyped URL becomes a 500 instead
 * of the 400 it is.
 */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Roles(UserRole.ADMIN)
  @Post()
  create(@Body() dto: CreateUserDto): Promise<UserResponse> {
    return this.users.create(dto);
  }

  @Roles(UserRole.ADMIN, UserRole.AGENT)
  @Get()
  findAll(
    @Query() query: QueryUsersDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<PaginatedUsers> {
    return this.users.findAll(query, requester);
  }

  /**
   * Declared before `:id` for readability rather than necessity — the paths
   * have different segment counts, so the router cannot confuse them. Keep it
   * here anyway: a future `PATCH /users/me` would be ambiguous, and by then the
   * ordering would be load-bearing.
   */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Patch('me/password')
  changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<void> {
    return this.users.changePassword(dto, requester);
  }

  // Any authenticated user, because a requester needs to see who an agent is.
  // Cross-tenant ids answer 404, which is the extension's doing, not a check
  // written here.
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<UserResponse> {
    return this.users.findOne(id, requester);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<UserResponse> {
    return this.users.update(id, dto, requester);
  }

  // Deactivates. The row survives, because audit_logs and tickets.assignee are
  // RESTRICT and a real delete would fail in the database.
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<void> {
    return this.users.remove(id, requester);
  }

  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post(':id/restore')
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<UserResponse> {
    return this.users.restore(id, requester);
  }
}
