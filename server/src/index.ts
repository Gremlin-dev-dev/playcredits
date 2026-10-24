import { createApp } from './app';
import { config } from './config';
import { pool } from './db';
import { log } from './logger';

const server = createApp().listen(config.PORT, () => log('info', `API listening on :${config.PORT}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
}
