import { resolve } from 'node:path';
import { createApp } from './app.js';

const clientDir = resolve(process.cwd(), 'dist', 'client');
const port = Number(process.env.PORT || 3000);

const app = createApp(clientDir);

app.listen(port, () => {
  console.log(`MVP app listening on http://localhost:${port}`);
});
