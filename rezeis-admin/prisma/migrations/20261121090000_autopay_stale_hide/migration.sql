-- Скрытие старых автосписаний и служебные отметки отмены.
--
-- Всё аддитивно: старый образ продолжает работать на новой схеме, откат образа
-- не требует отката базы. Жёсткого DELETE нет — строки нужны для сверки
-- callback'ов провайдера, истории попыток и признака `delay_granted_at`.
ALTER TABLE "provider_subscriptions"
  -- Когда строку скрыли из таблицы (soft-hide) и по какой причине.
  ADD COLUMN IF NOT EXISTS "hidden_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "hidden_reason" TEXT;

CREATE INDEX IF NOT EXISTS "provider_subscriptions_hidden_at_idx"
  ON "provider_subscriptions" ("hidden_at");
