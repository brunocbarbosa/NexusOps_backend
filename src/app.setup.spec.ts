import { INestApplication, ValidationPipe } from '@nestjs/common';
import { configureApp } from './app.setup';

// configureApp is the one place global application wiring is allowed to live,
// which makes it worth a test of its own: if a pipe silently stops being
// registered here, every e2e suite keeps passing while production loses its
// input validation.
describe('configureApp', () => {
  // The pipes are captured into a typed array rather than read back off
  // `mock.calls`, whose element type is `any` and would let a wrong assertion
  // compile.
  const fakeApp = () => {
    const registered: unknown[] = [];
    const useGlobalPipes = jest.fn((...pipes: unknown[]) => {
      registered.push(...pipes);
    });
    return {
      app: { useGlobalPipes } as unknown as INestApplication,
      useGlobalPipes,
      registered,
    };
  };

  it('registers a global ValidationPipe', () => {
    const { app, useGlobalPipes, registered } = fakeApp();

    configureApp(app);

    expect(useGlobalPipes).toHaveBeenCalledTimes(1);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toBeInstanceOf(ValidationPipe);
  });

  it('returns the same application instance, so callers can chain', () => {
    const { app } = fakeApp();

    expect(configureApp(app)).toBe(app);
  });
});
