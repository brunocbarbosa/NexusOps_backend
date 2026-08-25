import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PlatformBootstrapService } from './platform-bootstrap.service';

/**
 * AuthModule is imported for `HashingService`, and that import also fixes the
 * initialisation order: Nest initialises a module's dependencies first, so
 * `HashingService.onModuleInit` has built its decoy hash before
 * `PlatformBootstrapService.onModuleInit` asks it to hash anything.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  providers: [PlatformBootstrapService],
  exports: [PlatformBootstrapService],
})
export class PlatformModule {}
