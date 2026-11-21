import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVENT_PRESENTATION,
  EVENT_TYPES,
  OPERATOR_ONLY_EVENT_TYPES,
  REGISTERED_EVENT_TYPES,
} from '../src/common/services/system-events.service';

/**
 * Провал списания по автоподписке — отдельный тип, а не `payment.failed`.
 *
 * На `payment.failed` висят попап в кабинете, realtime-проекция плательщика и
 * шаблоны автоматизаций (`payment_failed`), поэтому провал рекуррентного
 * списания вылез бы клиенту как «ваш платёж не прошёл», хотя платить он ничего
 * не начинал. Тест держит это решение: тип зарегистрирован, подписан как
 * «Неуспешное списание по подписке» и закрыт для всех, кроме оператора.
 */
describe('payment.autopay_charge_failed', () => {
  it('зарегистрирован и подписан как неуспешное списание по подписке', () => {
    const type = EVENT_TYPES.PAYMENT_AUTOPAY_CHARGE_FAILED;
    assert.equal(type, 'payment.autopay_charge_failed');
    assert.ok(REGISTERED_EVENT_TYPES.has(type));
    assert.equal(EVENT_PRESENTATION[type]?.title, 'Неуспешное списание по подписке');
  });

  it('только для оператора: клиенту попап и шаблоны не уходят', () => {
    assert.ok(OPERATOR_ONLY_EVENT_TYPES.has(EVENT_TYPES.PAYMENT_AUTOPAY_CHARGE_FAILED));
  });

  it('успешное списание остаётся payment.completed, но с иным заголовком', () => {
    // Заголовок выбирается вариантом по метаданным: карточка получает
    // «Успешное списание по подписке», остальные потребители типа не меняются.
    const variants = EVENT_PRESENTATION[EVENT_TYPES.PAYMENT_COMPLETED]?.variants ?? [];
    const autopay = variants.find((variant) => variant.title === 'Успешное списание по подписке');
    assert.ok(autopay, 'вариант для автосписания объявлен');
    assert.equal(autopay?.when({ autopay: true }), true);
    assert.equal(autopay?.when({}), false);
  });
});
