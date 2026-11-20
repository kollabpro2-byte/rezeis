-- Здоровье автоподписки и следы «осиротевших» строк.
--
-- Всё аддитивно: старый образ продолжает работать на новой схеме, откат образа
-- не требует отката базы. Ни одно поле не переименовано и не удалено.
ALTER TABLE "provider_subscriptions"
  -- Когда строка впервые признана зависшей (PROCESSING/ACTIVE_FAILED с датой в прошлом).
  ADD COLUMN IF NOT EXISTS "stalled_since" TIMESTAMPTZ,
  -- Почему строка считается лишней: заменена новой автоподпиской или продлена вручную.
  ADD COLUMN IF NOT EXISTS "stranded_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "stranded_at" TIMESTAMPTZ,
  -- Попытки отменить у провайдера: backoff и последняя ошибка.
  ADD COLUMN IF NOT EXISTS "cancel_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cancel_next_try_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "cancel_last_error" TEXT,
  -- Провайдер не отменяет сам (PROCESSING): оператору нужно сделать это в ЛК.
  ADD COLUMN IF NOT EXISTS "manual_cancel_required" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "provider_subscriptions_cancel_next_try_at_idx"
  ON "provider_subscriptions" ("cancel_next_try_at");
