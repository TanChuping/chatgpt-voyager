import * as React from 'react';

import { ChevronDown } from 'lucide-react';

import { cn } from '../../lib/utils';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

/** Native `<select>` in a quiet well, with a drawn chevron (presentation only). */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <span className="relative block w-full">
        <select className={cn('gv-field', className)} ref={ref} {...props}>
          {children}
        </select>
        <ChevronDown
          aria-hidden="true"
          strokeWidth={2}
          className={cn(
            'text-fg-3 pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2',
            props.disabled && 'opacity-50',
          )}
        />
      </span>
    );
  },
);
Select.displayName = 'Select';

export { Select };
