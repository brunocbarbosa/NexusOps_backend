import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { HashingService } from './hashing.service';
import { JwtStrategy } from './jwt.strategy';
import { RefreshTokenService } from './refresh-token.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          // The cast is what `validateEnv` earns: `expiresIn` is typed as the
          // `ms` library's literal union, which no value read from the
          // environment can satisfy structurally, and the `^\d+[smhd]$` check
          // in src/config/env.validation.ts has already proved the shape.
          expiresIn: config.getOrThrow<string>(
            'JWT_EXPIRES_IN',
          ) as JwtSignOptions['expiresIn'],
        },
      }),
    }),
    PrismaModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    HashingService,
    JwtStrategy,
    RefreshTokenService,
    // Global, and in this order: RolesGuard reads the user that JwtAuthGuard
    // put on the request, and Nest runs global guards in declaration order.
    //
    // These are providers rather than lines in `configureApp()` — unlike the
    // tenancy interceptor, they need the Reflector injected. The e2e suites
    // still get them, because they boot AppModule.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  // Exported so the users module can hash a password without importing bcrypt
  // in a second place.
  exports: [HashingService],
})
export class AuthModule {}
