import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { CompanyUsersController } from './company-users.controller';
import { PlatformBootstrapService } from './platform-bootstrap.service';

/**
 * AuthModule is imported for `HashingService`, and that import also fixes the
 * initialisation order: Nest initialises a module's dependencies first, so
 * `HashingService.onModuleInit` has built its decoy hash before
 * `PlatformBootstrapService.onModuleInit` asks it to hash anything.
 *
 * UsersModule is imported for `UsersService` and nothing else. The platform's
 * user routes run that same service inside an explicit tenant scope rather than
 * reimplementing it.
 */
@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [CompaniesController, CompanyUsersController],
  providers: [PlatformBootstrapService, CompaniesService],
  exports: [PlatformBootstrapService],
})
export class PlatformModule {}
