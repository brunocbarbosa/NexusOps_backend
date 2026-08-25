import { ConfigModule } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Test, TestingModule } from '@nestjs/testing';
import { HashingService } from '../../src/auth/hashing.service';
import { validateEnv } from '../../src/config/env.validation';
import { PrismaClient } from '../../src/generated/prisma/client';
import { UserRole } from '../../src/generated/prisma/enums';
import { PlatformBootstrapService } from '../../src/platform/platform-bootstrap.service';
import { PLATFORM_TENANT_DOMAIN } from '../../src/platform/platform.constants';
import { PlatformModule } from '../../src/platform/platform.module';

/**
 * The bootstrap against a real database.
 *
 * Everything is read back with an **unextended** client, on purpose: a fixture
 * built and verified by the thing under test proves nothing about it. That also
 * means these assertions see the rows exactly as PostgreSQL holds them, without
 * the tenant filter the extension would inject.
 */
describe('the platform bootstrap', () => {
  let mod: TestingModule;
  let bootstrap: PlatformBootstrapService;
  let hashing: HashingService;
  let raw: PrismaClient;

  const operators = () =>
    raw.user.findMany({ where: { role: UserRole.ADMIN_MASTER } });

  beforeAll(async () => {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL,
    });
    raw = new PrismaClient({ adapter });

    mod = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        PlatformModule,
      ],
    }).compile();
    // init() is the first boot: PlatformBootstrapService.onModuleInit runs here.
    await mod.init();

    bootstrap = mod.get(PlatformBootstrapService);
    hashing = mod.get(HashingService);
  });

  afterAll(async () => {
    await raw.$disconnect();
    await mod.close();
  });

  it('leaves exactly one operator in exactly one platform tenant', async () => {
    const [tenants, found] = await Promise.all([
      raw.tenant.findMany({ where: { isPlatform: true } }),
      operators(),
    ]);

    expect(tenants).toHaveLength(1);
    expect(tenants[0].domain).toBe(PLATFORM_TENANT_DOMAIN);
    expect(found).toHaveLength(1);
    expect(found[0].tenantId).toBe(tenants[0].id);
  });

  // It runs on every boot, including every e2e suite's createTestApp(). It has
  // to converge, not accumulate.
  it('converges rather than accumulates when run again', async () => {
    await bootstrap.ensureAdminMaster();
    await bootstrap.ensureAdminMaster();

    expect(await operators()).toHaveLength(1);
    expect(
      await raw.tenant.findMany({ where: { isPlatform: true } }),
    ).toHaveLength(1);
  });

  it('does not rewrite the hash when nothing in the environment changed', async () => {
    const before = (await operators())[0];

    await bootstrap.ensureAdminMaster();

    const after = (await operators())[0];
    // bcrypt salts randomly, so an unconditional re-hash would change this every
    // time and make "nothing changed" indistinguishable from "rotated".
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it('restores the operator and its password from the environment', async () => {
    const before = (await operators())[0];

    // Whatever might have happened to the row between boots: the password no
    // longer matches the environment, and the account was deactivated.
    await raw.user.update({
      where: { id: before.id },
      data: { passwordHash: await hashing.hash('some-other-password') },
    });
    await raw.user.update({
      where: { id: before.id },
      data: { deletedAt: new Date() },
    });

    await bootstrap.ensureAdminMaster();

    const after = (await operators())[0];
    expect(after.id).toBe(before.id);
    expect(after.deletedAt).toBeNull();
    await expect(
      hashing.compare(process.env.ADMIN_MASTER_PASSWORD!, after.passwordHash),
    ).resolves.toBe(true);
  });

  /**
   * The second layer, and the one that holds when the first is bypassed. These
   * writes go through the unextended client, so nothing in application code is
   * standing in the way — only the database is.
   */
  describe('what the database refuses outright', () => {
    it('refuses a second ADMIN_MASTER', async () => {
      const existing = (await operators())[0];

      await expect(
        raw.user.create({
          data: {
            tenantId: existing.tenantId,
            email: 'second-operator@nexusops.test',
            passwordHash: 'x',
            role: UserRole.ADMIN_MASTER,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('refuses a second platform tenant', async () => {
      await expect(
        raw.tenant.create({
          data: {
            name: 'Impostor Platform',
            domain: 'impostor-platform.example',
            isPlatform: true,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    // The same nullable-unique column that limits the platform tenant to one
    // must not limit the companies to one. NULLs are distinct in a PostgreSQL
    // unique index, which is the whole reason the column is `Boolean?`.
    it('still allows any number of companies alongside it', async () => {
      const names = ['co-a', 'co-b'].map((n) => `${n}-${Date.now()}.example`);

      for (const domain of names) {
        await raw.tenant.create({ data: { name: domain, domain } });
      }

      const created = await raw.tenant.findMany({
        where: { domain: { in: names } },
      });
      expect(created).toHaveLength(2);
      expect(created.every((t) => t.isPlatform === null)).toBe(true);

      await raw.tenant.deleteMany({ where: { domain: { in: names } } });
    });
  });
});
