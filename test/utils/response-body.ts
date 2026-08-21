import { Response } from 'supertest';

/**
 * Supertest types `response.body` as `any`, which switches off every
 * type-checked lint rule that touches it and lets a typo in a field name pass
 * review. This is the one place the assertion is made, and the call site says
 * what it expects the endpoint to return.
 */
export function bodyOf<T>(response: Response): T {
  return response.body as T;
}
