import type { MixedOutput, Module, ReadOnlyGraph } from '@expo/metro/metro/DeltaBundler/types';
import { isResolvedDependency } from '@expo/metro/metro/lib/isResolvedDependency';

import type { AsyncDependencyType } from '../transform-worker/collect-dependencies';

export type BitSet = bigint;
type GraphModule = Module<MixedOutput>;

function validateBits(bits: BitSet): void {
  if (bits < 0n) throw new Error('BitSet operations require a non-negative value.');
}

function validateIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('BitSet indices and counts must be a non-negative safe integer.');
  }
}

export function addBit(bits: BitSet, index: number): BitSet {
  validateBits(bits);
  validateIndex(index);
  return bits | (1n << BigInt(index));
}

export function removeBit(bits: BitSet, index: number): BitSet {
  validateBits(bits);
  validateIndex(index);
  return bits & ~(1n << BigInt(index));
}

export function hasBit(bits: BitSet, index: number): boolean {
  validateBits(bits);
  validateIndex(index);
  return (bits & (1n << BigInt(index))) !== 0n;
}

export function allBits(count: number): BitSet {
  validateIndex(count);
  return (1n << BigInt(count)) - 1n;
}

export function* bitIndices(bits: BitSet): IterableIterator<number> {
  validateBits(bits);
  for (let index = 0; bits !== 0n; index++, bits >>= 1n) {
    if ((bits & 1n) !== 0n) yield index;
  }
}

export interface PlannerEntrypoint {
  readonly module: GraphModule;
  readonly kind: 'initial' | 'dynamic';
}

export interface BitSetGraphAnalysis {
  readonly entrypoints: readonly PlannerEntrypoint[];
  readonly dependentEntriesByModule: ReadonlyMap<GraphModule, BitSet>;
  readonly importerEntriesByDynamicEntry: readonly BitSet[];
  readonly dynamicImportsByEntry: readonly BitSet[];
  readonly workerEntries: readonly GraphModule[];
}

/** An ownership group, not yet an emitted file or semantic entry facade. */
export interface ChunkAtom {
  readonly dependentEntries: BitSet;
  readonly modules: ReadonlySet<GraphModule>;
}

export interface BitSetChunkPlan extends BitSetGraphAnalysis {
  readonly rawAtoms: readonly ChunkAtom[];
  /** These masks index rawAtoms, not entrypoints or normalized chunks. */
  readonly staticAtoms: readonly BitSet[];
  readonly alreadyLoadedAtoms: readonly BitSet[];
  readonly chunks: readonly ChunkAtom[];
  readonly chunkByModule: ReadonlyMap<GraphModule, ChunkAtom>;
  /** Full physical ownership requirements, before facades or caller-specific omissions. */
  readonly requiredChunksByEntryPath: ReadonlyMap<string, readonly ChunkAtom[]>;
}

function groupModulesByOwners(owners: ReadonlyMap<GraphModule, BitSet>): ChunkAtom[] {
  const groups = new Map<BitSet, GraphModule[]>();
  for (const [module, bits] of owners) {
    let modules = groups.get(bits);
    if (!modules) {
      modules = [];
      groups.set(bits, modules);
    }
    modules.push(module);
  }
  return [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dependentEntries, modules]) => ({
      dependentEntries,
      modules: new Set(modules.sort(compareModules)),
    }));
}

/** Plan ownership without constructing legacy Chunk objects or serializing code. */
export function computeBitSetChunkPlan(
  initialEntries: readonly GraphModule[],
  graph: ReadOnlyGraph,
  options: { isLazyBundle: boolean }
): BitSetChunkPlan {
  const analysis = analyzeBitSetGraph(initialEntries, graph, options);
  const {
    entrypoints,
    dependentEntriesByModule,
    importerEntriesByDynamicEntry,
    dynamicImportsByEntry,
  } = analysis;
  const rawAtoms = groupModulesByOwners(dependentEntriesByModule);
  const staticAtoms = entrypoints.map(() => 0n);
  for (const [atomIndex, atom] of rawAtoms.entries()) {
    const atomMask = 1n << BigInt(atomIndex);
    for (const entryIndex of bitIndices(atom.dependentEntries)) {
      staticAtoms[entryIndex] = staticAtoms[entryIndex]! | atomMask;
    }
  }

  const universe = allBits(rawAtoms.length);
  const alreadyLoadedAtoms = entrypoints.map((entry) => (entry.kind === 'initial' ? 0n : universe));
  const pending = new Set<number>();
  for (const [index, entry] of entrypoints.entries()) {
    if (entry.kind === 'initial') continue;
    // Root-based discovery guarantees a finite importer path from an initial entry.
    // Merely having an importer is not enough: a disconnected cycle has importers too.
    if (importerEntriesByDynamicEntry[index] === 0n) {
      throw new Error(
        `BitSet dynamic entry ${entry.module.path} has no importer. Check root-based entry discovery.`
      );
    }
    pending.add(index);
  }
  // Deleting before visiting descendants lets a later change enqueue this entry again.
  // Availability only shrinks, including across dynamic cycles.
  for (const entryIndex of pending) {
    pending.delete(entryIndex);
    let updated = universe;
    for (const importerIndex of bitIndices(importerEntriesByDynamicEntry[entryIndex]!)) {
      updated &= staticAtoms[importerIndex]! | alreadyLoadedAtoms[importerIndex]!;
    }
    if (updated === alreadyLoadedAtoms[entryIndex]) continue;
    alreadyLoadedAtoms[entryIndex] = updated;
    for (const descendant of bitIndices(dynamicImportsByEntry[entryIndex]!))
      pending.add(descendant);
  }

  const normalizedOwners = new Map<GraphModule, BitSet>();
  const rawOwnersByNormalizedOwners = new Map<BitSet, BitSet>();
  for (const [atomIndex, atom] of rawAtoms.entries()) {
    let owners = atom.dependentEntries;
    for (const entryIndex of bitIndices(owners)) {
      if (hasBit(alreadyLoadedAtoms[entryIndex]!, atomIndex))
        owners = removeBit(owners, entryIndex);
    }
    // The first owner on an initial-root importer path survives: its predecessor
    // neither owns this atom nor already has it. Initial availability is always 0.
    // This does NOT imply that the initial entry must statically own the atom.
    if (owners === 0n) {
      throw new Error(
        `BitSet atom containing ${[...atom.modules][0]!.path} lost every owner. ` +
          'Check initial-root reachability and complete dynamic importer tracking.'
      );
    }
    for (const module of atom.modules) normalizedOwners.set(module, owners);
    rawOwnersByNormalizedOwners.set(
      owners,
      (rawOwnersByNormalizedOwners.get(owners) ?? 0n) | atom.dependentEntries
    );
  }

  const chunks = groupModulesByOwners(normalizedOwners);
  const chunkByModule = new Map<GraphModule, ChunkAtom>();
  const requiredByEntry = entrypoints.map(() => [] as ChunkAtom[]);
  for (const chunk of chunks) {
    for (const module of chunk.modules) {
      chunkByModule.set(module, chunk);
    }
    for (const entryIndex of bitIndices(rawOwnersByNormalizedOwners.get(chunk.dependentEntries)!)) {
      requiredByEntry[entryIndex]!.push(chunk);
    }
  }
  return {
    ...analysis,
    rawAtoms,
    staticAtoms,
    alreadyLoadedAtoms,
    chunks,
    chunkByModule,
    requiredChunksByEntryPath: new Map(
      entrypoints.map((entry, index) => [entry.module.path, requiredByEntry[index]!])
    ),
  };
}

function compareModules(a: GraphModule, b: GraphModule): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Analyze only the page realm of a complete export graph, without changing it. */
export function analyzeBitSetGraph(
  initialEntries: readonly GraphModule[],
  graph: ReadOnlyGraph,
  { isLazyBundle }: { isLazyBundle: boolean }
): BitSetGraphAnalysis {
  if (isLazyBundle) {
    throw new Error(
      'BitSet chunking requires a complete non-lazy export graph. Disable lazy bundling.'
    );
  }
  if (initialEntries.length === 0) {
    throw new Error('BitSet chunking requires an initial entry. Pass the export entry module.');
  }

  const entriesByPath = new Map<string, PlannerEntrypoint>();
  for (const entry of initialEntries) {
    const module = graph.dependencies.get(entry.path);
    if (!module) {
      throw new Error(
        `BitSet initial entry ${entry.path} is missing. Supply a complete export graph.`
      );
    }
    entriesByPath.set(module.path, { module, kind: 'initial' });
  }

  // Cache resolved page edges once. Weak references do not cause code to load;
  // workers have their own realm and are collected by the existing worker path.
  const edges = new Map<GraphModule, { target: GraphModule; dynamic: boolean }[]>();
  const workerEntries = new Set<GraphModule>();
  const queue = [...entriesByPath.values()].map((entry) => entry.module);
  for (let index = 0; index < queue.length; index++) {
    const module = queue[index]!;
    if (edges.has(module)) continue;
    const moduleEdges: { target: GraphModule; dynamic: boolean }[] = [];
    edges.set(module, moduleEdges);
    for (const dependency of module.dependencies.values()) {
      const asyncType = dependency.data.data.asyncType as AsyncDependencyType | null;
      if (!isResolvedDependency(dependency) || asyncType === 'weak') continue;
      const target = graph.dependencies.get(dependency.absolutePath);
      if (!target) {
        throw new Error(
          `BitSet dependency from ${module.path} to ${dependency.absolutePath} is missing. ` +
            'Production chunking requires a complete export graph; check graph transforms and disable lazy bundling.'
        );
      }
      if (asyncType === 'worker') {
        workerEntries.add(target);
        continue;
      }
      const dynamic = asyncType != null;
      if (dynamic && !entriesByPath.has(target.path)) {
        entriesByPath.set(target.path, { module: target, kind: 'dynamic' });
      }
      moduleEdges.push({ target, dynamic });
      queue.push(target);
    }
  }

  const entrypoints = [...entriesByPath.values()].sort((a, b) =>
    compareModules(a.module, b.module)
  );
  const entryIndexByPath = new Map(entrypoints.map((entry, index) => [entry.module.path, index]));
  const dependentEntriesByModule = new Map<GraphModule, BitSet>();
  for (const [entryIndex, entry] of entrypoints.entries()) {
    const pending = [entry.module];
    const entryMask = 1n << BigInt(entryIndex);
    for (let index = 0; index < pending.length; index++) {
      const module = pending[index]!;
      const owners = dependentEntriesByModule.get(module) ?? 0n;
      if ((owners & entryMask) !== 0n) continue;
      dependentEntriesByModule.set(module, owners | entryMask);
      for (const edge of edges.get(module)!) {
        if (!edge.dynamic) pending.push(edge.target);
      }
    }
  }

  const importerEntriesByDynamicEntry = entrypoints.map(() => 0n);
  const dynamicImportsByEntry = entrypoints.map(() => 0n);
  for (const [module, moduleEdges] of edges) {
    const importerBits = dependentEntriesByModule.get(module)!;
    for (const edge of moduleEdges) {
      if (!edge.dynamic) continue;
      const targetIndex = entryIndexByPath.get(edge.target.path)!;
      // An initial entry always keeps its kind, even when dynamically imported.
      if (entrypoints[targetIndex]!.kind === 'initial') continue;
      importerEntriesByDynamicEntry[targetIndex] =
        importerEntriesByDynamicEntry[targetIndex]! | importerBits;
      for (const importerIndex of bitIndices(importerBits)) {
        dynamicImportsByEntry[importerIndex] = addBit(
          dynamicImportsByEntry[importerIndex]!,
          targetIndex
        );
      }
    }
  }

  return {
    entrypoints,
    dependentEntriesByModule: new Map(
      [...dependentEntriesByModule].sort(([a], [b]) => compareModules(a, b))
    ),
    importerEntriesByDynamicEntry,
    dynamicImportsByEntry,
    workerEntries: [...workerEntries].sort(compareModules),
  };
}
