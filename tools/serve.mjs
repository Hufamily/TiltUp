// Serves the web build at http://localhost:8080 so you can try it like a visitor would.
// --lan also listens on your network, so you can open it on your phone (same Wi-Fi) to test touch controls.
// Usage: npm run build && npm run serve [-- --lan]
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { DIST } from './lib/project.mjs';
import { serve } from './lib/static.mjs';

const WEB = join(DIST, 'web');
if (!existsSync(join(WEB, 'index.html'))) { console.error('No web build yet. Run npm run build first.'); process.exit(1); }
const lan = process.argv.includes('--lan');
await serve(WEB, 8080, lan ? '0.0.0.0' : '127.0.0.1');
console.log('Web build at http://localhost:8080/   (Ctrl+C to stop)');
if (lan) for (const nets of Object.values(networkInterfaces())) for (const n of nets) if (n.family === 'IPv4' && !n.internal) console.log(`On your phone: http://${n.address}:8080/`);
