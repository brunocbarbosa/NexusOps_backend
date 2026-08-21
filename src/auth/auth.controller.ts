import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import type { AuthenticatedUser } from './authenticated-user';
import { AuthResult, AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** The only way a tenant, and therefore the first ADMIN, comes into existence. */
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<AuthResult> {
    return this.auth.register(dto);
  }

  // 200 and not the default 201: logging in creates no resource, and a client
  // that branches on the status should not have to special-case this one.
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto): Promise<AuthResult> {
    return this.auth.login(dto);
  }

  /**
   * Public because the access token has expired by definition — that is what
   * refreshing is for. The refresh token itself is the credential, and it
   * carries the tenant the lookup needs.
   */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthResult> {
    return this.auth.refresh(dto.refreshToken);
  }

  // Authenticated, so the revocation can be scoped to the caller's own
  // sessions, and 204 because there is nothing useful to say back.
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  logout(
    @Body() dto: RefreshTokenDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.auth.logout(dto.refreshToken, user);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return this.auth.me(user);
  }
}
