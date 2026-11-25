import { MemoryRunStore } from './memory-store.js';
import { runWorkerScenarios } from './testing/worker-scenarios.js';

runWorkerScenarios('in memory', () => Promise.resolve({ store: new MemoryRunStore() }));
