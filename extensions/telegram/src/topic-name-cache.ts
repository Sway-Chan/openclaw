import fs from "node:fs";
import path from "node:path";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

const MAX_ENTRIES = 2_048;
const TOPIC_NAME_CACHE_STATE_KEY = Symbol.for("openclaw.telegramTopicNameCacheState");

export type TopicEntry = {
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
  closed?: boolean;
  updatedAt: number;
};

type TopicNameStore = Map<string, TopicEntry>;

type TopicNameCacheState = {
  lastUpdatedAt: number;
  persistedPath?: string;
  store?: TopicNameStore;
};

function getTopicNameCacheState(): TopicNameCacheState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[TOPIC_NAME_CACHE_STATE_KEY] as TopicNameCacheState | undefined;
  if (existing) {
    return existing;
  }
  const state: TopicNameCacheState = { lastUpdatedAt: 0 };
  globalStore[TOPIC_NAME_CACHE_STATE_KEY] = state;
  return state;
}

function createTopicNameStore(): TopicNameStore {
  return new Map<string, TopicEntry>();
}

function cacheKey(chatId: number | string, threadId: number | string): string {
  return `${chatId}:${threadId}`;
}

export function resolveTopicNameCachePath(storePath: string): string {
  return `${storePath}.telegram-topic-names.json`;
}

function evictOldest(store: TopicNameStore): void {
  if (store.size <= MAX_ENTRIES) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestTime = Infinity;
  for (const [key, entry] of store) {
    if (entry.updatedAt < oldestTime) {
      oldestTime = entry.updatedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    store.delete(oldestKey);
  }
}

function isTopicEntry(value: unknown): value is TopicEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<TopicEntry>;
  return (
    typeof entry.name === "string" &&
    entry.name.length > 0 &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt)
  );
}

function readPersistedTopicNames(persistedPath: string): TopicNameStore {
  if (!fs.existsSync(persistedPath)) {
    return createTopicNameStore();
  }
  try {
    const raw = fs.readFileSync(persistedPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed)
      .filter(([, value]) => isTopicEntry(value))
      .toSorted(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_ENTRIES);
    return new Map(entries);
  } catch (error) {
    logVerbose(`telegram: failed to read topic-name cache: ${String(error)}`);
    return createTopicNameStore();
  }
}

function getTopicStore(persistedPath?: string): TopicNameStore {
  const state = getTopicNameCacheState();
  if (persistedPath && state.persistedPath !== persistedPath) {
    state.store = readPersistedTopicNames(persistedPath);
    state.persistedPath = persistedPath;
    state.lastUpdatedAt = Math.max(0, ...state.store.values().map((entry) => entry.updatedAt));
  }
  if (!state.store) {
    state.store = createTopicNameStore();
  }
  return state.store;
}

function nextUpdatedAt(): number {
  const state = getTopicNameCacheState();
  const now = Date.now();
  state.lastUpdatedAt = now > state.lastUpdatedAt ? now : state.lastUpdatedAt + 1;
  return state.lastUpdatedAt;
}

function persistTopicStore(persistedPath: string, store: TopicNameStore): void {
  if (store.size === 0) {
    fs.rmSync(persistedPath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(persistedPath), { recursive: true });
  const tempPath = `${persistedPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(Object.fromEntries(store)), "utf-8");
  fs.renameSync(tempPath, persistedPath);
}

export function updateTopicName(
  chatId: number | string,
  threadId: number | string,
  patch: Partial<Omit<TopicEntry, "updatedAt">>,
  persistedPath?: string,
): void {
  const cache = getTopicStore(persistedPath);
  const key = cacheKey(chatId, threadId);
  const existing = cache.get(key);
  const merged: TopicEntry = {
    name: patch.name ?? existing?.name ?? "",
    iconColor: patch.iconColor ?? existing?.iconColor,
    iconCustomEmojiId: patch.iconCustomEmojiId ?? existing?.iconCustomEmojiId,
    closed: patch.closed ?? existing?.closed,
    updatedAt: nextUpdatedAt(),
  };
  if (!merged.name) {
    return;
  }
  cache.set(key, merged);
  evictOldest(cache);
  if (persistedPath) {
    try {
      persistTopicStore(persistedPath, cache);
    } catch (error) {
      logVerbose(`telegram: failed to persist topic-name cache: ${String(error)}`);
    }
  }
}

export function getTopicName(
  chatId: number | string,
  threadId: number | string,
  persistedPath?: string,
): string | undefined {
  const entry = getTopicStore(persistedPath).get(cacheKey(chatId, threadId));
  if (entry) {
    entry.updatedAt = nextUpdatedAt();
  }
  return entry?.name;
}

export function getTopicEntry(
  chatId: number | string,
  threadId: number | string,
  persistedPath?: string,
): TopicEntry | undefined {
  return getTopicStore(persistedPath).get(cacheKey(chatId, threadId));
}

export function clearTopicNameCache(persistedPath?: string): void {
  const cache = getTopicStore(persistedPath);
  cache.clear();
  if (persistedPath) {
    fs.rmSync(persistedPath, { force: true });
  }
}

export function topicNameCacheSize(): number {
  return getTopicStore().size;
}

export function resetTopicNameCacheForTest(): void {
  const state = getTopicNameCacheState();
  state.lastUpdatedAt = 0;
  state.store = undefined;
  state.persistedPath = undefined;
}
