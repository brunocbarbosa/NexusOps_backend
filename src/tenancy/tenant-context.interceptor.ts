import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, firstValueFrom, from } from 'rxjs';
import { runWithTenant } from './tenant-context';

/**
 * The shape `JwtStrategy.validate()` puts on the request. Read structurally
 * rather than imported from `src/auth/`, so the tenancy layer keeps knowing
 * nothing about how authentication happens.
 */
type MaybeAuthenticatedRequest = {
  user?: { tenantId?: unknown };
};

/**
 * Establishes the AsyncLocalStorage tenant scope for the rest of the request.
 *
 * Runs after the guards — Nest's order is middleware, guards, interceptors —
 * which is the whole reason this is an interceptor and not middleware: at
 * middleware time `request.user` does not exist yet, and decoding the JWT a
 * second time to get it would mean two places that decide who the caller is.
 *
 * Requests with no authenticated user pass through with **no** scope at all,
 * not with an empty one. That is deliberate: `requireTenantId()` then throws,
 * so a public route that forgets to say which tenant it means fails loudly
 * instead of reading somebody's rows. The three routes that legitimately run
 * without a tenant (register, login, refresh) say so with `runWithoutTenant()`
 * or establish the tenant themselves.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // WebSocket and BullMQ execution contexts have no HTTP request and no
    // AsyncLocalStorage to inherit; they carry the tenant in the message or job
    // payload and wrap their own body. See CLAUDE.md > Architecture.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context
      .switchToHttp()
      .getRequest<MaybeAuthenticatedRequest>();
    const tenantId = request.user?.tenantId;

    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      return next.handle();
    }

    // `next.handle()` is subscribed *inside* the scope on purpose. An Observable
    // is lazy in exactly the way `PrismaPromise` is (see
    // documents/important/TENANCY_EXTENSION.md): returning it from inside
    // `runWithTenant` would hand back an unsubscribed Observable and the query
    // would dispatch after the scope had already closed, producing a
    // TenantContextMissingError from code that visibly established a tenant.
    //
    // The cost of converting to a promise is that only the first emission
    // survives, so `@Sse` and any other multi-emission handler cannot be used
    // under this interceptor. Single-value handlers — every REST route, plus
    // StreamableFile, which emits one object — are unaffected.
    return from(
      runWithTenant(tenantId, () =>
        // defaultValue guards the case where a downstream interceptor completes
        // without emitting; without it firstValueFrom rejects with EmptyError.
        firstValueFrom(next.handle(), { defaultValue: undefined }),
      ),
    );
  }
}
