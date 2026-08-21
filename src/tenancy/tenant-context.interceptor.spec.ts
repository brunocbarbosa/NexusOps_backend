import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Observable, defer, firstValueFrom, of, throwError } from 'rxjs';
import {
  TenantContextMissingError,
  currentScope,
  requireTenantId,
} from './tenant-context';
import { TenantContextInterceptor } from './tenant-context.interceptor';

describe('TenantContextInterceptor', () => {
  const interceptor = new TenantContextInterceptor();

  const httpContext = (user?: unknown): ExecutionContext =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  /**
   * The handler reads the tenant at **subscription** time, not when `handle()`
   * is called. That distinction is the whole point of the test: an
   * implementation that returns the Observable from inside `runWithTenant`
   * still calls `handle()` inside the scope, and only the subscription escapes
   * it. `of(requireTenantId())` would pass against that bug; `defer` fails.
   */
  const handlerReadingTenant = (): CallHandler => ({
    handle: () => defer(() => Promise.resolve(requireTenantId())),
  });

  it('runs the handler inside the tenant scope', async () => {
    const result = await firstValueFrom(
      interceptor.intercept(
        httpContext({ tenantId: 'tenant-a' }),
        handlerReadingTenant(),
      ) as Observable<string>,
    );

    expect(result).toBe('tenant-a');
  });

  // The regression guard for the laziness trap above.
  it('keeps the scope alive until the handler is subscribed', async () => {
    const intercepted = interceptor.intercept(
      httpContext({ tenantId: 'tenant-a' }),
      handlerReadingTenant(),
    );

    // A full turn of the event loop between intercept() and the subscription,
    // which is where an AsyncLocalStorage scope that was not awaited has
    // already been torn down.
    await new Promise((resolve) => setImmediate(resolve));

    await expect(firstValueFrom(intercepted)).resolves.toBe('tenant-a');
  });

  it('leaves the scope on the way out', async () => {
    await firstValueFrom(
      interceptor.intercept(
        httpContext({ tenantId: 'tenant-a' }),
        handlerReadingTenant(),
      ),
    );

    expect(currentScope()).toEqual({ kind: 'none' });
  });

  // No scope at all, rather than an empty one: requireTenantId() then throws,
  // so an unauthenticated route that forgets to say which tenant it means fails
  // loudly instead of reading somebody's rows.
  it.each([
    ['no user', undefined],
    ['a user without a tenant', {}],
    ['a non-string tenantId', { tenantId: 42 }],
    ['an empty tenantId', { tenantId: '' }],
  ])('establishes no scope for %s', async (_label, user) => {
    await expect(
      firstValueFrom(
        interceptor.intercept(httpContext(user), handlerReadingTenant()),
      ),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  it('passes non-HTTP contexts straight through', async () => {
    const wsContext = {
      getType: () => 'ws',
      switchToHttp: () => {
        throw new Error('switchToHttp must not be called for a ws context');
      },
    } as unknown as ExecutionContext;

    const result = await firstValueFrom(
      interceptor.intercept(wsContext, { handle: () => of('untouched') }),
    );

    expect(result).toBe('untouched');
  });

  it('propagates a handler error instead of swallowing it', async () => {
    const boom = new Error('boom');

    await expect(
      firstValueFrom(
        interceptor.intercept(httpContext({ tenantId: 'tenant-a' }), {
          handle: () => throwError(() => boom),
        }),
      ),
    ).rejects.toBe(boom);
  });

  // firstValueFrom rejects with EmptyError on a completed-but-silent Observable,
  // which a downstream interceptor can produce. `undefined` is what Nest would
  // have seen without this interceptor in the chain.
  it('survives a handler that completes without emitting', async () => {
    const result = await firstValueFrom(
      interceptor.intercept(httpContext({ tenantId: 'tenant-a' }), {
        handle: () =>
          new Observable<never>((subscriber) => subscriber.complete()),
      }),
      { defaultValue: 'never-reached' },
    );

    expect(result).toBeUndefined();
  });
});
