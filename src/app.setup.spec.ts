import { INestApplication, ValidationPipe } from '@nestjs/common';
import { configureApp } from './app.setup';
import { TenantContextInterceptor } from './tenancy/tenant-context.interceptor';

// configureApp is the one place global application wiring is allowed to live,
// which makes it worth a test of its own: if a pipe silently stops being
// registered here, every e2e suite keeps passing while production loses its
// input validation.
describe('configureApp', () => {
  // The pipes are captured into a typed array rather than read back off
  // `mock.calls`, whose element type is `any` and would let a wrong assertion
  // compile.
  const fakeApp = () => {
    const pipes: unknown[] = [];
    const interceptors: unknown[] = [];
    const useGlobalPipes = jest.fn((...registered: unknown[]) => {
      pipes.push(...registered);
    });
    const useGlobalInterceptors = jest.fn((...registered: unknown[]) => {
      interceptors.push(...registered);
    });
    return {
      app: {
        useGlobalPipes,
        useGlobalInterceptors,
      } as unknown as INestApplication,
      useGlobalPipes,
      useGlobalInterceptors,
      pipes,
      interceptors,
    };
  };

  it('registers a global ValidationPipe', () => {
    const { app, useGlobalPipes, pipes } = fakeApp();

    configureApp(app);

    expect(useGlobalPipes).toHaveBeenCalledTimes(1);
    expect(pipes).toHaveLength(1);
    expect(pipes[0]).toBeInstanceOf(ValidationPipe);
  });

  // Without this the tenant scope is established nowhere, and every
  // tenant-scoped query in a request throws TenantContextMissingError — or,
  // far worse, a future `?? fallback` makes it read the wrong tenant.
  it('registers the global TenantContextInterceptor', () => {
    const { app, useGlobalInterceptors, interceptors } = fakeApp();

    configureApp(app);

    expect(useGlobalInterceptors).toHaveBeenCalledTimes(1);
    expect(interceptors).toHaveLength(1);
    expect(interceptors[0]).toBeInstanceOf(TenantContextInterceptor);
  });

  it('returns the same application instance, so callers can chain', () => {
    const { app } = fakeApp();

    expect(configureApp(app)).toBe(app);
  });
});
