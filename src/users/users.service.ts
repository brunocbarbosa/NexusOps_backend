import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { HashingService } from '../auth/hashing.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { Prisma, User } from '../generated/prisma/client';
import { UserRole } from '../generated/prisma/enums';
import { PRISMA } from '../prisma/prisma.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.client';
import { tenantScoped } from '../tenancy/tenant-scoped';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponse, toUserResponse } from './user-response';

export type PaginatedUsers = {
  data: UserResponse[];
  meta: { total: number; page: number; perPage: number; totalPages: number };
};

/**
 * Two rules hold everywhere in this file, and both are worth stating because
 * neither is enforced by a compiler.
 *
 * **No query here writes a tenant filter.** The extension injects it into every
 * `where` and stamps it into every `data`. A hand-written one is a filter that
 * can be wrong, and worse, one that a reader has to check.
 *
 * **`deletedAt: null` is written by hand, on purpose.** Putting it in the
 * extension alongside the tenant filter would look symmetrical and would be a
 * mistake: the extension is about tenancy, and teaching it to hide rows would
 * make every future model silently lose records that nobody asked it to hide.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly hashing: HashingService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async create(dto: CreateUserDto): Promise<UserResponse> {
    const passwordHash = await this.hashing.hash(dto.password);

    try {
      const user = await this.prisma.user.create({
        data: tenantScoped({
          email: dto.email,
          passwordHash,
          role: dto.role ?? UserRole.REQUESTER,
        }),
      });
      return toUserResponse(user);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // A deactivated user still occupies @@unique([tenantId, email]) —
      // measured, P2002 on (tenant_id, email) — so "this address is taken" and
      // "this person was deactivated" are the same database error and a
      // different problem for the caller. Telling them apart is the whole
      // reason POST /users/:id/restore exists.
      const existing = await this.prisma.user.findFirst({
        where: { email: dto.email },
      });

      throw new ConflictException(
        existing?.deletedAt
          ? `${dto.email} belongs to a deactivated user (${existing.id}). Restore them instead of creating a duplicate.`
          : `${dto.email} is already in use`,
      );
    }
  }

  async findAll(
    query: QueryUsersDto,
    requester: AuthenticatedUser,
  ): Promise<PaginatedUsers> {
    if (query.includeDeleted && requester.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only an ADMIN may list deactivated users');
    }

    const where: Prisma.UserWhereInput = {
      ...(query.includeDeleted ? {} : { deletedAt: null }),
      ...(query.role ? { role: query.role } : {}),
      ...(query.search
        ? { email: { contains: query.search, mode: 'insensitive' } }
        : {}),
    };

    // One round trip for both halves. Two awaits would let a concurrent write
    // land between them and return a total that does not match the page.
    const [total, users] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
    ]);

    return {
      data: users.map(toUserResponse),
      meta: {
        total,
        page: query.page,
        perPage: query.perPage,
        totalPages: Math.ceil(total / query.perPage) || 1,
      },
    };
  }

  async findOne(
    id: string,
    requester: AuthenticatedUser,
  ): Promise<UserResponse> {
    return toUserResponse(await this.load(id, requester));
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    requester: AuthenticatedUser,
  ): Promise<UserResponse> {
    const current = await this.load(id, requester);

    if (dto.role && dto.role !== UserRole.ADMIN) {
      await this.assertNotLastAdmin(current, 'demoted');
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id: current.id },
        data: { email: dto.email, role: dto.role },
      });
      return toUserResponse(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`${dto.email} is already in use`);
      }
      throw error;
    }
  }

  /**
   * Deactivates a user.
   *
   * Soft, because the RESTRICT foreign keys on `audit_logs` and
   * `tickets.assignee` make a real delete fail in the database — see the
   * comment on `User` in prisma/schema.prisma.
   */
  async remove(id: string, requester: AuthenticatedUser): Promise<void> {
    const target = await this.load(id, requester);

    // Both are 409 rather than 400: the request is well-formed, and it is the
    // current state of the system that refuses it.
    if (target.id === requester.id) {
      throw new ConflictException(
        'You cannot deactivate yourself. Ask another ADMIN to do it.',
      );
    }
    if (target.deletedAt !== null) {
      throw new ConflictException('This user is already deactivated');
    }
    await this.assertNotLastAdmin(target, 'deactivated');

    await this.prisma.user.update({
      where: { id: target.id },
      data: { deletedAt: new Date() },
    });

    // JwtStrategy and the refresh path both re-check `deletedAt`, so this is
    // not what stops the sessions — it is what makes "this user has no live
    // sessions" true in the data rather than only enforced on the way in.
    await this.refreshTokens.revokeAllFor(target.id);
  }

  /**
   * Reactivates a user.
   *
   * Cannot collide on the e-mail: the address stayed occupied for the whole
   * time the user was deactivated, so nobody could have taken it.
   */
  async restore(
    id: string,
    requester: AuthenticatedUser,
  ): Promise<UserResponse> {
    const target = await this.load(id, requester);

    if (target.deletedAt === null) {
      throw new ConflictException('This user is not deactivated');
    }

    const restored = await this.prisma.user.update({
      where: { id: target.id },
      data: { deletedAt: null },
    });
    return toUserResponse(restored);
  }

  async changePassword(
    dto: ChangePasswordDto,
    requester: AuthenticatedUser,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: requester.id },
    });

    if (!user || user.deletedAt !== null) {
      throw new UnauthorizedException();
    }

    if (!(await this.hashing.compare(dto.currentPassword, user.passwordHash))) {
      // Not a 400: the request is valid, the credential is not.
      throw new UnauthorizedException('The current password is incorrect');
    }

    if (await this.hashing.compare(dto.newPassword, user.passwordHash)) {
      throw new ConflictException(
        'The new password must differ from the current one',
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.hashing.hash(dto.newPassword) },
    });

    // The reason a password change is worth anything after a leak: every other
    // session ends with it. Without this, a stolen refresh token survives the
    // change that was made because of it.
    await this.refreshTokens.revokeAllFor(user.id);
  }

  /**
   * Loads a user of the caller's tenant, or 404s.
   *
   * The tenant filter comes from the extension, so another tenant's id is
   * simply not found — which is why this answers 404 and never 403. A 403 would
   * confirm that the id exists somewhere, which is a fact about another
   * company's data.
   */
  private async load(id: string, requester: AuthenticatedUser): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });

    // A deactivated user is visible to an ADMIN, who needs to see them in order
    // to restore them, and invisible to everyone else — the same answer
    // `GET /users` gives without `includeDeleted`.
    if (
      !user ||
      (user.deletedAt !== null && requester.role !== UserRole.ADMIN)
    ) {
      throw new NotFoundException(`No user ${id}`);
    }

    return user;
  }

  /**
   * A tenant with no active ADMIN is a tenant nobody can administer, and there
   * is no route back: creating users, restoring them and changing roles all
   * require one.
   */
  private async assertNotLastAdmin(target: User, verb: string): Promise<void> {
    if (target.role !== UserRole.ADMIN || target.deletedAt !== null) {
      return;
    }

    const admins = await this.prisma.user.count({
      where: { role: UserRole.ADMIN, deletedAt: null },
    });

    if (admins <= 1) {
      throw new ConflictException(
        `The last active ADMIN cannot be ${verb}. Promote another user first.`,
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
