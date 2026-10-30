import * as React from 'react';

import { cn } from '../../lib/utils';

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {}

/**
 * Apple-style switch drawn around a real `<input type="checkbox">`, so
 * `checked` / `onChange` / `id` / `disabled` behave exactly like a native
 * checkbox. Styles live in `tailwind.css` (`.gv-switch*`).
 */
const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(({ className, ...props }, ref) => {
  return (
    <label className={cn('gv-switch', className)}>
      <input
        ref={ref}
        type="checkbox"
        role="switch"
        className="gv-switch__input sr-only"
        {...props}
      />
      <span className="gv-switch__track" aria-hidden="true">
        <span className="gv-switch__knob" />
      </span>
    </label>
  );
});
Switch.displayName = 'Switch';

export { Switch };
