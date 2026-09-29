import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { compactNumber, formatMoney } from '../../lib/format';

export interface ChartPoint {
  label: string;
  value: number;
}

export interface LineChartProps {
  data: ChartPoint[];
  /** 'money' formats the tooltip as currency (cents), 'number' as compact count. */
  kind?: 'money' | 'number';
  currency?: string;
  height?: number;
  color?: string;
}

function fmt(v: number, kind: 'money' | 'number', currency?: string): string {
  if (kind === 'money') return formatMoney(v, currency);
  return compactNumber(v);
}

/** Responsive single-series line chart (recharts). */
export function LineChart({ data, kind = 'number', currency, height = 180, color = 'var(--tg-theme-button-color, #2481cc)' }: LineChartProps) {
  if (data.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-sm text-mute" style={{ height }}>
        No data yet
      </div>
    );
  }
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RechartsLineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--tg-theme-outline-color, #e5e7eb)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: 'var(--tg-theme-hint-color, #6b7280)' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            width={44}
            tick={{ fontSize: 10, fill: 'var(--tg-theme-hint-color, #6b7280)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => fmt(v, kind, currency)}
          />
          <Tooltip
            formatter={(value) => [fmt(Number(value), kind, currency), '']}
            labelStyle={{ color: 'var(--tg-theme-text-color, #111827)', fontWeight: 600 }}
            contentStyle={{
              borderRadius: 12,
              border: '1px solid var(--tg-theme-outline-color, #e5e7eb)',
              background: 'var(--tg-theme-secondary-bg-color, #fff)',
              fontSize: 12,
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </RechartsLineChart>
      </ResponsiveContainer>
    </div>
  );
}
