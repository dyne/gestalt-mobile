const databaseName = 'codex-relay';
const databaseVersion = 2;
const storeNames = ['settings', 'drafts', 'cursors', 'messages'] as const;

export function openClientDatabase(database: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = database.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      for (const storeName of storeNames) {
        if (!request.result.objectStoreNames.contains(storeName))
          request.result.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function readStore<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T> {
  return requestValue(db.transaction(storeName, 'readonly').objectStore(storeName).get(key));
}

export function writeStore(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  value: unknown,
): Promise<unknown> {
  return requestValue(
    db.transaction(storeName, 'readwrite').objectStore(storeName).put(value, key),
  );
}

export function deleteStore(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<unknown> {
  return requestValue(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key));
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
