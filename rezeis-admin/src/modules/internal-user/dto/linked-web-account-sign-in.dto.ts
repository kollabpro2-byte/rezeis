import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

import { loginPolicy } from '../../auth/utils/login-policy.util';

/**
 * Validates the internal linked web-account sign-in payload.
 */
export class LinkedWebAccountSignInDto {
  @Transform(({ value }: { readonly value: unknown }): unknown =>
    typeof value === 'string' ? loginPolicy.sanitizeLogin(value) : value,
  )
  @IsString()
  @MinLength(loginPolicy.minLength)
  @MaxLength(loginPolicy.maxLength)
  @Matches(loginPolicy.pattern)
  public login!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public password!: string;

  /**
   * Переходное поле: `sha256(пароль)`, который BFF присылал вместо пароля до
   * миграции. Проверяется только если открытый пароль не подошёл; при успехе
   * строка сразу перехешируется паролем. См. `WebAuthLoginDto`.
   */
  @IsOptional()
  @IsString()
  @Length(1, 128)
  public legacyPasswordHash?: string;
}
