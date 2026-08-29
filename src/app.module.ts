import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CommentsModule } from './comments/comments.module';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { ReportsModule } from './reports/reports.module';
import { PlatformModule } from './platform/platform.module';
import { TicketsModule } from './tickets/tickets.module';
import { UsersModule } from './users/users.module';

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
    // wildcard: true is what makes the audit listener's `ticket.*` pattern
    // work at all: without it the emitter matches event names literally and
    // the listener never fires, silently. The delimiter stays the default '.'.
    EventEmitterModule.forRoot({ wildcard: true }),
    // forRootAsync rather than forRoot: the connection details are validated
    // environment, and reading process.env directly here would bypass the
    // coercion that turns REDIS_PORT from a string into a number.
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
          password: config.get<string>('REDIS_PASSWORD'),
        },
      }),
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    PlatformModule,
    TicketsModule,
    CommentsModule,
    AuditModule,
    ReportsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
