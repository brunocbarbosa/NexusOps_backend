import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    // Global so that ConfigService is injectable without every module importing
    // this one, and validated so that a missing variable stops the process at
    // boot. It is also the only thing that loads `.env` at all: `nest start`
    // does not read it, so before this the dev server ran with no DATABASE_URL.
    //
    // File values never overwrite variables already present in `process.env`,
    // which is what keeps the test tiers on `.env.test` — their `setupFiles`
    // load it before Nest boots, so it wins over `.env`.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
