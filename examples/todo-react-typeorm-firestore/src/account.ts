import { useCallback, useSyncExternalStore } from "react";

/**
 * Demo accounts. A real app would use the signed-in user's id (e.g. Firebase Auth's `uid`,
 * whose state every tab shares) instead of this switcher.
 */
export const ACCOUNTS = ["alice", "bob"] as const;
export type Account = (typeof ACCOUNTS)[number];

const STORAGE_KEY = "ez-sync-todo-typeorm-account";
const listeners = new Set<() => void>();

function readAccount(): Account {
  const stored = localStorage.getItem(STORAGE_KEY);
  return ACCOUNTS.find((account) => account === stored) ?? ACCOUNTS[0];
}

function subscribe(listener: () => void): () => void {
  // `storage` fires in the other tabs, so every tab switches with the one that changed it.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The current account, shared by every tab. */
export function useAccount(): [Account, (account: Account) => void] {
  const account = useSyncExternalStore(subscribe, readAccount);
  const setAccount = useCallback((next: Account) => {
    localStorage.setItem(STORAGE_KEY, next);
    for (const listener of listeners) listener();
  }, []);
  return [account, setAccount];
}
