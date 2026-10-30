import * as React from 'react';

import { cn } from '../../lib/utils';

export interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  onValueChange?: (value: number) => void;
  onValueCommit?: (value: number) => void;
}

/** Share of the track left of the thumb, for the accent fill (presentation only). */
function fillPercent(value: unknown, min: unknown, max: unknown): string {
  const lo = min === undefined || min === '' ? 0 : Number(min);
  const hi = max === undefined || max === '' ? 100 : Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return '0%';
  // An input without a value sits at the midpoint, like the native control.
  const v = value === undefined || value === null || value === '' ? (lo + hi) / 2 : Number(value);
  if (!Number.isFinite(v)) return '0%';
  const pct = ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100;
  return `${pct}%`;
}

const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, style, onValueChange, onValueCommit, ...props }, ref) => {
    const handleInput = (
      e: React.ChangeEvent<HTMLInputElement> | React.FormEvent<HTMLInputElement>,
    ) => {
      const value = Number((e.target as HTMLInputElement).value);
      onValueChange?.(value);
    };

    const handleCommit = (
      e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>,
    ) => {
      const value = Number((e.target as HTMLInputElement).value);
      onValueCommit?.(value);
    };

    const fillStyle = {
      '--gv-fill': fillPercent(props.value ?? props.defaultValue, props.min, props.max),
      ...style,
    } as React.CSSProperties;

    return (
      <input
        ref={ref}
        type="range"
        className={cn('gv-slider', className)}
        style={fillStyle}
        onInput={handleInput}
        onChange={handleInput}
        onMouseUp={handleCommit}
        onTouchEnd={handleCommit}
        {...props}
      />
    );
  },
);
Slider.displayName = 'Slider';

export { Slider };
