import { IsOptional, IsString, Length } from 'class-validator';

/** Body for `POST /api/internal/web-auth/login`. */
export class WebAuthLoginDto {
  @IsString()
  @Length(3, 64)
  public readonly login!: string;

  @IsString()
  @Length(8, 256)
  public readonly password!: string;

  /**
   * ПЕРЕХОДНОЕ ПОЛЕ, не учётные данные.
   *
   * До миграции BFF (reiwa) отправлял в `password` не пароль, а
   * `sha256(пароль)`, поэтому в `WebAccount.passwordHash` лежит
   * `scrypt(sha256(пароль))`. Новый клиент присылает и открытый пароль, и этот
   * хеш: второй проверяется ТОЛЬКО если первый не подошёл, и тогда строка сразу
   * перехешируется открытым паролем. Так ни один существующий пароль не теряется,
   * а запись мигрирует при первом же входе.
   *
   * Поле исчезнет вместе с последним клиентом, который его присылает.
   */
  @IsOptional()
  @IsString()
  @Length(1, 128)
  public readonly legacyPasswordHash?: string;
}
