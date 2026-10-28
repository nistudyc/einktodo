import { copyFile } from 'node:fs/promises';
await copyFile(new URL('./node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', import.meta.url), new URL('./public/webauthn.js', import.meta.url));
