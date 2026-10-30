import { createServer } from 'node:http';
import { app } from './app.js';
import { env } from './config.js';
import { connectDatabase, disconnectDatabase } from './db.js';
import { createSocketServer } from './socket.js';

async function start(): Promise<void> {
  await connectDatabase();
  const server = createServer(app);
  createSocketServer(server);
  server.listen(env.PORT, () => console.log(`Apexcare API listening on port ${env.PORT}`));
  const shutdown = async () => { server.close(); await disconnectDatabase(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch((error) => { console.error('API startup failed', error); process.exit(1); });
