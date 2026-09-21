// Ambient declaration for the one wa-sqlite module the mirror adapter uses that
// upstream's types (src/types/index.d.ts, loaded via the bare 'wa-sqlite'
// import) do not cover. Signatures verified against node_modules/wa-sqlite
// 1.0.0: constructor(directoryPath), isReady promise set in the constructor,
// name getter 'AccessHandlePool', async close() releasing the sync access
// handles, and addCapacity() for pool slots.
declare module 'wa-sqlite/src/examples/AccessHandlePoolVFS.js' {
  import { Base } from 'wa-sqlite/src/VFS.js';

  export class AccessHandlePoolVFS extends Base {
    constructor(directoryPath: string);
    readonly name: string;
    isReady: Promise<void>;
    close(): Promise<void>;
    getCapacity(): number;
    getSize(): number;
    addCapacity(n: number): Promise<number>;
    removeCapacity(n: number): Promise<number>;
  }
}