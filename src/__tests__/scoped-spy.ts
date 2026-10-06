import { spyOn } from 'bun:test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
type MockLike = AnyFn & { mock: unknown; getMockImplementation: () => AnyFn | undefined };

function isMock(value: unknown): value is MockLike {
  return (
    typeof value === 'function' &&
    'mock' in value &&
    typeof (value as Partial<MockLike>).getMockImplementation === 'function'
  );
}

/**
 * spyOn + mockImplementation that is safe to undo in a plain `bun test` run.
 *
 * Bun shares one module registry across every test file in a plain run, so a
 * module export may already be another file's mock (a mock.module factory's
 * `mock(() => [])`). spyOn on a mock returns that same mock, and mockRestore()
 * on it wipes its implementation: every later file then gets `undefined` from
 * it (e.g. discoverSkills() -> undefined -> GET /api/skills 500). restore()
 * puts the prior implementation back in that case, and is a normal
 * mockRestore() otherwise.
 */
export function scopedSpy<T extends object, K extends keyof T>(obj: T, key: K, impl: T[K]) {
  const current: unknown = obj[key];
  const prior = isMock(current) ? current.getMockImplementation() : undefined;
  const wasMock = isMock(current);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spy = spyOn(obj as any, key as any).mockImplementation(impl as any);
  return {
    spy,
    restore(): void {
      if (wasMock) spy.mockImplementation(prior ?? (() => undefined));
      else spy.mockRestore();
    },
  };
}
