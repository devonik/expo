import type { ReadOnlyGraph } from '@expo/metro/metro/DeltaBundler/types';
import { isResolvedDependency } from '@expo/metro/metro/lib/isResolvedDependency';

import type { AsyncDependencyType } from '../transform-worker/collect-dependencies';

/** Find worker-local split edges that require retaining legacy collection. */
export function findUnsupportedWorkerAsyncDependency(
  entryFile: string,
  graph: ReadOnlyGraph
):
  | {
      workerEntry: string;
      importer: string;
      target: string;
      asyncType: 'async' | 'maybeSync' | 'prefetch';
    }
  | undefined {
  // Reusing legacy worker collection is safe only if it cannot create ordinary
  // async chunks outside the page plan. Scan page and worker realms separately:
  // a module can belong to both, even if its lazy import never runs in practice.
  const pageQueue = [entryFile];
  const pageVisited = new Set<string>();
  const workers: { modulePath: string; workerEntry: string }[] = [];
  for (let index = 0; index < pageQueue.length; index++) {
    const modulePath = pageQueue[index]!;
    if (pageVisited.has(modulePath)) continue;
    pageVisited.add(modulePath);
    const module = graph.dependencies.get(modulePath);
    if (!module) continue;
    for (const dependency of module.dependencies.values()) {
      const asyncType = dependency.data.data.asyncType as AsyncDependencyType | null;
      if (!isResolvedDependency(dependency) || asyncType === 'weak') continue;
      if (asyncType === 'worker') {
        workers.push({
          modulePath: dependency.absolutePath,
          workerEntry: dependency.absolutePath,
        });
      } else {
        pageQueue.push(dependency.absolutePath);
      }
    }
  }

  const workerVisited = new Set<string>();
  for (let index = 0; index < workers.length; index++) {
    const { modulePath, workerEntry } = workers[index]!;
    if (workerVisited.has(modulePath)) continue;
    workerVisited.add(modulePath);
    const module = graph.dependencies.get(modulePath);
    if (!module) continue;
    for (const dependency of module.dependencies.values()) {
      const asyncType = dependency.data.data.asyncType as AsyncDependencyType | null;
      if (!isResolvedDependency(dependency) || asyncType === 'weak') continue;
      if (asyncType === 'async' || asyncType === 'maybeSync' || asyncType === 'prefetch') {
        return {
          workerEntry,
          importer: modulePath,
          target: dependency.absolutePath,
          asyncType,
        };
      }
      workers.push({
        modulePath: dependency.absolutePath,
        workerEntry: asyncType === 'worker' ? dependency.absolutePath : workerEntry,
      });
    }
  }
  return undefined;
}
