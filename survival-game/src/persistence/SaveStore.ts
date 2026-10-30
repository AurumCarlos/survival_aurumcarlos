import { parseSnapshot, serializeSnapshot, SnapshotError, type WorldSnapshot } from './WorldSnapshot';

export interface SaveRecord {
  slot: string;
  savedAt: number;
  version: number;
  /** Small metadata for the menu, readable without parsing the whole save. */
  summary: { day: number; size: number; seed: number; minutes: number };
  /** The snapshot, serialised with JSON.stringify. */
  json: string;
}

export interface SaveBackend {
  readonly kind: 'indexeddb' | 'memory';
  put(r: SaveRecord): Promise<void>;
  get(slot: string): Promise<SaveRecord | undefined>;
  list(): Promise<SaveRecord[]>;
  delete(slot: string): Promise<void>;
}

const DB_NAME = 'lowpoly-survival';
const STORE = 'saves';
const EMERGENCY_KEY = 'survival.emergency-save';
export const AUTOSAVE_SLOT = 'autosave';

/** IndexedDB wrapped in promises. One object store keyed by slot name. */
export class IndexedDbBackend implements SaveBackend {
  readonly kind = 'indexeddb' as const;
  private constructor(private readonly db: IDBDatabase) {
    // Another tab upgraded the schema: close so it isn't blocked forever.
    db.onversionchange = () => db.close();
  }

  static open(factory: IDBFactory = indexedDB): Promise<IndexedDbBackend> {
    return new Promise((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'slot' });
      };
      req.onsuccess = () => resolve(new IndexedDbBackend(req.result));
      req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
      req.onblocked = () => reject(new Error('IndexedDB is blocked by another open tab'));
    });
  }

  put(r: SaveRecord): Promise<void> {
    return this.tx('readwrite', (s) => s.put(r)).then(() => undefined);
  }
  get(slot: string): Promise<SaveRecord | undefined> {
    return this.tx('readonly', (s) => s.get(slot)) as Promise<SaveRecord | undefined>;
  }
  list(): Promise<SaveRecord[]> {
    return this.tx('readonly', (s) => s.getAll()) as Promise<SaveRecord[]>;
  }
  delete(slot: string): Promise<void> {
    return this.tx('readwrite', (s) => s.delete(slot)).then(() => undefined);
  }

  /** Resolves when the *transaction* commits, not just the request — a put isn't durable before that. */
  private tx(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(STORE, mode);
      const req = op(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? req.error ?? new Error('IndexedDB transaction failed'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted (quota exceeded?)'));
    });
  }
}

/** Fallback when IndexedDB is unavailable (some private-browsing modes, sandboxed iframes, Node). */
export class MemoryBackend implements SaveBackend {
  readonly kind = 'memory' as const;
  private readonly m = new Map<string, SaveRecord>();
  async put(r: SaveRecord): Promise<void> {
    this.m.set(r.slot, { ...r });
  }
  async get(slot: string): Promise<SaveRecord | undefined> {
    return this.m.get(slot);
  }
  async list(): Promise<SaveRecord[]> {
    return [...this.m.values()];
  }
  async delete(slot: string): Promise<void> {
    this.m.delete(slot);
  }
}

/** Synchronous key-value store for the page-unload save (localStorage in the browser). */
export interface SyncStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/**
 * Save/load façade.
 *
 * Normal saves (manual, autosave, pause menu) go to IndexedDB asynchronously.
 *
 * Refresh/close is the hard case: `pagehide` gives no time for an async
 * IndexedDB transaction to commit, so `emergencySave()` writes the same JSON
 * synchronously to localStorage. On the next boot `loadLatest()` takes
 * whichever of the two is newer, so a refresh never loses more than the
 * current frame.
 */
export class SaveStore {
  private constructor(readonly backend: SaveBackend, private readonly sync: SyncStorage | null) {}

  static async open(opts: { idb?: IDBFactory | null; sync?: SyncStorage | null } = {}): Promise<SaveStore> {
    const sync = opts.sync !== undefined ? opts.sync : safeLocalStorage();
    const idb = opts.idb !== undefined ? opts.idb : typeof indexedDB !== 'undefined' ? indexedDB : null;
    if (idb) {
      try {
        return new SaveStore(await IndexedDbBackend.open(idb), sync);
      } catch (err) {
        console.warn('[SaveStore] IndexedDB unavailable, saves will not survive a reload:', err);
      }
    }
    return new SaveStore(new MemoryBackend(), sync);
  }

  async save(snapshot: WorldSnapshot, slot = AUTOSAVE_SLOT): Promise<SaveRecord> {
    const record = toRecord(snapshot, slot);
    await this.backend.put(record);
    // The IDB copy is now at least as new; drop the emergency copy so it can't shadow later saves.
    this.clearEmergency(snapshot.savedAt);
    return record;
  }

  /** Synchronous, for `pagehide`. Returns false if storage is full or disabled. */
  emergencySave(snapshot: WorldSnapshot): boolean {
    if (!this.sync) return false;
    try {
      this.sync.setItem(EMERGENCY_KEY, JSON.stringify(toRecord(snapshot, AUTOSAVE_SLOT)));
      return true;
    } catch {
      return false; // QuotaExceededError
    }
  }

  /** Newest valid save across IndexedDB and the emergency copy, or null. Corrupt saves are skipped, not fatal. */
  async loadLatest(): Promise<{ snapshot: WorldSnapshot; record: SaveRecord } | null> {
    const candidates: SaveRecord[] = [];
    const e = this.readEmergency();
    if (e) candidates.push(e);
    try {
      candidates.push(...(await this.backend.list()));
    } catch (err) {
      console.warn('[SaveStore] listing saves failed', err);
    }
    candidates.sort((a, b) => b.savedAt - a.savedAt);
    for (const record of candidates) {
      try {
        return { snapshot: parseSnapshot(record.json), record };
      } catch (err) {
        console.warn(`[SaveStore] skipping unreadable save "${record.slot}":`, err instanceof SnapshotError ? err.message : err);
      }
    }
    return null;
  }

  /** Metadata of the newest save, for the "Continue" button. */
  async latestSummary(): Promise<SaveRecord['summary'] & { savedAt: number } | null> {
    const latest = await this.loadLatest();
    return latest ? { ...latest.record.summary, savedAt: latest.record.savedAt } : null;
  }

  async deleteAll(): Promise<void> {
    for (const r of await this.backend.list()) await this.backend.delete(r.slot);
    this.sync?.removeItem(EMERGENCY_KEY);
  }

  private readEmergency(): SaveRecord | null {
    try {
      const raw = this.sync?.getItem(EMERGENCY_KEY);
      return raw ? (JSON.parse(raw) as SaveRecord) : null;
    } catch {
      return null;
    }
  }

  private clearEmergency(olderThanOrEqual: number): void {
    const e = this.readEmergency();
    if (e && e.savedAt <= olderThanOrEqual) this.sync?.removeItem(EMERGENCY_KEY);
  }
}

function toRecord(s: WorldSnapshot, slot: string): SaveRecord {
  return {
    slot,
    savedAt: s.savedAt,
    version: s.version,
    summary: { day: s.summary.day, size: s.map.size, seed: s.map.seed, minutes: Math.round(s.summary.secondsSurvived / 60) },
    json: serializeSnapshot(s),
  };
}

function safeLocalStorage(): SyncStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const k = '__probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    return null;
  }
}
