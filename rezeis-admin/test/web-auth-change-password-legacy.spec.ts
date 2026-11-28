/**
 * СМЕНА ПАРОЛЯ ПОСЛЕ ВРЕМЕННОГО: открытый текущий пароль открывает и свежую
 * строку `scrypt(пароль)`, и старую `scrypt(sha256(пароль))`.
 *
 * Оператор выдаёт временный пароль как `scrypt(sha256(temp))`, первый же вход
 * перехеширует строку в `scrypt(temp)`, а форма смены присылала только
 * `sha256(temp)` — оно не подходило ни к одной из двух форм, и смена всегда
 * отвечала 401. Тесты держат обе проверки и то, что новый пароль пишется как
 * `scrypt(пароль)` с очисткой флага смены.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { UnauthorizedException } from '@nestjs/common';

import { PasswordHashService } from '../src/modules/auth/services/password-hash.service';
import { WebAuthService } from '../src/modules/web-auth/services/web-auth.service';

const TEMP = 'TempPassw0rdXYZ';
const NEXT = 'brand-new-password';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function harness(stored: string) {
  const writes: Array<Record<string, unknown>> = [];
  const client = {
    webAccount: {
      update: async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        return { id: 'web-account-1' };
      },
    },
    // `raiseSessionsRevokedAt` — the sign-out moment, not under test here.
    $executeRaw: async () => 1,
  };
  const prisma = {
    webAccount: {
      findUnique: async () => ({
        id: 'web-account-1',
        userId: 'user-1',
        passwordHash: stored,
        requiresPasswordChange: true,
        temporaryPasswordExpiresAt: new Date(Date.now() + 3600_000),
      }),
    },
    $transaction: async <R>(fn: (tx: typeof client) => Promise<R>): Promise<R> => fn(client),
  };
  const cache = { del: async () => undefined };
  const hasher = new PasswordHashService();
  const service = new WebAuthService(
    prisma as never,
    hasher as never,
    null as never,
    null as never,
    null as never,
    cache as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
  return { service, writes, hasher };
}

describe('смена пароля: проверка текущего', () => {
  it('открытый текущий пароль открывает строку scrypt(пароль), новый пишется как scrypt(пароль)', async () => {
    const hasher = new PasswordHashService();
    const stored = await hasher.hashPassword({ plainTextPassword: TEMP, audience: 'subscriber' });
    const h = harness(stored);

    const result = await h.service.changePassword({
      userId: 'user-1',
      currentPassword: TEMP,
      legacyCurrentPassword: sha256(TEMP),
      newPassword: NEXT,
    });

    assert.equal(result.success, true);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0]['requiresPasswordChange'], false, 'флаг смены пароля не снят');
    assert.equal(h.writes[0]['temporaryPasswordExpiresAt'], null);
    const written = String(h.writes[0]['passwordHash']);
    assert.equal(await hasher.verifyPassword({ plainTextPassword: NEXT, passwordHash: written }), true);
    assert.equal(await hasher.verifyPassword({ plainTextPassword: sha256(NEXT), passwordHash: written }), false);
  });

  it('старая строка scrypt(sha256(пароль)) открывается переходным sha256', async () => {
    const hasher = new PasswordHashService();
    const stored = await hasher.hashPassword({ plainTextPassword: sha256(TEMP), audience: 'subscriber' });
    const h = harness(stored);

    const result = await h.service.changePassword({
      userId: 'user-1',
      currentPassword: TEMP,
      legacyCurrentPassword: sha256(TEMP),
      newPassword: NEXT,
    });

    assert.equal(result.success, true);
    assert.equal(h.writes.length, 1);
  });

  it('старый клиент, приславший только sha256 как currentPassword, по-прежнему проходит', async () => {
    const hasher = new PasswordHashService();
    const stored = await hasher.hashPassword({ plainTextPassword: sha256(TEMP), audience: 'subscriber' });
    const h = harness(stored);

    const result = await h.service.changePassword({
      userId: 'user-1',
      currentPassword: sha256(TEMP),
      newPassword: sha256(NEXT),
    });

    assert.equal(result.success, true);
  });

  it('неверный текущий пароль — 401, ничего не записано', async () => {
    const hasher = new PasswordHashService();
    const stored = await hasher.hashPassword({ plainTextPassword: TEMP, audience: 'subscriber' });
    const h = harness(stored);

    await assert.rejects(
      () =>
        h.service.changePassword({
          userId: 'user-1',
          currentPassword: 'definitely-wrong-password',
          legacyCurrentPassword: sha256('definitely-wrong-password'),
          newPassword: NEXT,
        }),
      UnauthorizedException,
    );
    assert.deepEqual(h.writes, []);
  });
});
