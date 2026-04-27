// db.js — IndexedDB helper for storing meeting audio and metadata

const DB_NAME = 'TelemostRecorder';
const DB_VERSION = 1;
const STORE = 'meetings';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbSaveMeeting(meeting) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(meeting);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = (e) => {
      db.close();
      reject(e.target.error);
    };
  });
}

async function dbGetMeeting(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => {
      const result = req.result;
      db.close();
      resolve(result);
    };
    req.onerror = (e) => {
      db.close();
      reject(e.target.error);
    };
  });
}

async function dbGetAllMeetings() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const result = (req.result || []).reverse();
      db.close();
      resolve(result);
    };
    req.onerror = (e) => {
      db.close();
      reject(e.target.error);
    };
  });
}
