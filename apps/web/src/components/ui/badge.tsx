import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight whitespace-nowrap transition-colors',
  {
    variants: {
      variant: {
        default: 'border-primary/35 bg-primary/15 text-primary',
        secondary: 'border-white/10 bg-white/6 text-muted-foreground',
        outline: 'border-border text-foreground',
        processing: 'border-[#67ded5]/35 bg-[#67ded5]/14 text-[#67ded5]',
        warning: 'border-[#e2ba6c]/45 bg-[#e2ba6c]/16 text-[#e2ba6c]',
        success: 'border-[#68cc9a]/38 bg-[#68cc9a]/14 text-[#68cc9a]',
        error: 'border-[#ee777c]/42 bg-[#ee777c]/16 text-[#ee777c]',
      },
    },
    defaultVariants: {
      variant: 'secondary',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
