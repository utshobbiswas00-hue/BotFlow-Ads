import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CRYPTO_NETWORKS } from '@botflow/shared';
import { prisma } from '../src/db/prisma';
import { NotFoundError, ValidationError } from '../src/utils/errors';

const {
  listCryptoAddresses,
  upsertCryptoAddress,
  setCryptoAddressActive,
  deleteCryptoAddress,
  listDepositNetworks,
  addressForNetwork,
} = await import('../src/services/cryptoAddress.service');
const { resetDatabase } = await import('./helpers/fixtures');

/**
 * CRYPTO DEPOSIT ADDRESSES.
 *
 * The operator adds a wallet address per network from the admin panel, and the
 * deposit screen offers exactly the networks that have one.
 *
 * The rule this file exists to protect:
 *
 *   A NETWORK WITH NO (ACTIVE) ADDRESS IS ABSENT, NEVER SHOWN BLANK.
 *
 * USDT on TON and USDT on BEP20 are different wallets, and a transfer to the
 * wrong chain is unrecoverable. An advertiser shown an empty address may still
 * send to it; an advertiser shown no option cannot. Between "not offered" and
 * "offered but wrong" only the first is recoverable, so absence is the safe
 * failure.
 */

const ADMIN = 'admin-1';
const TRC20 = 'TXk9Q4mVv8pJ2QwErTyUiOpAsDfGhJkLz1';
const TON_ADDR = 'UQAvL8yN5rT2mKp9XwQc3dEfGhJkLmNpQrStUvWx';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the admin panel view', () => {
  it('lists every known network, flagging the ones not configured yet', async () => {
    const rows = await listCryptoAddresses();

    // Unconfigured networks are INCLUDED, so the panel can show what is still
    // missing rather than having nothing to render.
    expect(rows).toHaveLength(CRYPTO_NETWORKS.length);
    expect(rows.map((r) => r.network)).toEqual([...CRYPTO_NETWORKS]);
    expect(rows.every((r) => r.configured === false)).toBe(true);
    expect(rows.every((r) => r.isActive === false)).toBe(true);
  });

  it('carries the asset/chain labels the panel shows', async () => {
    const rows = await listCryptoAddresses();
    const trc20 = rows.find((r) => r.network === 'USDT_TRC20')!;
    expect(trc20).toMatchObject({ asset: 'USDT', chain: 'TRC20', configured: false });
  });
});

describe('adding an address', () => {
  it('creates the row and marks the network configured', async () => {
    await upsertCryptoAddress(ADMIN, {
      network: 'USDT_TRC20',
      address: TRC20,
      label: 'main tron wallet',
    });

    const rows = await listCryptoAddresses();
    const trc20 = rows.find((r) => r.network === 'USDT_TRC20')!;

    expect(trc20.configured).toBe(true);
    expect(trc20.isActive).toBe(true);
    expect(trc20.address).toBe(TRC20);
    expect(trc20.label).toBe('main tron wallet');
  });

  it('replaces rather than duplicating when a wallet is rotated', async () => {
    await upsertCryptoAddress(ADMIN, { network: 'USDT_TRC20', address: TRC20 });
    await upsertCryptoAddress(ADMIN, { network: 'USDT_TRC20', address: TON_ADDR });

    // A second row for one network would make the served address ambiguous.
    expect(await prisma.cryptoDepositAddress.count({ where: { network: 'USDT_TRC20' } })).toBe(1);
    expect(await prisma.cryptoDepositAddress.count()).toBe(1);

    const { address } = await addressForNetwork('USDT_TRC20');
    expect(address).toBe(TON_ADDR);
  });

  it('refuses a network we cannot generate an address for', async () => {
    await expect(
      upsertCryptoAddress(ADMIN, { network: 'USDT_SOLANA', address: TRC20 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.cryptoDepositAddress.count()).toBe(0);
  });

  it('refuses a blank address — an empty string is not a wallet', async () => {
    await expect(
      upsertCryptoAddress(ADMIN, { network: 'USDT_TRC20', address: '   ' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.cryptoDepositAddress.count()).toBe(0);
  });

  it('refuses an address containing whitespace, which is always a paste accident', async () => {
    await expect(
      upsertCryptoAddress(ADMIN, { network: 'USDT_TRC20', address: 'TXk9Q4mV v8pJ2Qw' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.cryptoDepositAddress.count()).toBe(0);
  });

  it('normalises empty memo/label to null so the panel does not show blanks', async () => {
    const saved = await upsertCryptoAddress(ADMIN, {
      network: 'TON',
      address: TON_ADDR,
      memo: '   ',
      label: '  ',
    });
    expect(saved.memo).toBeNull();
    expect(saved.label).toBeNull();
  });

  it('keeps a memo when the chain needs a destination tag', async () => {
    const saved = await upsertCryptoAddress(ADMIN, {
      network: 'USDT_TON',
      address: TON_ADDR,
      memo: ' 0042 ',
    });
    expect(saved.memo).toBe('0042');
  });
});

describe('retiring a wallet', () => {
  it('takes a network off the deposit screen without losing the address', async () => {
    await upsertCryptoAddress(ADMIN, { network: 'USDT_TRC20', address: TRC20 });

    await setCryptoAddressActive(ADMIN, 'USDT_TRC20', false);

    expect(await listDepositNetworks()).toHaveLength(0);
    // The address is still on file for reconciling what already arrived.
    const stored = await prisma.cryptoDepositAddress.findUniqueOrThrow({
      where: { network: 'USDT_TRC20' },
    });
    expect(stored.address).toBe(TRC20);
    expect(stored.isActive).toBe(false);
  });

  it('puts the network back when re-enabled', async () => {
    await upsertCryptoAddress(ADMIN, { network: 'USDT_TRC20', address: TRC20 });
    await setCryptoAddressActive(ADMIN, 'USDT_TRC20', false);
    await setCryptoAddressActive(ADMIN, 'USDT_TRC20', true);

    expect((await listDepositNetworks()).map((n) => n.network)).toEqual(['USDT_TRC20']);
  });

  it('deletes the row, removing the network for good', async () => {
    await upsertCryptoAddress(ADMIN, { network: 'USDT_TRC20', address: TRC20 });
    await deleteCryptoAddress(ADMIN, 'USDT_TRC20');

    expect(await prisma.cryptoDepositAddress.count()).toBe(0);
    expect(await listDepositNetworks()).toHaveLength(0);
  });

  it('refuses to act on a network that has no address', async () => {
    await expect(setCryptoAddressActive(ADMIN, 'BTC', false)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteCryptoAddress(ADMIN, 'BTC')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('what the depositor is offered', () => {
  it('offers NOTHING when no address is configured — the safe failure', async () => {
    // Not an empty list of addresses on the screen: no screen options at all.
    expect(await listDepositNetworks()).toEqual([]);
  });

  it('offers exactly the configured, active networks, each with its address', async () => {
    await upsertCryptoAddress(ADMIN, { network: 'USDT_TRC20', address: TRC20 });
    await upsertCryptoAddress(ADMIN, { network: 'TON', address: TON_ADDR, label: 'ton main' });
    await upsertCryptoAddress(ADMIN, { network: 'USDT_BEP20', address: '0xAbC123', isActive: false });

    const offered = await listDepositNetworks();

    // Usable order follows the canonical network list.
    expect(offered.map((n) => n.network)).toEqual(['TON', 'USDT_TRC20']);
    expect(offered.find((n) => n.network === 'USDT_TRC20')).toMatchObject({
      asset: 'USDT',
      chain: 'TRC20',
      address: TRC20,
      memo: null,
    });
    // The disabled BEP20 wallet is absent, not blank.
    expect(offered.some((n) => n.network === 'USDT_BEP20')).toBe(false);
  });

  it('hands back one network on demand, carrying its memo', async () => {
    await upsertCryptoAddress(ADMIN, { network: 'USDT_TON', address: TON_ADDR, memo: '0042' });

    const network = await addressForNetwork('USDT_TON');
    expect(network).toMatchObject({ asset: 'USDT', chain: 'TON', address: TON_ADDR, memo: '0042' });
  });

  it('refuses to hand back an address that is not being offered', async () => {
    await expect(addressForNetwork('BTC')).rejects.toBeInstanceOf(NotFoundError);

    await upsertCryptoAddress(ADMIN, { network: 'BTC', address: TRC20, isActive: false });
    await expect(addressForNetwork('BTC')).rejects.toBeInstanceOf(NotFoundError);

    await expect(addressForNetwork('NOT_A_CHAIN')).rejects.toBeInstanceOf(ValidationError);
  });
});
