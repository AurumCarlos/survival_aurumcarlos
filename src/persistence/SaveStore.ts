import { parseSnapshot, serializeSnapshot, SnapshotError, type WorldSnapshot } from './WorldSnapshot';

export interface SaveRecord {
  slot: string;
  /** World name shown in the save list (older saves have none). */
  name?: string;
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

/** A world's save slot: its id and display name. */
export interface SlotInfo {
  slot: string;
  name: string;
}

/** Menu row: everything but the (large) JSON. */
export type SaveMeta = Omit<SaveRecord, 'json'> & { name: string };

/** Fresh unique slot id for a new world. */
export function newSlotId(now = Date.now()): string {
  return `world-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export const MAX_NAME = 40;
export function cleanName(name: string, fallback: string): string {
  const n = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return n || fallback;
}

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

  async save(snapshot: WorldSnapshot, slot: string | SlotInfo = AUTOSAVE_SLOT): Promise<SaveRecord> {
    const info = typeof slot === 'string' ? { slot, name: '' } : slot;
    const record = toRecord(snapshot, info);
    await this.backend.put(record);
    // The IDB copy is now at least as new; drop the emergency copy so it can't shadow later saves.
    this.clearEmergency(snapshot.savedAt);
    return record;
  }

  /** Synchronous, for `pagehide`. Returns false if storage is full or disabled. */
  emergencySave(snapshot: WorldSnapshot, slot: string | SlotInfo = AUTOSAVE_SLOT): boolean {
    if (!this.sync) return false;
    try {
      const info = typeof slot === 'string' ? { slot, name: '' } : slot;
      this.sync.setItem(EMERGENCY_KEY, JSON.stringify(toRecord(snapshot, info)));
      return true;
    } catch {
      return false; // QuotaExceededError
    }
  }

  /**
   * Every save, newest first, one row per world. An emergency copy (written
   * on page close) replaces its slot's row if it is newer.
   */
  async list(): Promise<SaveMeta[]> {
    const bySlot = new Map<string, SaveRecord>();
    try {
      for (const r of await this.backend.list()) bySlot.set(r.slot, r);
    } catch (err) {
      console.warn('[SaveStore] listing saves failed', err);
    }
    const e = this.readEmergency();
    if (e && (bySlot.get(e.slot)?.savedAt ?? -1) < e.savedAt) bySlot.set(e.slot, e);
    return [...bySlot.values()]
      .sort((a, b) => b.savedAt - a.savedAt)
      .map(({ json: _json, ...meta }) => ({ ...meta, name: displayName(meta) }));
  }

  /** One world's save (the newer of the stored copy and the emergency copy). */
  async load(slot: string): Promise<{ snapshot: WorldSnapshot; record: SaveRecord } | null> {
    let r = await this.backend.get(slot);
    const e = this.readEmergency();
    if (e && e.slot === slot && (!r || e.savedAt > r.savedAt)) r = e;
    if (!r) return null;
    return { snapshot: parseSnapshot(r.json), record: { ...r, name: displayName(r) } };
  }

  async delete(slot: string): Promise<void> {
    await this.backend.delete(slot);
    if (this.readEmergency()?.slot === slot) this.sync?.removeItem(EMERGENCY_KEY);
  }

  async rename(slot: string, name: string): Promise<void> {
    const r = await this.backend.get(slot);
    if (!r) return;
    await this.backend.put({ ...r, name: cleanName(name, displayName(r)) });
  }

  /** Copy a world to a new slot (a branch you can play separately). */
  async duplicate(slot: string, name: string): Promise<SaveMeta | null> {
    const loaded = await this.load(slot);
    if (!loaded) return null;
    const copy = { ...loaded.record, slot: newSlotId(), name: cleanName(name, `${displayName(loaded.record)} (copy)`), savedAt: Date.now() };
    await this.backend.put(copy);
    const { json: _json, ...meta } = copy;
    return meta;
  }

  /** JSON text of a save, for "Export" (download as a file). */
  async exportJson(slot: string): Promise<string | null> {
    const loaded = await this.load(slot);
    return loaded ? JSON.stringify({ name: displayName(loaded.record), save: loaded.record.json }) : null;
  }

  /** Import an exported file as a new world slot. Throws SnapshotError on a bad file. */
  async importJson(text: string): Promise<SaveMeta> {
    let name = 'Imported island';
    let json = text;
    try {
      const o = JSON.parse(text) as { name?: unknown; save?: unknown };
      if (typeof o.save === 'string') {
        json = o.save;
        if (typeof o.name === 'string') name = o.name;
      }
    } catch {
      throw new SnapshotError('That file is not a save (not valid JSON).');
    }
    const snapshot = parseSnapshot(json); // validates
    const record = toRecord(snapshot, { slot: newSlotId(), name: cleanName(name, 'Imported island') });
    await this.backend.put(record);
    const { json: _json, ...meta } = record;
    return { ...meta, name: record.name! };
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
  async latestSummary(): Promise<SaveRecord['summary'] & { savedAt: number; name: string } | null> {
    const latest = await this.loadLatest();
    return latest ? { ...latest.record.summary, savedAt: latest.record.savedAt, name: displayName(latest.record) } : null;
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

function displayName(r: Pick<SaveRecord, 'name' | 'slot' | 'summary'>): string {
  if (r.name) return r.name;
  return r.slot === AUTOSAVE_SLOT ? `Island ${r.summary.seed}` : r.slot;
}

function toRecord(s: WorldSnapshot, info: SlotInfo): SaveRecord {
  return {
    slot: info.slot,
    ...(info.name ? { name: info.name } : {}),
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
