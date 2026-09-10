import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every secret below is decided when its module is first evaluated, so the
 * guard can only be observed from a fresh process. These spawn one, with the
 * environment a real deployment would have, and read what it says.
 */
async function bootWith(env, source) {
  const { stdout } = await run(process.execPath, ['-e', source], {
    cwd: backendDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env
    }
  });
  return stdout.trim();
}

const REPORT = (specifier, call = '') => `
  import('${specifier}')
    .then(async (m) => { ${call} console.log('BOOTED'); })
    .catch((error) => console.log('REFUSED: ' + error.message));
`;

/**
 * `install.sh` and the Dockerfile both set APP_ENV, so the supported paths were
 * covered. An install started outside them with only the conventional
 * NODE_ENV=production fell through to the fallback secret — a constant in this
 * repository — and signed operator sessions with it, which means anyone able
 * to read the source could mint an administrator token for that deployment.
 */
describe('a production process refuses the built-in fallback secret', () => {
  const cases = [
    {
      what: 'the operator session secret',
      specifier: './src/middleware/auth.js',
      call: '',
      clear: ['JWT_SECRET'],
      expect: /JWT_SECRET must be set/
    },
    {
      what: 'the customer portal session secret',
      specifier: './src/middleware/portalAuth.js',
      call: '',
      clear: ['JWT_SECRET', 'PORTAL_JWT_SECRET'],
      expect: /must be set in production/
    },
    {
      what: 'the WhatsApp media link key',
      specifier: './src/utils/wa/waMediaToken.js',
      // Derived lazily, so the guard only runs when a link is signed.
      call: 'm.sign(1);',
      clear: ['JWT_SECRET'],
      expect: /JWT_SECRET must be set/
    },
    {
      what: 'the stored-secret encryption key',
      specifier: './src/utils/secretBox.js',
      call: "m.createSecretBox('probe');",
      clear: ['JWT_SECRET', 'SECRET_BOX_KEY'],
      expect: /must be set/
    }
  ];

  for (const { what, specifier, call, clear, expect } of cases) {
    for (const variable of ['APP_ENV', 'NODE_ENV']) {
      it(`refuses to sign ${what} under ${variable}=production`, async () => {
        const env = { [variable]: 'production' };
        for (const name of clear) delete env[name];
        const output = await bootWith(env, REPORT(specifier, call));
        assert.match(output, /^REFUSED: /, `${what} booted on the fallback under ${variable}`);
        assert.match(output, expect);
      });
    }

    it(`still boots ${what} outside production`, async () => {
      const output = await bootWith({}, REPORT(specifier, call));
      assert.equal(output.split('\n').pop(), 'BOOTED');
    });

    it(`boots ${what} in production once a secret is configured`, async () => {
      const secret = 'a'.repeat(48);
      const output = await bootWith(
        { NODE_ENV: 'production', JWT_SECRET: secret },
        REPORT(specifier, call)
      );
      assert.equal(output.split('\n').pop(), 'BOOTED');
    });
  }
});
