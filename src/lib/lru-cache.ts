/** LRU cache backed by Map insertion-order iteration. */
export function createLruCache<V>(maxSize: number) {
  const map = new Map<string, V>();

  return {
    get(key: string): V | undefined {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },

    set(key: string, value: V): void {
      if (map.size >= maxSize) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, value);
    },

    clear(): void {
      map.clear();
    },
  };
}
