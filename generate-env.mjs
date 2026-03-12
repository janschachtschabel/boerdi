/**
 * generate-env.mjs
 * Reads B_API_KEY (and optionally OPENAI_API_KEY) from the OS environment and
 * writes environment.ts (production) + environment.development.ts (dev).
 *
 * Runs automatically via "prestart" and "prebuild" hooks in package.json.
 * On Vercel: set B_API_KEY as Environment Variable in the project settings.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envDir = join(__dirname, 'src', 'environments');

const apiKey = process.env.B_API_KEY ?? process.env.OPENAI_API_KEY ?? '';

if (!apiKey) {
  console.warn(
    '⚠️  Weder B_API_KEY noch OPENAI_API_KEY ist gesetzt.\n' +
    '   Auf Vercel: Environment Variable "B_API_KEY" in den Projekt-Einstellungen setzen.'
  );
}

mkdirSync(envDir, { recursive: true });

// Produktions-Environment (ng build ohne --configuration development)
const prodContent = `// AUTO-GENERIERT von generate-env.mjs – nicht einchecken!
export const environment = {
  production: true,
  apiKey: '${apiKey}',
};
`;

// Entwicklungs-Environment (ng serve)
const devContent = `// AUTO-GENERIERT von generate-env.mjs – nicht einchecken!
export const environment = {
  production: false,
  apiKey: '${apiKey}',
};
`;

writeFileSync(join(envDir, 'environment.ts'), prodContent, 'utf-8');
writeFileSync(join(envDir, 'environment.development.ts'), devContent, 'utf-8');

console.log('✅ environment.ts + environment.development.ts geschrieben' + (apiKey ? ' (API-Key gesetzt)' : ' (kein Key)'));
