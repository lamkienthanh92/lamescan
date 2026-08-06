// Crash/close recovery. Tiles (image blob + integer position) are the only state
// that matters; the mosaic is rebuilt from them. Written on capture so a closed
// tab, a crash, or a power cut costs at most the last frame instead of the scan.

const DB_NAME = 'panorama-simple-db';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles', { keyPath: 'index' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('tiles', mode);
    const out = fn(t.objectStore('tiles'));
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const saveTile = (rec) => tx('readwrite', (s) => s.put(rec));
export const clearAll = () => tx('readwrite', (s) => s.clear());
export const deleteFrom = (i) => tx('readwrite', (s) => s.delete(IDBKeyRange.lowerBound(i)));
export const countTiles = () => tx('readonly', (s) => s.count());
export const loadAll = async () => {
  const rows = await tx('readonly', (s) => s.getAll());
  return (rows || []).sort((a, b) => a.index - b.index);
};
