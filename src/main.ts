import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Shared with the e2e suite; see src/app.setup.ts for why it is not inline.
  configureApp(app);

  // From the validated config rather than `process.env` directly: PORT arrives
  // there as a string, and validateEnv is what coerced it and proved it is a
  // legal port at all.
  await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'));
}
void bootstrap();
