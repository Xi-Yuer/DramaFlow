import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative w-full rounded-lg border px-3 py-2.5 text-xs flex flex-col gap-1',
  {
    variants: {
      variant: {
        default: 'bg-[#1b1c20] text-foreground border-white/12',
        info: 'border-[#67ded5]/35 bg-[#67ded5]/10 text-[#d3f6f2]',
        warning: 'border-[#e2ba6c]/40 bg-[#e2ba6c]/12 text-[#f3dfb3]',
        destructive: 'border-[#ee777c]/40 bg-[#ee777c]/12 text-[#f9c6c9]',
        success: 'border-[#68cc9a]/40 bg-[#68cc9a]/12 text-[#c5f0da]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5
      ref={ref}
      className={cn('font-semibold leading-snug tracking-tight', className)}
      {...props}
    />
  ),
);
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-xs leading-relaxed opacity-90', className)} {...props} />
  ),
);
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
