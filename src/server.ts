import Fastify from 'fastify';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerAdminRoutes } from './routes/admin.js';
import { hashPassword } from './auth/password.js';
import { ensureAdminUser } from './db/repositories.js';

async function main() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL
    }
  });

  app.decorate('pg', pool);

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    if (reply.sent) return;
    return reply.status(500).send({
      ok: false,
      error: 'Internal Server Error'
    });
  });

  await registerPublicRoutes(app);
  await registerAdminRoutes(app);

  await app.listen({
    host: '0.0.0.0',
    port: config.PORT
  });
}

async function bootstrap() {
  await ensureAdminUser(config.ADMIN_EMAIL, hashPassword(config.ADMIN_PASSWORD));
  await main();
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
