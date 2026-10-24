import { describe, expect, test } from 'bun:test';
import { checkPackFiles, MAX_UNPACKED_BYTES } from '../utils/npm-pack-guard.js';

const UI = 'src/dashboard/ui/';
const good = [
  'package.json',
  'src/dashboard/server.ts',
  `${UI}dist/index.html`,
  `${UI}dist/_app/index-abc123.js`,
  `${UI}dist-hybrid/hybrid-chat.js`,
];

describe('checkPackFiles', () => {
  test('a tarball with the built dashboard passes', () => {
    expect(checkPackFiles(good, 13_000_000)).toEqual([]);
  });

  test('a tarball without the UI build fails (the 0.10.0 case)', () => {
    const problems = checkPackFiles(['package.json', 'src/dashboard/server.ts', `${UI}src/main.tsx`], 13_000_000);
    expect(problems.join('\n')).toContain('dist/index.html');
    expect(problems.join('\n')).toContain('dist/_app/');
    expect(problems.join('\n')).toContain('dist-hybrid/hybrid-chat.js');
  });

  test('ui/node_modules and tests must not ship', () => {
    expect(checkPackFiles([...good, `${UI}node_modules/react/index.js`], 13_000_000)).toHaveLength(1);
    expect(checkPackFiles([...good, 'src/__tests__/x.test.ts'], 13_000_000)).toHaveLength(1);
  });

  test('oversized tarballs fail', () => {
    expect(checkPackFiles(good, MAX_UNPACKED_BYTES + 1)).toHaveLength(1);
  });
});
