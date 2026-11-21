import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  autopayChargeMetadata,
  readAutopayChargeKey,
} from '../src/modules/payments/services/payment-subscription-mutation.service';

/**
 * Ключ транзакции, которой провайдер доставил своё списание по автоподписке.
 *
 * По нему карточка «Успешное списание по подписке» отличает автосписание от
 * обычной оплаты и получает id строки и платежа — без этого оператор искал
 * платёж в кабинете провайдера по дате и сумме.
 */
describe('readAutopayChargeKey', () => {
  it('разбирает ключ Antilopay, где списание названо платежом', () => {
    assert.deepEqual(
      readAutopayChargeKey('provider-subscription:cmvgy6bdy0:payment:APAY123'),
      { rowId: 'cmvgy6bdy0', providerPaymentId: 'APAY123' },
    );
  });

  it('разбирает «номерной» ключ: id платежа там нет', () => {
    assert.deepEqual(
      readAutopayChargeKey('provider-subscription:cmvgy6bdy0:charge:3'),
      { rowId: 'cmvgy6bdy0', providerPaymentId: null },
    );
  });

  it('возвращает null для обычной оплаты', () => {
    assert.equal(readAutopayChargeKey('renewal-42'), null);
    assert.equal(readAutopayChargeKey(''), null);
    assert.equal(readAutopayChargeKey(null), null);
    assert.equal(readAutopayChargeKey(undefined), null);
  });

  it('не считает автосписанием ключ с пустым rowId', () => {
    assert.equal(readAutopayChargeKey('provider-subscription::payment:APAY1'), null);
  });
});

describe('autopayChargeMetadata', () => {
  it('ставит флаг заголовка и id строки с платежом', () => {
    const metadata = autopayChargeMetadata(
      { rowId: 'cmvgy6bdy0', providerPaymentId: 'APAY123' },
      ['APAY123', 'order-1'],
    );
    assert.equal(metadata['autopay'], true);
    assert.equal(metadata['autopayRowId'], 'cmvgy6bdy0');
    assert.equal(metadata['providerPaymentId'], 'APAY123');
    assert.deepEqual(metadata['chargeIds'], ['APAY123', 'order-1']);
  });

  it('не выдумывает id платежа, когда провайдер его не назвал', () => {
    const metadata = autopayChargeMetadata({ rowId: 'row-1', providerPaymentId: null }, []);
    assert.equal('providerPaymentId' in metadata, false);
    assert.equal('chargeIds' in metadata, false);
    assert.equal(metadata['autopay'], true);
  });
});
