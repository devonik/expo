import { buildAsyncRequire } from '../buildAsyncRequire';
import { loadBundleAsync } from '../loadBundle';

export const asMock = <T extends (...args: any[]) => any>(fn: T): jest.MockedFunction<T> =>
  fn as jest.MockedFunction<T>;

jest.mock('../loadBundle', () => ({
  loadBundleAsync: jest.fn(async () => {}),
}));
jest.mock('../buildUrlForBundle', () => ({
  buildUrlForBundle: (path: string) => new URL(path, 'https://example.com/nested/page').href,
}));

const originalEnv = process.env.NODE_ENV;
beforeEach(() => {
  process.env.NODE_ENV = 'development';
  asMock(loadBundleAsync).mockReset().mockResolvedValue();
});

afterAll(() => {
  process.env.NODE_ENV = originalEnv;
});

it(`builds required object`, async () => {
  const asyncRequire = buildAsyncRequire();
  expect(asyncRequire).toBeInstanceOf(Function);
});

it(`loads the module with \`loadBundleAsync\` if the module has not been loaded already`, async () => {
  const asyncRequire = buildAsyncRequire();

  const myModule = asyncRequire('/bacon.bundle?platform=ios');
  expect(myModule).toEqual(expect.any(Promise));

  // Did attempt to fetch the bundle
  expect(loadBundleAsync).toHaveBeenCalledWith('/bacon.bundle?platform=ios');
});

it('loads arrays per file and waits for every file, regardless of completion order', async () => {
  let finishShared!: () => void;
  let finishRoute!: () => void;
  asMock(loadBundleAsync)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishShared = resolve;
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRoute = resolve;
        })
    );
  const loaded = jest.fn();
  const result = buildAsyncRequire()(['/shared.js', '/route.js']).then(loaded);
  expect(asMock(loadBundleAsync).mock.calls).toEqual([['/shared.js'], ['/route.js']]);
  finishRoute();
  await Promise.resolve();
  expect(loaded).not.toHaveBeenCalled();
  finishShared();
  await result;
  expect(loaded).toHaveBeenCalledTimes(1);
});

it('deduplicates pending and fulfilled files across overlapping arrays and scalar requests', async () => {
  let finishShared!: () => void;
  asMock(loadBundleAsync).mockImplementation((path) =>
    path === '/shared.js'
      ? new Promise((resolve) => {
          finishShared = resolve;
        })
      : Promise.resolve()
  );
  const load = buildAsyncRequire();
  const first = load(['/shared.js', '/a.js', '/shared.js']);
  const second = load(['/shared.js', '/b.js']);
  const scalar = load('/shared.js');
  expect(asMock(loadBundleAsync).mock.calls).toEqual([['/shared.js'], ['/a.js'], ['/b.js']]);
  finishShared();
  await Promise.all([first, second, scalar]);
  await load(['/a.js', '/shared.js', '/b.js']);
  expect(loadBundleAsync).toHaveBeenCalledTimes(3);
});

it('retries only a failed file, keeping successful array members cached', async () => {
  const failure = new Error('network error');
  asMock(loadBundleAsync)
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce();
  const load = buildAsyncRequire();
  await expect(load(['/shared.js', '/route.js'])).rejects.toBe(failure);
  await expect(load(['/shared.js', '/route.js'])).resolves.toBeUndefined();
  expect(asMock(loadBundleAsync).mock.calls).toEqual([
    ['/shared.js'],
    ['/route.js'],
    ['/route.js'],
  ]);
});

it('shares a rejection between concurrent callers and evicts it for a scalar retry', async () => {
  const failure = new Error('load failed');
  asMock(loadBundleAsync).mockRejectedValueOnce(failure).mockResolvedValueOnce();
  const load = buildAsyncRequire();
  const first = load(['/shared.js']);
  const second = load('/shared.js');
  await expect(first).rejects.toBe(failure);
  await expect(second).rejects.toBe(failure);
  await expect(load('/shared.js')).resolves.toBeUndefined();
  expect(asMock(loadBundleAsync).mock.calls).toEqual([['/shared.js'], ['/shared.js']]);
});

it('accepts an empty array without making a request', async () => {
  await expect(buildAsyncRequire()([])).resolves.toBeUndefined();
  expect(loadBundleAsync).not.toHaveBeenCalled();
});

it('does not share a cache between loader installations', async () => {
  await buildAsyncRequire()('/route.js');
  await buildAsyncRequire()('/route.js');
  expect(asMock(loadBundleAsync).mock.calls).toEqual([['/route.js'], ['/route.js']]);
});

(process.env.EXPO_OS === 'web' ? describe : describe.skip)('web chunk readiness', () => {
  const originalOs = process.env.EXPO_OS;
  beforeEach(() => {
    process.env.EXPO_OS = 'web';
    process.env.NODE_ENV = 'production';
    delete (globalThis as any).__expo_chunk_completion__;
    asMock(loadBundleAsync).mockImplementation(async (path) => {
      const runtime = globalThis as any;
      const key = `${runtime.__METRO_GLOBAL_PREFIX__ ?? ''}__expo_chunk_completion__`;
      // Simulate the chunk footer.
      runtime[key].add(new URL(path, 'https://example.com/nested/page').href);
    });
  });
  afterEach(() => {
    process.env.EXPO_OS = originalOs;
    delete (globalThis as any).__expo_chunk_completion__;
  });

  it('preserves early footer records and observes later ones without refetching', async () => {
    const ready = new Set(['https://example.com/shared.js']);
    (globalThis as any).__expo_chunk_completion__ = ready;
    const load = buildAsyncRequire();
    expect(load.isReady?.(['/shared.js', '/route.js'])).toBe(false);
    ready.add('https://example.com/route.js');
    expect(load.isReady?.(['/shared.js', '/route.js'])).toBe(true);
    await load(['/shared.js', '/route.js']);
    expect(loadBundleAsync).not.toHaveBeenCalled();
  });

  it('does not call a pending or rejected file ready, and retries it', async () => {
    let reject!: (error: Error) => void;
    asMock(loadBundleAsync).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const load = buildAsyncRequire();
    const pending = load(['/route.js']);
    expect(load.isReady?.(['/route.js'])).toBe(false);
    reject(new Error('failed'));
    await expect(pending).rejects.toThrow('failed');
    expect(load.isReady?.(['/route.js'])).toBe(false);
    await load(['/route.js']);
    expect(load.isReady?.(['/route.js'])).toBe(true);
  });

  it('uses the loader URL, not a differing document base, and retains query strings', async () => {
    (globalThis as any).__expo_chunk_completion__ = new Set(['https://example.com/base/route.js']);
    const load = buildAsyncRequire();
    expect(load.isReady?.(['route.js'])).toBe(false);
    await load(['route.js']);
    expect(loadBundleAsync).toHaveBeenCalledWith('route.js');
    expect(load.isReady?.(['https://example.com/nested/route.js'])).toBe(true);
    expect(load.isReady?.(['route.js?v=2'])).toBe(false);
  });

  it('rejects incomplete registration and retries only the file without a footer', async () => {
    asMock(loadBundleAsync).mockResolvedValueOnce();
    const load = buildAsyncRequire();
    const importAll = jest.fn();
    await expect(load(['/shared.js', '/route.js']).then(importAll)).rejects.toThrow(
      /shared\.js.*did not finish registering/
    );
    expect(importAll).not.toHaveBeenCalled();
    expect(load.isReady?.(['/shared.js'])).toBe(false);
    expect(load.isReady?.(['/route.js'])).toBe(true);

    await load(['/shared.js', '/route.js']).then(importAll);
    expect(importAll).toHaveBeenCalledTimes(1);
    expect(asMock(loadBundleAsync).mock.calls).toEqual([
      ['/shared.js'],
      ['/route.js'],
      ['/shared.js'],
    ]);
  });

  it('does not promote a fulfilled scalar load into array readiness', async () => {
    asMock(loadBundleAsync).mockResolvedValueOnce();
    const load = buildAsyncRequire();
    await load('/route.js');
    expect(load.isReady?.(['/route.js'])).toBe(false);
    await expect(load(['/route.js'])).rejects.toThrow(/did not finish registering/);
    await load(['/route.js']);
    expect(load.isReady?.(['/route.js'])).toBe(true);
    expect(loadBundleAsync).toHaveBeenCalledTimes(2);
  });

  it('rejects concurrent incomplete loads and caches a successful retry', async () => {
    asMock(loadBundleAsync).mockResolvedValueOnce();
    const load = buildAsyncRequire();
    const first = load(['/route.js']).catch(() => load(['/route.js']));
    const second = load(['/route.js']);
    await expect(second).rejects.toThrow(/did not finish registering/);
    await first;
    await load(['/route.js']);
    expect(load.isReady?.(['/route.js'])).toBe(true);
    expect(loadBundleAsync).toHaveBeenCalledTimes(2);
  });

  it('isolates Metro prefixes', async () => {
    const runtime = globalThis as any;
    const previous = runtime.__METRO_GLOBAL_PREFIX__;
    try {
      runtime.__METRO_GLOBAL_PREFIX__ = 'other';
      const other = buildAsyncRequire();
      await other(['/shared.js']);
      expect(other.isReady?.(['/shared.js'])).toBe(true);
      runtime.__METRO_GLOBAL_PREFIX__ = '';
      expect(buildAsyncRequire().isReady?.(['/shared.js'])).toBe(false);
    } finally {
      runtime.__METRO_GLOBAL_PREFIX__ = previous;
      delete runtime.other__expo_chunk_completion__;
    }
  });
});
