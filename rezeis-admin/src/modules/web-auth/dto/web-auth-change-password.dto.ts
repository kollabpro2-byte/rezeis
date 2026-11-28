import { IsOptional, IsString, Length } from 'class-validator';

/** Body for `POST /api/internal/web-auth/change-password`. */
export class WebAuthChangePasswordDto {
  @IsString()
  @Length(1, 256)
  public readonly userId!: string;

  @IsString()
  @Length(8, 256)
  public readonly currentPassword!: string;

  @IsString()
  @Length(8, 256)
  public readonly newPassword!: string;

  /**
   * ПЕРЕХОДНОЕ ПОЛЕ, не учётные данные: `sha256(текущий пароль)`.
   *
   * Строки, записанные до перехода на открытый пароль, — это
   * `scrypt(sha256(пароль))`. Он проверяется ТОЛЬКО если открытый текущий пароль
   * не подошёл — так же, как `legacyPasswordHash` при входе.
   */
  @IsOptional()
  @IsString()
  @Length(1, 256)
  public readonly legacyCurrentPassword?: string;
}
