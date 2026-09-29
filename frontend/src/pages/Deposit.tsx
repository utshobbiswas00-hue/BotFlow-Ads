import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Paginated } from '@botflow/shared';

import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';

import type {
  CryptoDepositNetwork,
  DepositRow,
  StarsDepositQuote,
} from '../lib/contracts';

import { formatDateTime, humanize } from '../lib/format';
import { useInvalidateBalance } from '../hooks/useBalance';

import { PageHeader } from '../components/layout/PageHeader';
import { Card, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { StatusBadge } from '../components/ui/StatusBadge';
import { ErrorState } from '../components/ui/EmptyState';
import { ListSkeleton } from '../components/ui/Skeleton';
import { Money } from '../components/ui/Money';
import { Icon } from '../components/ui/icons';

import { showToast } from '../store/uiStore';

/* ------------------------------------------------------------------ *
 * Payment method row
 * ------------------------------------------------------------------ */

function PickRow({
  icon,
  title,
  subtitle,
  fee,
  selected,
  onClick,
}: {
  icon: 'coin' | 'wallet' | 'star';
  title: string;
  subtitle?: string;
  fee?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
        selected ? 'border-brand bg-surface2' : 'border-line'
      }`}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface2 text-mute">
        <Icon name={icon} size={20} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold truncate">
          {title}
        </span>

        {subtitle && (
          <span className="block text-xs text-mute truncate">
            {subtitle}
          </span>
        )}
      </span>

      {fee && (
        <span className="shrink-0 text-xs text-mute">
          {fee}
        </span>
      )}

      {selected ? (
        <span className="shrink-0 h-5 w-5 rounded-full border-2 border-brand flex items-center justify-center">
          <span className="h-2.5 w-2.5 rounded-full bg-brand" />
        </span>
      ) : (
        <span className="shrink-0 text-mute">
          <Icon name="chevronRight" size={18} />
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Deposit methods
 *
 * ONLY:
 * Crypto
 * Telegram Stars
 * ------------------------------------------------------------------ */

type Rail = 'crypto' | 'stars';

const RAILS: {
  value: Rail;
  title: string;
  subtitle: string;
  fee: string;
  icon: 'coin' | 'star';
}[] = [
  {
    value: 'crypto',
    title: 'Crypto',
    subtitle: 'USDT · TON · BTC',
    fee: 'No fee',
    icon: 'coin',
  },
  {
    value: 'stars',
    title: 'Telegram Stars',
    subtitle: 'Paid inside Telegram',
    fee: 'Fee 48%',
    icon: 'star',
  },
];

/* ------------------------------------------------------------------ *
 * Telegram Stars packages
 *
 * 3,078 Stars = 20 USDT
 * 6,154 Stars = 40 USDT
 * etc.
 *
 * These values are based on the current 80 Stars = $1 gross rate
 * and the 48% Telegram fee configured in the system.
 * ------------------------------------------------------------------ */

const STAR_PRESETS: {
  stars: number;
  usdt: number;
}[] = [
  {
    stars: 3078,
    usdt: 20,
  },
  {
    stars: 6154,
    usdt: 40,
  },
  {
    stars: 9231,
    usdt: 60,
  },
  {
    stars: 12308,
    usdt: 80,
  },
  {
    stars: 15385,
    usdt: 100,
  },
  {
    stars: 30770,
    usdt: 200,
  },
  {
    stars: 76925,
    usdt: 500,
  },
  {
    stars: 153850,
    usdt: 1000,
  },
];

/* ------------------------------------------------------------------ *
 * Quote
 * ------------------------------------------------------------------ */

function QuoteLine({
  grossCents,
  creditedCents,
  feeBps,
}: {
  grossCents: number;
  creditedCents: number;
  feeBps: number;
}) {
  const feePercent = feeBps / 100;

  return (
    <div className="rounded-xl bg-surface2 p-3 space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-mute">
          You pay
        </span>

        <span className="font-semibold">
          <Money cents={grossCents} />
        </span>
      </div>

      {feeBps > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-mute">
            Payment fee ({feePercent}%)
          </span>

          <span className="text-danger">
            −
            <Money cents={grossCents - creditedCents} />
          </span>
        </div>
      )}

      <div className="flex items-center justify-between text-sm border-t border-line pt-1">
        <span className="text-mute">
          Added to your balance
        </span>

        <span className="font-semibold text-success">
          <Money cents={creditedCents} />
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Crypto Deposit
 * ------------------------------------------------------------------ */

function CryptoFlow() {
  const [selected, setSelected] = useState('');

  const networks = useQuery({
    queryKey: qk.cryptoNetworks,

    queryFn: (): Promise<CryptoDepositNetwork[]> =>
      api.get<CryptoDepositNetwork[]>(
        '/api/deposits/crypto-networks',
      ),
  });

  if (networks.isLoading) {
    return <ListSkeleton rows={2} />;
  }

  if (networks.isError) {
    return (
      <ErrorState
        message={errMsg(networks.error)}
        onRetry={() => void networks.refetch()}
      />
    );
  }

  if (!networks.data || networks.data.length === 0) {
    return (
      <p className="text-sm text-mute">
        Crypto deposits are not open yet.
      </p>
    );
  }

  const current =
    networks.data.find(
      (n) => n.network === selected,
    ) ?? networks.data[0];

  if (!current) {
    return null;
  }

  const copy = (value: string): void => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        showToast(
          'success',
          'Address copied',
        );
      })
      .catch(() => {
        showToast(
          'error',
          'Could not copy — please copy it manually',
        );
      });
  };

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">
        Network
      </p>

      <div className="space-y-2">
        {networks.data.map(
          (network) => (
            <PickRow
              key={network.network}
              icon="coin"
              title={network.asset}
              subtitle={network.chain}
              selected={
                network.network ===
                current.network
              }
              onClick={() =>
                setSelected(
                  network.network,
                )
              }
            />
          ),
        )}
      </div>

      <div className="rounded-xl border border-line p-3 space-y-2">
        <p className="text-xs text-mute">
          Send only{' '}
          <strong>
            {current.asset}
          </strong>{' '}
          on{' '}
          <strong>
            {current.chain}
          </strong>{' '}
          to this address.
        </p>

        <p className="font-mono text-[13px] break-all">
          {current.address}
        </p>

        {current.memo && (
          <p className="text-xs">
            <span className="text-mute">
              Memo / tag:
            </span>{' '}
            <span className="font-mono">
              {current.memo}
            </span>
          </p>
        )}

        <Button
          size="sm"
          onClick={() =>
            copy(current.address)
          }
        >
          Copy address
        </Button>
      </div>

      <p className="text-[11px] text-mute">
        Sending a different asset, or the right
        asset on the wrong chain, cannot be
        recovered. Keep the transaction hash if
        your balance does not update.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Telegram Stars Deposit
 * ------------------------------------------------------------------ */

function StarsFlow() {
  const qc = useQueryClient();

  const invalidateBalance =
    useInvalidateBalance();

  const [stars, setStars] =
    useState('3078');

  const [quote, setQuote] =
    useState<StarsDepositQuote | null>(
      null,
    );

  const [formError, setFormError] =
    useState<string | null>(null);

  const create = useMutation({
    mutationFn: (
      count: number,
    ): Promise<StarsDepositQuote> =>
      api.post<StarsDepositQuote>(
        '/api/deposits/stars',
        {
          stars: count,
        },
      ),

    onSuccess: (result) => {
      setQuote(result);

      void qc.invalidateQueries({
        queryKey: qk.deposits,
      });

      invalidateBalance();
    },

    onError: (error) => {
      setQuote(null);

      setFormError(
        errMsg(error),
      );
    },
  });

  if (quote) {
    return (
      <div className="space-y-3">
        <QuoteLine
          grossCents={
            quote.grossCents
          }
          creditedCents={
            quote.creditedCents
          }
          feeBps={
            quote.feeBps
          }
        />

        <p className="text-sm">
          Telegram has sent you an
          invoice for{' '}
          <strong>
            {quote.stars.toLocaleString()} Stars
          </strong>
          . Open your Telegram chat
          with the bot to pay it.
        </p>

        <p className="text-[11px] text-mute">
          Telegram keeps its commission
          from the Stars, so the amount
          credited can be less than the
          Stars you send.
        </p>

        <Button
          size="sm"
          onClick={() =>
            setQuote(null)
          }
        >
          Start again
        </Button>
      </div>
    );
  }

  const submit = (): void => {
    const count = Math.round(
      Number(stars),
    );

    if (
      !Number.isInteger(count) ||
      count < 3078
    ) {
      setFormError(
        'Minimum deposit is 3,078 Telegram Stars (20 USDT)',
      );

      return;
    }

    setFormError(null);

    create.mutate(count);
  };

  return (
    <div className="space-y-3">
      {/* Minimum deposit */}
      <div className="rounded-xl border border-line bg-surface2 p-3">
        <p className="text-sm font-semibold">
          Minimum Deposit
        </p>

        <p className="text-sm text-mute mt-1">
          ⭐ 3,078 Stars = 20 USDT
        </p>
      </div>

      {/* Stars packages */}
      <div className="space-y-2">
        <p className="text-sm font-semibold">
          Select Deposit Amount
        </p>

        {STAR_PRESETS.map(
          (item) => (
            <button
              key={item.stars}
              type="button"
              onClick={() => {
                setStars(
                  String(item.stars),
                );

                setFormError(null);
              }}
              className={`flex w-full items-center justify-between rounded-xl border p-3 text-left transition-colors ${
                Number(stars) ===
                item.stars
                  ? 'border-brand bg-surface2'
                  : 'border-line'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">
                  ⭐
                </span>

                <span>
                  <span className="block text-sm font-semibold">
                    {item.stars.toLocaleString()} Stars
                  </span>

                  <span className="block text-xs text-mute">
                    Telegram Stars
                  </span>
                </span>
              </div>

              <span className="text-sm font-bold text-success">
                {item.usdt} USDT
              </span>
            </button>
          ),
        )}
      </div>

      {/* Custom amount */}
      <Input
        label="Custom Stars"
        type="number"
        inputMode="numeric"
        min={3078}
        step="1"
        value={stars}
        onChange={(e) => {
          setStars(
            e.target.value,
          );

          setFormError(null);
        }}
        hint="Minimum 3,078 Stars"
      />

      {formError && (
        <div className="flex items-center gap-2 text-sm text-danger">
          <Icon
            name="alert"
            size={16}
          />

          {formError}
        </div>
      )}

      <Button
        full
        size="lg"
        loading={
          create.isPending
        }
        onClick={submit}
      >
        Create Stars Invoice
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Deposit Page
 * ------------------------------------------------------------------ */

export function DepositPage() {
  const [rail, setRail] =
    useState<Rail>('crypto');

  const history = useQuery({
    queryKey: [
      ...qk.deposits,
      {
        page: 1,
        limit: 10,
      },
    ],

    queryFn: (): Promise<
      Paginated<DepositRow>
    > =>
      api.get<
        Paginated<DepositRow>
      >(
        '/api/deposits',
        {
          page: 1,
          limit: 10,
        },
      ),
  });

  return (
    <>
      <PageHeader
        title="Deposit"
        back
      />

      <div className="space-y-4 mt-2">
        <Card className="space-y-4">
          <CardTitle>
            Deposit
          </CardTitle>

          {/* Only Crypto + Telegram Stars */}
          <div className="space-y-2">
            {RAILS.map(
              (item) => (
                <PickRow
                  key={item.value}
                  icon={item.icon}
                  title={item.title}
                  subtitle={
                    item.subtitle
                  }
                  fee={item.fee}
                  selected={
                    rail ===
                    item.value
                  }
                  onClick={() =>
                    setRail(
                      item.value,
                    )
                  }
                />
              ),
            )}
          </div>

          {rail === 'crypto' && (
            <CryptoFlow />
          )}

          {rail === 'stars' && (
            <StarsFlow />
          )}
        </Card>

        {/* Deposit History */}
        <div>
          <CardTitle>
            Deposit History
          </CardTitle>

          {history.isLoading ? (
            <ListSkeleton rows={3} />
          ) : history.isError ? (
            <ErrorState
              message={errMsg(
                history.error,
              )}
              onRetry={() =>
                void history.refetch()
              }
            />
          ) : history.data &&
            history.data.items.length >
              0 ? (
            <Card
              padded={false}
              className="divide-y divide-line"
            >
              {history.data.items.map(
                (deposit) => (
                  <div
                    key={deposit.id}
                    className="flex items-center justify-between gap-3 p-3.5"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">
                        <Money
                          cents={
                            deposit.amountCents
                          }
                        />{' '}
                        ·{' '}
                        {humanize(
                          deposit.method,
                        )}
                      </p>

                      <p className="text-xs text-mute">
                        {formatDateTime(
                          deposit.createdAt,
                        )}
                      </p>
                    </div>

                    <StatusBadge
                      status={
                        deposit.status
                      }
                    />
                  </div>
                ),
              )}
            </Card>
          ) : (
            <Card>
              <p className="text-sm text-mute text-center py-4">
                No deposits yet.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
