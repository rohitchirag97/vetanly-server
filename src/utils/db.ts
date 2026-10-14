import { drizzle } from 'drizzle-orm/node-postgres';

import { databaseUrl } from '@/utils/env';

const db = drizzle(databaseUrl);

export default db;
