import { z } from 'zod';

export const jsonObject = z.record(z.string(), z.json());
