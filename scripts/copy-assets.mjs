import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/src/web/ui', { recursive: true });
cpSync('src/web/ui', 'dist/src/web/ui', { recursive: true });
