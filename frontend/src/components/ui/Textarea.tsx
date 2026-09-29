import type { TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
  /** Show a character counter when set (maxLength). */
  showCount?: boolean;
}

export function Textarea({ label, hint, error, showCount, className, id, value, maxLength, ...rest }: TextareaProps) {
  const inputId = id ?? (label ? `ta-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);
  const text = typeof value === 'string' ? value : '';
  return (
    <div className={cn('w-full', className)}>
      {label && (
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor={inputId} className="text-sm font-medium">
            {label}
          </label>
          {showCount && maxLength ? (
            <span className="text-xs text-mute">
              {text.length}/{maxLength}
            </span>
          ) : null}
        </div>
      )}
      <textarea
        id={inputId}
        value={value}
        maxLength={maxLength}
        className={cn(
          'w-full min-h-24 rounded-xl border bg-surface px-3.5 py-3 text-[15px] outline-none transition-colors resize-y',
          'placeholder:text-mute/60 focus:border-accent',
          error ? 'border-danger' : 'border-line',
        )}
        {...rest}
      />
      {error ? (
        <p className="text-xs text-danger mt-1">{error}</p>
      ) : hint ? (
        <p className="text-xs text-mute mt-1">{hint}</p>
      ) : null}
    </div>
  );
}
