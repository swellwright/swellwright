import { MemoryRunStore } from './memory-store.js';
import { runStoreContract } from './testing/store-contract.js';

runStoreContract('in memory', () => Promise.resolve({ store: new MemoryRunStore() }));
