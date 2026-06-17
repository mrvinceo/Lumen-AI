const DB_NAME = "lumen-media-cache";
const DB_VERSION = 1;
const STORE_NAME = "media-files";

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event: any) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = (event: any) => {
      resolve(event.target.result);
    };

    request.onerror = (event: any) => {
      reject(event.target.error);
    };
  });

  return dbPromise;
}

export interface CachedFile {
  id: string; // msgTimeKey_fileIndex
  data: string; // base64
  mimeType: string;
  name: string;
}

export async function saveCachedFile(id: string, data: string, mimeType: string, name: string): Promise<void> {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({ id, data, mimeType, name });

      request.onsuccess = () => resolve();
      request.onerror = () => reject();
    });
  } catch (err) {
    console.error("Failed to save to IndexedDB:", err);
  }
}

export async function getCachedFile(id: string): Promise<CachedFile | null> {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onsuccess = (e: any) => resolve(e.target.result || null);
      request.onerror = () => reject(null);
    });
  } catch (err) {
    console.error("Failed to read from IndexedDB:", err);
    return null;
  }
}

export function getMsgTimeKey(msg: any): string {
  if (!msg || !msg.createdAt) return "";
  if (msg.createdAt.toDate) {
    return msg.createdAt.toDate().getTime().toString();
  }
  if (msg.createdAt instanceof Date) {
    return msg.createdAt.getTime().toString();
  }
  if (typeof msg.createdAt === "number") {
    return msg.createdAt.toString();
  }
  if (msg.createdAt.seconds) {
    return (msg.createdAt.seconds * 1000).toString();
  }
  return "";
}
