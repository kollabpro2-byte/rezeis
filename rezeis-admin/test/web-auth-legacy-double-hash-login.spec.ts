/**
 * ПАРОЛИ, ЗАПИСАННЫЕ ДВОЙНЫМ ХЕШЕМ, ОТКРЫВАЮТСЯ И СРАЗУ МИГРИРУЮТ.
 *
 * До перехода на открытый пароль BFF (reiwa) отправлял в панель не пароль, а
 * `sha256(пароль)`, и панель честно хешировала то, что получила. В
 * `WebAccount.passwordHash` таких строк лежит `scrypt(sha256(пароль))`.
 *
 * Если бы клиент просто начал присылать открытый пароль, панель посчитала бы
 * `scrypt(пароль)` — и НИ ОДНА существующая учётная запись не открылась бы.
 * Поэтому клиент присылает и пароль, и переходный хеш; панель проверяет второй
 * только если первый не подошёл, и в этот же момент перехеширует строку
 * ПАРОЛЕМ. Тесты ниже держат обе половины этого контракта.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { WebAuthService } from '../src/modules/web-auth/services/web-auth.service';

const PASSWORD = 'subscriber-real-password';
const LOGIN = 'subscriber';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Строка ровно в том виде, в каком её оставил старый путь: панель получила
 * `sha256(пароль)` и захешировала его текущим scrypt-профилем подписчика.
 */
async function doubleHashedRow(password: string): Promise<string> {
  return new PasswordHashService().hashPassword({
    plainTextPassword: sha256(password),
    audience: 'subscriber',
  });
}

interface UpdateCall {
  readonly where: Record<string, unknown>;
  readonly data: Record<string, unknown>;
}

function buildHarness(stored: string) {
  const updates: UpdateCall[] = [];
  const row = { passwordHash: stored };
  const prisma = {
    webAccount: {
      findUnique: async () => ({
        id: 'web-account-1',
        userId: 'user-1',
        login: LOGIN,
        loginNormalized: LOGIN,
        passwordHash: stored,
        passwordBootstrapPending: false,
        requiresPasswordChange: false,
        temporaryPasswordExpiresAt: null,
        credentialsBootstrappedAt: new Date('2026-01-01T00:00:00.000Z'),
        emailVerifiedAt: new Date('2026-01-02T00:00:00.000Z'),
        user: { telegramId: BigInt(1), isBlocked: false },
      }),
      updateMany: async (args: UpdateCall) => {
        updates.push(args);
        const expected = args.where['passwordHash'];
        if (typeof expected === 'string' && expected !== row.passwordHash) return { count: 0 };
        row.passwordHash = String(args.data['passwordHash']);
        return { count: 1 };
      },
      update: async () => {
        throw new Error('login must not take the unconditional update path');
      },
    },
  };
  const service = new WebAuthService(
    prisma as never,
    new PasswordHashService() as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
  return { service, updates, row };
}


describe('двойной хеш: открытый пароль сам по себе не открывает старую строку', () => {
  it('отказывает, когда строка записана как scrypt(sha256(пароль))', async () => {
    const harness = buildHarness(await doubleHashedRow(PASSWORD));

    await assert.rejects(
      () => harness.service.login({ login: LOGIN, password: PASSWORD }),
      /Invalid login or password/,
      'старая строка открылась открытым паролем — значит проверка не та, что задумана',
    );
    assert.equal(harness.updates.length, 0, 'неудачный вход не должен ничего перезаписывать');
  });
});

describe('двойной хеш: переходный хеш открывает строку и сразу её мигрирует', () => {
  it('принимает пару (пароль, sha256) и записывает scrypt(пароль)', async () => {
    const stored = await doubleHashedRow(PASSWORD);
    const harness = buildHarness(stored);

    const result = await harness.service.login({
      login: LOGIN,
      password: PASSWORD,
      legacyPasswordHash: sha256(PASSWORD),
    });

    assert.equal(result.userId, 'user-1', 'вход не прошёл');
    assert.equal(harness.updates.length, 1, 'строка не была перехеширована');
    const written = String(harness.updates[0].data['passwordHash']);
    assert.notEqual(written, stored, 'строка осталась прежней');
    assert.deepEqual(Object.keys(harness.updates[0].data), ['passwordHash'], 'перезаписаны лишние колонки');

    const hasher = new PasswordHashService();
    assert.equal(
      await hasher.verifyPassword({ plainTextPassword: PASSWORD, passwordHash: written }),
      true,
      'перехешированная строка не проверяется открытым паролем',
    );
    assert.equal(
      await hasher.verifyPassword({ plainTextPassword: sha256(PASSWORD), passwordHash: written }),
      false,
      'перехешированная строка всё ещё принимает sha256 — миграция не состоялась',
    );
  });

  it('верный открытый пароль не требует переходного хеша и ничего не переписывает', async () => {
    const migrated = await new PasswordHashService().hashPassword({
      plainTextPassword: PASSWORD,
      audience: 'subscriber',
    });
    const harness = buildHarness(migrated);

    const result = await harness.service.login({
      login: LOGIN,
      password: PASSWORD,
      legacyPasswordHash: sha256(PASSWORD),
    });

    assert.equal(result.userId, 'user-1');
    assert.equal(harness.updates.length, 0, 'строку переписали без причины');
  });

  it('неверный переходный хеш не открывает строку', async () => {
    const harness = buildHarness(await doubleHashedRow(PASSWORD));

    await assert.rejects(
      () =>
        harness.service.login({
          login: LOGIN,
          password: PASSWORD,
          legacyPasswordHash: sha256('another-password'),
        }),
      /Invalid login or password/,
    );
    assert.equal(harness.updates.length, 0, 'неудачный вход не должен ничего перезаписывать');
  });
});
