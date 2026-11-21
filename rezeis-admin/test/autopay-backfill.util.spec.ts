import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { enrichAttempts, PAIR_WINDOW_MS } from '../scripts/autopay-attempts-backfill';
import type { AutopayAttempt } from '../src/modules/payments/utils/autopay-log.util';

/**
 * Подтягивание id к старым попыткам автосписания.
 *
 * Попытки хранят только дату и результат, а id появились позже. Скрипт
 * `scripts/autopay-attempts-backfill.ts` достаёт их из транзакций (`APAY…` в
 * ключе) или из `payments[]` Antilopay и раскладывает по попыткам. Здесь
 * проверяется раскладка: она не должна ни выдумывать пару, ни затирать уже
 * записанный id.
 */
const at = (iso: string): string => new Date(iso).toISOString();

describe('autopay-attempts-backfill · enrichAttempts', () => {
  it('при равном количестве пары идут по порядку', () => {
    const attempts: AutopayAttempt[] = [
      { at: at('2026-09-15T10:00:00Z'), ok: true, amount: '299' },
      { at: at('2026-10-15T10:00:00Z'), ok: true, amount: '299' },
    ];
    const charges = [
      { paymentId: 'APAY-1', orderId: 'order-1', at: new Date('2026-09-15T10:00:00Z') },
      { paymentId: 'APAY-2', orderId: 'order-2', at: new Date('2026-10-15T10:00:00Z') },
    ];

    const result = enrichAttempts(attempts, charges);

    assert.equal(result.filled, 2);
    assert.equal(result.unmatched, 0);
    assert.deepEqual(result.next[0], {
      at: at('2026-09-15T10:00:00Z'),
      ok: true,
      amount: '299',
      paymentId: 'APAY-1',
      orderId: 'order-1',
    });
    assert.equal(result.next[1]?.paymentId, 'APAY-2');
  });

  it('при разном количестве ищет ближайшее списание в пределах суток', () => {
    const attempts: AutopayAttempt[] = [{ at: at('2026-10-15T10:00:00Z'), ok: true }];
    const charges = [
      { paymentId: 'APAY-far', orderId: null, at: new Date('2026-09-15T10:00:00Z') },
      { paymentId: 'APAY-near', orderId: 'order-2', at: new Date('2026-10-15T13:00:00Z') },
    ];

    const result = enrichAttempts(attempts, charges);

    assert.equal(result.filled, 1);
    assert.equal(result.next[0]?.paymentId, 'APAY-near');
    assert.equal(result.next[0]?.orderId, 'order-2');
  });

  it('при равном количестве порядок важнее дат: это одни и те же списания', () => {
    // Даты разошлись на полтора месяца (история восстановлена приблизительно),
    // но списаний столько же, сколько попыток, — значит соответствие по порядку.
    const result = enrichAttempts(
      [{ at: at('2026-10-15T10:00:00Z'), ok: true }],
      [{ paymentId: 'APAY-old', orderId: null, at: new Date('2026-09-01T10:00:00Z') }],
    );
    assert.equal(result.filled, 1);
    assert.equal(result.next[0]?.paymentId, 'APAY-old');
  });

  it('при разном количестве дальше суток пары нет: id не выдумывается', () => {
    const attempts: AutopayAttempt[] = [{ at: at('2026-10-15T10:00:00Z'), ok: true }];
    const charges = [
      { paymentId: 'APAY-old', orderId: null, at: new Date('2026-09-01T10:00:00Z') },
      { paymentId: 'APAY-older', orderId: null, at: new Date('2026-08-01T10:00:00Z') },
    ];

    const result = enrichAttempts(attempts, charges);

    assert.equal(result.filled, 0);
    assert.equal(result.unmatched, 1);
    assert.equal(result.next[0]?.paymentId, undefined);
    assert.ok(PAIR_WINDOW_MS === 24 * 60 * 60 * 1000);
  });

  it('уже записанный id не затирается, недостающий дописывается', () => {
    const attempts: AutopayAttempt[] = [
      { at: at('2026-10-15T10:00:00Z'), ok: true, paymentId: 'APAY-own' },
    ];
    const charges = [
      { paymentId: 'APAY-from-db', orderId: 'order-db', at: new Date('2026-10-15T10:00:00Z') },
    ];

    const result = enrichAttempts(attempts, charges);

    assert.equal(result.next[0]?.paymentId, 'APAY-own');
    assert.equal(result.next[0]?.orderId, 'order-db');
    assert.equal(result.filled, 1);
  });

  it('неуспешным попыткам id не достаются: денег по ним не было', () => {
    const attempts: AutopayAttempt[] = [{ at: at('2026-10-15T10:00:00Z'), ok: false, error: 'ACTIVE_FAILED' }];
    const charges = [
      { paymentId: 'APAY-1', orderId: 'order-1', at: new Date('2026-10-15T10:00:00Z') },
    ];

    const result = enrichAttempts(attempts, charges);

    assert.equal(result.filled, 0);
    assert.deepEqual(result.next[0], { at: at('2026-10-15T10:00:00Z'), ok: false, error: 'ACTIVE_FAILED' });
  });

  it('повторный прогон ничего не меняет', () => {
    const charges = [
      { paymentId: 'APAY-1', orderId: 'order-1', at: new Date('2026-09-15T10:00:00Z') },
      { paymentId: 'APAY-2', orderId: 'order-2', at: new Date('2026-10-15T10:00:00Z') },
    ];
    const attempts: AutopayAttempt[] = [
      { at: at('2026-09-15T10:00:00Z'), ok: true },
      { at: at('2026-10-15T10:00:00Z'), ok: true },
    ];

    const first = enrichAttempts(attempts, charges);
    const second = enrichAttempts(first.next, charges);

    assert.equal(first.filled, 2);
    assert.equal(second.filled, 0);
    assert.deepEqual(second.next, first.next);
  });

  it('списание без обоих id не участвует в раскладке', () => {
    const attempts: AutopayAttempt[] = [{ at: at('2026-10-15T10:00:00Z'), ok: true }];
    const result = enrichAttempts(attempts, [
      { paymentId: null, orderId: null, at: new Date('2026-10-15T10:00:00Z') },
    ]);
    assert.equal(result.filled, 0);
    assert.equal(result.unmatched, 1);
  });
});
