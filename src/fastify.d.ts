import 'fastify';
import type { Pool } from 'pg';

declare module 'fastify' {
  interface FastifyInstance {
    pg: Pool;
  }
}
