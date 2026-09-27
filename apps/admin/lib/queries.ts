'use client';

import type { CompanyDto, PartTypeDto, ProductDto } from '@arnobot/message-schema';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Shared reference-data queries (rarely change, cached for 5 minutes). */
export function usePartTypes() {
  return useQuery({ queryKey: ['part-types'], queryFn: () => api.get<PartTypeDto[]>('/part-types'), staleTime: 300_000 });
}

export function useProducts(enabled = true) {
  return useQuery({ queryKey: ['products', 'all'], queryFn: () => api.get<ProductDto[]>('/products'), staleTime: 300_000, enabled });
}

export function useCompanies(enabled = true) {
  return useQuery({ queryKey: ['companies'], queryFn: () => api.get<CompanyDto[]>('/companies'), staleTime: 300_000, enabled });
}
