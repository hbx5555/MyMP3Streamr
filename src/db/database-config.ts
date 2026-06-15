import 'dotenv/config';
import { z } from 'zod';

const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1)
});

export const databaseConfig = databaseEnvSchema.parse(process.env);
