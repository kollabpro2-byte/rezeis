import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTOPAY_ATTEMPTS_CAP,
  appendAutopayAttempt,
  autopayGraceDeadline,
  readAutopayAttempts,
  shouldExtendForAutopay,
  summariseAutopayAttempts,
} from '../src/modules/payments/utils/autopay-log.util';

/**
 * История автосписаний и запас перед списанием. Логика чистая, поэтому
 * проверяется без базы: даты, повторы, обрезка и границы окна продления.
 */
describe('autopay-log.util', () => {
  describe('readAutopayAttempts', () => {
    it('returns nothing for anything that is not a list', () => {
      assert.deepEqual(readAutopayAttempts(null), []);
      assert.deepEqual(readAutopayAttempts({}), []);
      assert.deepEqual(readAutopayAttempts('[]'), []);
    });

    it('drops entries without a usable date instead of failing the row', () => {
      const attempts = readAutopayAttempts([
        { at: '2026-11-01T10:00:00.000Z', ok: true, amount: '199.00' },
        { at: 'not a date', ok: true },
        { ok: true },
        { at: '2026-11-02T10:00:00.000Z', ok: false, error: 'insufficient funds' },
      ]);
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0], { at: '2026-11-01T10:00:00.000Z', ok: true, amount: '199.00' });
      assert.deepEqual(attempts[1], {
        at: '2026-11-02T10:00:00.000Z',
        ok: false,
        error: 'insufficient funds',
      });
    });
  });

  describe('appendAutopayAttempt', () => {
    it('does not duplicate the same attempt seen twice by a sync', () => {
      const entry = { at: '2026-11-01T10:00:00.000Z', ok: true };
      const once = appendAutopayAttempt([], entry);
      const twice = appendAutopayAttempt(once, entry);
      assert.equal(twice.length, 1);
    });

    it('keeps the newest attempts and never grows past the cap', () => {
      let list: ReturnType<typeof appendAutopayAttempt> = [];
      for (let i = 0; i < AUTOPAY_ATTEMPTS_CAP + 12; i += 1) {
        list = appendAutopayAttempt(list, {
          at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
          ok: i % 2 === 0,
        });
      }
      assert.equal(list.length, AUTOPAY_ATTEMPTS_CAP);
      // Последняя добавленная осталась, самая старая — ушла.
      assert.equal(list[list.length - 1]?.at, new Date(Date.UTC(2026, 0, 1, 0, AUTOPAY_ATTEMPTS_CAP + 11)).toISOString());
      assert.equal(list[0]?.at, new Date(Date.UTC(2026, 0, 1, 0, 12)).toISOString());
    });
  });

  describe('summariseAutopayAttempts', () => {
    it('counts successes and failures and keeps the last date of each', () => {
      const summary = summariseAutopayAttempts([
        { at: '2026-11-01T10:00:00.000Z', ok: true },
        { at: '2026-11-02T10:00:00.000Z', ok: false, error: 'declined' },
        { at: '2026-11-03T10:00:00.000Z', ok: true },
      ]);
      assert.deepEqual(summary, {
        succeeded: 2,
        failed: 1,
        lastSuccessAt: '2026-11-03T10:00:00.000Z',
        lastFailureAt: '2026-11-02T10:00:00.000Z',
      });
    });
  });

  describe('shouldExtendForAutopay', () => {
    const now = new Date('2026-11-20T00:00:00.000Z');

    it('extends to six hours after the charge when the plan ends two hours earlier', () => {
      const expiresAt = new Date('2026-11-20T08:00:00.000Z');
      const nextChargeAt = new Date('2026-11-20T10:00:00.000Z');
      const deadline = shouldExtendForAutopay({ expiresAt, nextChargeAt, now });
      assert.deepEqual(deadline, autopayGraceDeadline(nextChargeAt));
      assert.equal(deadline?.toISOString(), '2026-11-20T16:00:00.000Z');
    });

    it('leaves a subscription that already outlives the charge alone', () => {
      assert.equal(
        shouldExtendForAutopay({
          expiresAt: new Date('2026-11-20T12:00:00.000Z'),
          nextChargeAt: new Date('2026-11-20T10:00:00.000Z'),
          now,
        }),
        null,
      );
    });

    it('does not touch a gap wider than the window', () => {
      assert.equal(
        shouldExtendForAutopay({
          expiresAt: new Date('2026-11-19T00:00:00.000Z'),
          nextChargeAt: new Date('2026-11-20T10:00:00.000Z'),
          now,
        }),
        null,
      );
    });

    it('still extends while the grace of a just-missed charge lies ahead', () => {
      // Списание прошло полчаса назад (провайдер повторит), запас ещё в будущем.
      const deadline = shouldExtendForAutopay({
        expiresAt: new Date('2026-11-19T23:00:00.000Z'),
        nextChargeAt: new Date('2026-11-19T23:30:00.000Z'),
        now,
      });
      assert.equal(deadline?.toISOString(), '2026-11-20T05:30:00.000Z');
    });

    it('does not extend for a charge that was missed long ago', () => {
      assert.equal(
        shouldExtendForAutopay({
          expiresAt: new Date('2026-11-19T10:00:00.000Z'),
          nextChargeAt: new Date('2026-11-19T12:00:00.000Z'),
          now,
        }),
        null,
      );
    });

    it('needs both dates to decide', () => {
      const nextChargeAt = new Date('2026-11-20T10:00:00.000Z');
      assert.equal(shouldExtendForAutopay({ expiresAt: null, nextChargeAt, now }), null);
      assert.equal(shouldExtendForAutopay({ expiresAt: new Date(), nextChargeAt: null, now }), null);
    });
  });
});
