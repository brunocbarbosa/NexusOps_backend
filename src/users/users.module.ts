import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // AuthModule for HashingService and RefreshTokenService: hashing a password
  // in a second place would mean a second copy of the cost configuration, and
  // deactivating a user has to be able to end that user's sessions.
  imports: [PrismaModule, AuthModule],
  controllers: [UsersController],
  providers: [UsersService],
  // Exported for PlatformModule: the ADMIN_MASTER's user routes are a thin shell
  // around this same service, run inside `runWithTenant(companyId)`. A second
  // implementation of the same CRUD is a second place for the rules to drift.
  exports: [UsersService],
})
export class UsersModule {}
