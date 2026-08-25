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
import { runWithTenant } from '../tenancy/tenant-context';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { QueryUsersDto } from '../users/dto/query-users.dto';
import { UpdateUserDto } from '../users/dto/update-user.dto';
import { UserResponse } from '../users/user-response';
import { PaginatedUsers, UsersService } from '../users/users.service';
import { CompaniesService } from './companies.service';

/**
 * The ADMIN_MASTER managing the users of one company.
 *
 * Deliberately a shell with no logic of its own. Every route does the same two
 * things — resolve the company, then run the *existing* `UsersService` inside
 * `runWithTenant(companyId)` — and that is the whole design: the tenant filter
 * comes from the extension reading an explicitly opened scope, exactly the shape
 * `documents/important/TENANCY_EXTENSION.md` prescribes for a BullMQ worker.
 *
 * A second implementation of this CRUD would be a second place for the rules to
 * drift: the last-ADMIN guard, the deactivated-email conflict, the 404-not-403
 * answer. There is one, and this reaches it.
 *
 * The requester passed down is the real ADMIN_MASTER, not a synthetic ADMIN.
 * `UsersService` asks `administersUsers(requester.role)` where it used to ask
 * for ADMIN, so nothing has to be pretended.
 */
@Roles(UserRole.ADMIN_MASTER)
@Controller('platform/companies/:companyId/users')
export class CompanyUsersController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly users: UsersService,
  ) {}

  /**
   * Resolves the company, or 404s — for a nonexistent id and for the platform
   * tenant alike. Every route below starts here, because `runWithTenant()`
   * accepts any string and an unchecked id would silently scope to nothing.
   */
  private async inCompany<T>(
    companyId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const company = await this.companies.requireCompany(companyId);
    return runWithTenant(company.id, fn);
  }

  @Post()
  create(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: CreateUserDto,
  ): Promise<UserResponse> {
    return this.inCompany(companyId, () => this.users.create(dto));
  }

  @Get()
  findAll(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query() query: QueryUsersDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<PaginatedUsers> {
    return this.inCompany(companyId, () =>
      this.users.findAll(query, requester),
    );
  }

  @Get(':userId')
  findOne(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<UserResponse> {
    return this.inCompany(companyId, () =>
      this.users.findOne(userId, requester),
    );
  }

  @Patch(':userId')
  update(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<UserResponse> {
    return this.inCompany(companyId, () =>
      this.users.update(userId, dto, requester),
    );
  }

  /** Deactivates. Soft, like `DELETE /users/:id` — it is the same method. */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':userId')
  remove(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<void> {
    return this.inCompany(companyId, () =>
      this.users.remove(userId, requester),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post(':userId/restore')
  restore(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() requester: AuthenticatedUser,
  ): Promise<UserResponse> {
    return this.inCompany(companyId, () =>
      this.users.restore(userId, requester),
    );
  }
}
