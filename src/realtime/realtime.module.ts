import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsGateway } from './notifications.gateway';

@Module({
  // AuthModule for JwtService: the handshake verifies the same access token the
  // HTTP side does, so it has to use the same secret and the same options. A
  // second JwtModule here would be a second place to keep them in step.
  //
  // PrismaModule because the role is re-read from the row rather than trusted
  // from the token — see the comment on handleConnection.
  imports: [AuthModule, PrismaModule],
  providers: [NotificationsGateway],
})
export class RealtimeModule {}
