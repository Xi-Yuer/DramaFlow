'use client';
import { useQuery } from '@tanstack/react-query';
import { identityApi, identityKey } from './identity-api';

export function useIdentity() {
  return useQuery({
    queryKey: identityKey,
    queryFn: identityApi.me,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
