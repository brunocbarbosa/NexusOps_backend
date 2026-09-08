import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import type { AuthenticatedUser } from '../../src/auth/authenticated-user';
import { validateEnv } from '../../src/config/env.validation';
import { UserRole } from '../../src/generated/prisma/enums';
import { PRISMA } from '../../src/prisma/prisma.client';
import type { ExtendedPrismaClient } from '../../src/prisma/prisma.client';
import {
  runWithTenant,
  runWithoutTenant,
  useScope,
} from '../utils/tenant-scope';
import { TenantScopeService } from '../../src/tenancy/tenant-scope.service';
import { tenantScoped } from '../../src/tenancy/tenant-scoped';
import { TicketsModule } from '../../src/tickets/tickets.module';
import { TicketsService } from '../../src/tickets/tickets.service';

/**
 * Two isolations, stacked, with two companies side by side.
 *
 * The outer one — another company's ticket is not found — is written nowhere in
 * `TicketsService`. It comes entirely from the tenancy extension, which is the
 * claim worth a real database behind it.
 *
 * The inner one — another requester's ticket is not found either — *is* written
 * in the service, in one place, and it answers with the same 404. That
 * sameness is the point: a client cannot tell the two apart, so neither can
 * confirm that an id exists somewhere it should not.
 */
describe('TicketsService across tenants and requesters', () => {
  let mod: TestingModule;
  let tickets: TicketsService;
  let prisma: ExtendedPrismaClient;

  const run = randomUUID().slice(0, 8);
  const domains: string[] = [];

  let tenantA: string;
  let tenantB: string;
  let requesterA1: AuthenticatedUser;
  let requesterA2: AuthenticatedUser;
  let agentA: AuthenticatedUser;
  let adminA: AuthenticatedUser;
  let requesterB: AuthenticatedUser;

  const asUser = (
    row: { id: string; email: string },
    tenantId: string,
    role: UserRole,
  ): AuthenticatedUser => ({ id: row.id, tenantId, email: row.email, role });

  const seed = async (label: string) => {
    const domain = `tickets-${label}-${run}.example`;
    domains.push(domain);

    const tenant = await runWithoutTenant(() =>
      prisma.tenant.create({ data: { name: `Tickets ${label}`, domain } }),
    );

    return runWithTenant(tenant.id, async () => {
      await prisma.ticketCounter.create({ data: tenantScoped({}) });

      const make = (email: string, role: UserRole) =>
        prisma.user.create({
          data: tenantScoped({ email, passwordHash: 'x', role }),
        });

      const one = await make(`one@${label}.example`, UserRole.REQUESTER);
      const two = await make(`two@${label}.example`, UserRole.REQUESTER);
      const staff = await make(`agent@${label}.example`, UserRole.AGENT);
      const boss = await make(`admin@${label}.example`, UserRole.ADMIN);

      return { tenantId: tenant.id, one, two, staff, boss };
    });
  };

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        // TicketsService injects EventEmitter2, which only exists once
        // forRoot() has run. Without this the module fails to resolve, which
        // is the honest signal that emitting is now part of what a ticket
        // mutation does.
        EventEmitterModule.forRoot({ wildcard: true }),
        TicketsModule,
      ],
    }).compile();
    useScope(mod.get(TenantScopeService));
    await mod.init();

    tickets = mod.get(TicketsService);
    prisma = mod.get<ExtendedPrismaClient>(PRISMA);

    const a = await seed('a');
    const b = await seed('b');

    tenantA = a.tenantId;
    tenantB = b.tenantId;
    requesterA1 = asUser(a.one, tenantA, UserRole.REQUESTER);
    requesterA2 = asUser(a.two, tenantA, UserRole.REQUESTER);
    agentA = asUser(a.staff, tenantA, UserRole.AGENT);
    adminA = asUser(a.boss, tenantA, UserRole.ADMIN);
    requesterB = asUser(b.one, tenantB, UserRole.REQUESTER);
  });

  afterAll(async () => {
    await runWithoutTenant(() =>
      prisma.tenant.deleteMany({ where: { domain: { in: domains } } }),
    );
    await mod.close();
  });

  it('starts each company at number 1', async () => {
    const first = await runWithTenant(tenantA, () =>
      tickets.create({ title: 'A first' }, requesterA1),
    );
    const other = await runWithTenant(tenantB, () =>
      tickets.create({ title: 'B first' }, requesterB),
    );

    expect(first.number).toBe(1);
    expect(other.number).toBe(1);
  });

  it('does not show one company a ticket of another', async () => {
    const owned = await runWithTenant(tenantA, () =>
      tickets.create({ title: 'A private' }, requesterA1),
    );

    await expect(
      runWithTenant(tenantB, () => tickets.findOne(owned.id, requesterB)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('shows a ticket to its requester and the company admin, and to nobody else', async () => {
    const owned = await runWithTenant(tenantA, () =>
      tickets.create({ title: 'A1 only' }, requesterA1),
    );

    // Same company, same database rows, different answer — and the same 404 a
    // stranger from another company gets.
    await expect(
      runWithTenant(tenantA, () => tickets.findOne(owned.id, requesterA2)),
    ).rejects.toBeInstanceOf(NotFoundException);

    // The agent gets that same 404 now: being staff is no longer the question,
    // being the assignee is.
    await expect(
      runWithTenant(tenantA, () => tickets.findOne(owned.id, agentA)),
    ).rejects.toBeInstanceOf(NotFoundException);

    const asAdmin = await runWithTenant(tenantA, () =>
      tickets.findOne(owned.id, adminA),
    );
    expect(asAdmin.id).toBe(owned.id);
  });

  // The rule in one test: assignment is what grants and revokes sight of a
  // ticket, and it does both.
  it('shows an agent a ticket the moment it is assigned, and hides it again when it is not', async () => {
    const ticket = await runWithTenant(tenantA, () =>
      tickets.create({ title: 'to be worked' }, requesterA1),
    );

    await expect(
      runWithTenant(tenantA, () => tickets.findOne(ticket.id, agentA)),
    ).rejects.toBeInstanceOf(NotFoundException);

    const assigned = await runWithTenant(tenantA, () =>
      tickets.assign(
        ticket.id,
        { version: ticket.version, assigneeId: agentA.id },
        adminA,
      ),
    );

    const seen = await runWithTenant(tenantA, () =>
      tickets.findOne(ticket.id, agentA),
    );
    expect(seen.id).toBe(ticket.id);

    await runWithTenant(tenantA, () =>
      tickets.assign(
        ticket.id,
        { version: assigned.version, assigneeId: null },
        adminA,
      ),
    );

    await expect(
      runWithTenant(tenantA, () => tickets.findOne(ticket.id, agentA)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // Agents cannot open tickets any more, but rows they opened under the old
  // rule exist in every database that predates this change. The scope keeps
  // both arms so that their own authors do not lose them.
  it('keeps a ticket visible to the agent who opened it', async () => {
    const own = await runWithTenant(tenantA, () =>
      tickets.create({ title: 'opened by the agent' }, agentA),
    );

    const seen = await runWithTenant(tenantA, () =>
      tickets.findOne(own.id, agentA),
    );
    expect(seen.id).toBe(own.id);
  });

  it('lists only the caller own tickets for a requester', async () => {
    const mine = await runWithTenant(tenantA, () =>
      tickets.findAll({ page: 1, perPage: 100 }, requesterA1),
    );
    const theirs = await runWithTenant(tenantA, () =>
      tickets.findAll({ page: 1, perPage: 100 }, requesterA2),
    );
    const all = await runWithTenant(tenantA, () =>
      tickets.findAll({ page: 1, perPage: 100 }, adminA),
    );

    expect(mine.meta.total).toBeGreaterThan(0);
    expect(theirs.meta.total).toBe(0);
    // The admin is the only company-wide view left, so it is the one that can
    // see more than the author of a ticket does.
    expect(all.meta.total).toBeGreaterThanOrEqual(mine.meta.total);
    // The total is filtered too, not just the page: a count that included
    // invisible rows would announce that they exist.
    expect(mine.data.every((t) => t.requester.id === requesterA1.id)).toBe(
      true,
    );
  });

  it('refuses to assign a ticket to a user of another company', async () => {
    const owned = await runWithTenant(tenantA, () =>
      tickets.create({ title: 'cross assign' }, requesterA1),
    );

    // requesterB is a real user with a real id — just not one this tenant can
    // see. The lookup carries no tenant filter of its own; the extension makes
    // it not-found.
    await expect(
      runWithTenant(tenantA, () =>
        tickets.assign(
          owned.id,
          { version: owned.version, assigneeId: requesterB.id },
          adminA,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
