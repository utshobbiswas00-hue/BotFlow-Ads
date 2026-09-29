import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { Icon } from './icons';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  prefix?: string;
  icon?: 'search' | 'dollar' | 'user' | 'external';
}

export function Input({ label, hint, error, prefix, icon, className, id, ...rest }: InputProps) {
  const inputId = id ?? (label ? `in-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);
  return (
    <div className={cn('w-full', className)}>
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium mb-1.5">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-mute pointer-events-none">
            <Icon name={icon} size={18} />
          </span>
        )}
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-mute text-sm pointer-events-none">
            {prefix}
          </span>
        )}
        <input
          id={inputId}
          className={cn(
            'w-full h-11 rounded-xl border bg-surface px-3.5 text-[15px] outline-none transition-colors',
            'placeholder:text-mute/60 focus:border-accent',
            icon ? 'pl-10' : undefined,
            prefix ? 'pl-8' : undefined,
            error ? 'border-danger' : 'border-line',
          )}
          {...rest}
        />
      </div>
      {error ? (
        <p className="text-xs text-danger mt-1">{error}</p>
      ) : hint ? (
        <p className="text-xs text-mute mt-1">{hint}</p>
      ) : null}
    </div>
  );
}
