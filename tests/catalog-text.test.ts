import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateCatalog } from '../src/search.js';
import { childEnvironment } from './isolation.js';

interface Fixture { name: string; text: string; valid: boolean; repeat?: 'limit' | 'over' }
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL('./fixtures/catalog-text.json', import.meta.url), 'utf8'));
// Exhaust the explicitly specified whitespace set and every C0 control.
for (const cp of [0x20, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) {
  fixtures.push({ name: `blank U+${cp.toString(16)}`, text: String.fromCodePoint(cp), valid: false });
}
for (let cp = 0; cp < 32; cp++) {
  fixtures.push({ name: `C0 U+${cp.toString(16)}`, text: `a${String.fromCodePoint(cp)}b`, valid: false });
}
const cases = [128, 256].flatMap(limit => fixtures.map(f => ({ ...f, limit,
  text: f.text.repeat(f.repeat === 'limit' ? limit : f.repeat === 'over' ? limit + 1 : 1),
})));

test('image keys require absolute end, not the position before a final newline', () => {
  assert.throws(() => validateCatalog({ schemaVersion: 1, images: [
    { image: 'linux\n', os: 'linux', architecture: 'arm64', applications: [] },
  ] }));
});

// The Python validators come from a pilot-images checkout beside this repository.
const collector = resolve('../pilot-images/inventory/collect.py');
test('shared scalar metadata corpus: TypeScript and both pilot-images Python validators', { skip: !existsSync(collector) && `no pilot-images checkout at ${collector}` }, () => {
  for (const item of cases) {
    for (const field of item.limit === 128 ? ['id'] : ['name', 'aliases', 'version']) {
      const app = { id: 'app', name: 'App', aliases: [] as string[], version: null as string | null,
        [field]: field === 'aliases' ? [item.text] : item.text };
      const catalog = { schemaVersion: 1, images: [{ image: 'linux', os: 'linux', architecture: 'arm64', applications: [app] }] };
      const check = () => validateCatalog(catalog);
      if (item.valid) assert.doesNotThrow(check, `${field}: ${item.name}`);
      else assert.throws(check, `${field}: ${item.name}`);
    }
  }
  const python = spawnSync('python3', [new URL('./catalog-text-python.py', import.meta.url).pathname], {
    input: JSON.stringify(cases), encoding: 'utf8', env: childEnvironment(),
  });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), { checks: cases.length * 2, validators: 2, provenanceChecks: 4, portableChecks: 4 });
});
