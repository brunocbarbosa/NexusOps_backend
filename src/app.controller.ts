import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * Public on purpose, and not incidentally: the `docker` job in CI proves the
   * image actually boots by running `curl -fsS localhost:3000`, and `-f` makes
   * curl fail on a 401 exactly as it would on a crash. Authenticating a
   * liveness probe would mean the check could only run with a database, a
   * tenant and a user already in place.
   *
   * It is still the scaffold greeting. When this becomes a real health
   * endpoint it keeps this decorator for the same reason.
   */
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
