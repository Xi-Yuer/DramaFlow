'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useProjectWorkspace } from './workspace-context';

export function WorkspaceLink({
  href,
  children,
  className,
  current = false,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  current?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { requestLeave } = useProjectWorkspace();
  return (
    <Link
      href={href}
      className={className}
      aria-current={current ? 'page' : undefined}
      onNavigate={(event) => {
        event.preventDefault();
        if (pathname !== href) requestLeave(() => router.push(href));
      }}
    >
      {children}
    </Link>
  );
}
