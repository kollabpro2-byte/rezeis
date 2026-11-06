import { IsEmail, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

/** Body for `POST /api/internal/link/telegram/generate`. */
export class LinkTelegramGenerateDto {
  @IsString()
  @Length(1, 64)
  public readonly userId!: string;

  /** `app` when the Android client started the link. Days are granted from that mark. */
  @IsOptional()
  @IsIn(['app', 'web'])
  public readonly source?: 'app' | 'web';
}

/**
 * Body for `POST /api/internal/link/telegram/consume` — called by reiwa
 * when a Telegram user enters the linking code (e.g. via `/start <code>`
 * or a dedicated `/link <code>` command).
 */
export class LinkTelegramConsumeDto {
  @IsString()
  @Matches(/^\d{1,19}$/, { message: 'telegramId must be a positive numeric string up to 19 digits' })
  public readonly telegramId!: string;

  @IsString()
  @Length(6, 16)
  public readonly code!: string;
}

/** Body for `POST /api/internal/link/email/initiate`. */
export class LinkEmailInitiateDto {
  @IsString()
  @Length(1, 64)
  public readonly userId!: string;

  @IsEmail()
  public readonly email!: string;
}

/** Body for `POST /api/internal/link/email/verify`. */
export class LinkEmailVerifyDto {
  @IsString()
  @Length(1, 64)
  public readonly userId!: string;

  @IsString()
  @Length(4, 16)
  public readonly code!: string;
}
