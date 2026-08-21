import {
  TenantContextMissingError,
  runWithTenant,
  runWithoutTenant,
} from './tenant-context';
import { tenantScoped } from './tenant-scoped';

describe('tenantScoped', () => {
  it('adds the active tenant to the payload', async () => {
    const data = await runWithTenant('tenant-a', () =>
      tenantScoped({ email: 'a@example.com' }),
    );

    expect(data).toEqual({ email: 'a@example.com', tenantId: 'tenant-a' });
  });

  it('does not mutate the object it was given', async () => {
    const original = { email: 'a@example.com' };

    await runWithTenant('tenant-a', () => tenantScoped(original));

    expect(original).toEqual({ email: 'a@example.com' });
  });

  // The property that makes it safe to use without thinking: it cannot produce
  // a payload with an undefined tenant.
  it('throws rather than producing an unscoped payload', () => {
    expect(() => tenantScoped({ email: 'a@example.com' })).toThrow(
      TenantContextMissingError,
    );
  });

  // runWithoutTenant unlocks the tenant-agnostic models; it does not mean "any
  // tenant", so a scoped write under it is still a bug.
  it('throws under runWithoutTenant too', async () => {
    await expect(
      runWithoutTenant(() => tenantScoped({ email: 'a@example.com' })),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
  });
});
