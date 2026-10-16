'use client';

import type { ComponentProps } from 'react';
import { Button as AntButton } from 'antd';
import { cn } from '@/lib/utils';

type ButtonProps = Omit<ComponentProps<'button'>, 'color'> & {
  variant?: 'default' | 'secondary' | 'ghost' | 'destructive' | 'outline';
  size?: 'default' | 'sm' | 'lg' | 'icon';
};

/** 保留领域组件使用的简洁接口，交互与视觉统一交给 Ant Design。 */
export function Button({
  className,
  variant = 'default',
  size = 'default',
  type,
  children,
  ...props
}: ButtonProps) {
  return (
    <AntButton
      {...props}
      htmlType={type ?? 'button'}
      icon={size === 'icon' ? children : undefined}
      type={variant === 'default' ? 'primary' : variant === 'ghost' ? 'text' : 'default'}
      danger={variant === 'destructive'}
      size={size === 'sm' ? 'small' : size === 'lg' ? 'large' : 'middle'}
      className={cn(className)}
    >
      {size === 'icon' ? undefined : children}
    </AntButton>
  );
}
