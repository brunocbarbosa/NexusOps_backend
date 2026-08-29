import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { AuthenticatedUser } from '../../src/auth/authenticated-user';
import { validateEnv } from '../../src/config/env.validation';
import { TicketStatus, UserRole } from '../../src/generated/prisma/enums';
import { PRISMA } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import {
  runWithTenant,
  runWithoutTenant,
} from '../../src/tenancy/tenant-context';
import { tenantScoped } from '../../src/tenancy/tenant-scoped';
import { TicketsModule } from '../../src/tickets/tickets.module';
import { TicketsService } from '../../src/tickets/tickets.service';

/**
 * Optimistic concurrency against a real PostgreSQL.
 *
 * The unit spec proves the service asks the right question; only a real
 * database can prove the answer, because what makes this work is row locking
 * under READ COMMITTED: the losing `UPDATE` blocks on the winner's lock, then
 * re-evaluates `version = 1` after the winner commits, matches nothing, and
 * reports a count of zero.
 *
 * This is the race MAIN.md describes — two agents grabbing the same ticket —
 * and it is the reason `Ticket.version` exists at all.
 */
describe('ticket optimistic concurrency', () => {
  let mod: TestingModule;
  let tickets: TicketsService;
  let prisma: ExtendedPrismaClient;

  const run = randomUUID().slice(0, 8);
  const domains: string[] = [];
  let tenantId: string;
  let agent: AuthenticatedUser;
  let requester: AuthenticatedUser;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        TicketsModule,
      ],
    }).compile();
    await mod.init();

    tickets = mod.get(TicketsService);
    prisma = mod.get<ExtendedPrismaClient>(PRISMA);

    const domain = `occ-${run}.example`;
    domains.push(domain);

    const tenant = await runWithoutTenant(() =>
      prisma.tenant.create({ data: { name: 'OCC', domain } }),
    );
    tenantId = tenant.id;

    await runWithTenant(tenantId, async () => {
      await prisma.ticketCounter.create({ data: tenantScoped({}) });

      // Sequential rather than Promise.all: `pg` warns when one client runs two
      // queries at once, and seeding has no reason to be the thing that trips it.
      const agentRow = await prisma.user.create({
        data: tenantScoped({
          email: 'agent.example',
          passwordHash: 'x',
          role: UserRole.AGENT,
        }),
      });
      const requesterRow = await prisma.user.create({
        data: tenantScoped({
          email: 'requester.example',
          passwordHash: 'x',
          role: UserRole.REQUESTER,
        }),
      });

      agent = {
        id: agentRow.id,
        tenantId,
        email: agentRow.email,
        role: UserRole.AGENT,
      };
      requester = {
        id: requesterRow.id,
        tenantId,
        email: requesterRow.email,
        role: UserRole.REQUESTER,
      };
    });
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await mod.close();
  });

  const open = (title: string) =>
    runWithTenant(tenantId, () => tickets.create({ title }, requester));

  it('lets exactly one of two writers at the same version through', async () => {
    const ticket = await open('contended');

    const results = await Promise.allSettled([
      runWithTenant(tenantId, () =>
        tickets.changeStatus(
          ticket.id,
          { version: ticket.version, status: TicketStatus.IN_PROGRESS },
          agent,
        ),
      ),
      runWithTenant(tenantId, () =>
        tickets.changeStatus(
          ticket.id,
          { version: ticket.version, status: TicketStatus.RESOLVED },
          agent,
        ),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);

    // The version moved once, not twice. If both writes had landed, this would
    // be 3 and one agent's change would have silently vanished.
    const after = await runWithTenant(tenantId, () =>
      tickets.findOne(ticket.id, agent),
    );
    expect(after.version).toBe(ticket.version + 1);
  });

  it('tells the loser the version to reload', async () => {
    const ticket = await open('stale');

    await runWithTenant(tenantId, () =>
      tickets.update(
        ticket.id,
        { version: ticket.version, title: 'moved on' },
        agent,
      ),
    );

    // A second writer still holding the version it read before the update.
    await expect(
      runWithTenant(tenantId, () =>
        tickets.update(
          ticket.id,
          { version: ticket.version, title: 'too late' },
          agent,
        ),
      ),
    ).rejects.toThrow(/version 2/);
  });

  it('rejects a stale writer without touching the row', async () => {
    const ticket = await open('untouched');

    await runWithTenant(tenantId, () =>
      tickets.update(
        ticket.id,
        { version: ticket.version, title: 'winner' },
        agent,
      ),
    );

    await expect(
      runWithTenant(tenantId, () =>
        tickets.update(
          ticket.id,
          { version: ticket.version, title: 'loser' },
          agent,
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const after = await runWithTenant(tenantId, () =>
      tickets.findOne(ticket.id, agent),
    );
    expect(after.title).toBe('winner');
  });
});
