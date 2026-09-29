import type { SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { Icon } from './icons';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
}

export function Select({ label, hint, error, options, placeholder, className, id, ...rest }: SelectProps) {
  const inputId = id ?? (label ? `sel-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);
  return (
    <div className={cn('w-full', className)}>
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium mb-1.5">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          id={inputId}
          className={cn(
            'w-full h-11 appearance-none rounded-xl border bg-surface px-3.5 pr-10 text-[15px] outline-none transition-colors',
            'focus:border-accent',
            error ? 'border-danger' : 'border-line',
          )}
          {...rest}
        >
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-mute pointer-events-none rotate-90">
          <Icon name="chevronRight" size={16} />
        </span>
      </div>
      {error ? (
        <p className="text-xs text-danger mt-1">{error}</p>
      ) : hint ? (
        <p className="text-xs text-mute mt-1">{hint}</p>
      ) : null}
    </div>
  );
}
