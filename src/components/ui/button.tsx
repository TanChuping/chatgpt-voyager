import * as React from 'react';

import { type VariantProps, cva } from 'class-variance-authority';

import { cn } from '../../lib/utils';

/*
 * Quiet, Apple-like buttons: one filled accent for the primary action, a
 * neutral fill for secondary actions, and ghost for toolbar/icon buttons.
 * Press feedback (scale + spring release) comes from `.gv-btn` in
 * tailwind.css — no ripples, no heavy shadows.
 */
const buttonVariants = cva(
  'gv-btn inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] text-[13px] leading-none font-medium select-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-primary-hover shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_1px_2px_rgba(0,0,0,0.12)]',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-[0_1px_2px_rgba(0,0,0,0.12)]',
        outline: 'bg-well text-fg hover:bg-well-2 active:bg-well-2',
        secondary: 'bg-well text-fg hover:bg-well-2 active:bg-well-2',
        ghost: 'text-fg-2 hover:bg-hover hover:text-fg active:bg-press',
        link: 'text-primary-ink underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 px-3.5',
        sm: 'h-7 rounded-lg px-2.5 text-[12.5px]',
        lg: 'h-9 px-5',
        icon: 'gv-btn--icon h-8 w-8 rounded-lg',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, children, ...props }, ref) => {
    return (
      <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props}>
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
