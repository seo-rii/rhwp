use skia_safe::Picture;
use std::collections::{HashMap, VecDeque};

pub(super) struct BoundedLruCache<K, V>
where
    K: Copy + Eq + std::hash::Hash,
{
    entries: HashMap<K, BoundedLruCacheEntry<V>>,
    order: VecDeque<K>,
    max_entries: usize,
    max_approx_bytes: usize,
    approx_bytes: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct BoundedLruInsertOutcome {
    pub(super) evictions: usize,
    pub(super) skipped_oversized: bool,
}

struct BoundedLruCacheEntry<V> {
    value: V,
    approx_bytes: usize,
}

impl<K, V> BoundedLruCache<K, V>
where
    K: Copy + Eq + std::hash::Hash,
{
    pub(super) fn new(max_entries: usize, max_approx_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            max_entries,
            max_approx_bytes,
            approx_bytes: 0,
        }
    }

    pub(super) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(super) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub(super) fn contains_key(&self, key: &K) -> bool {
        self.entries.contains_key(key)
    }

    pub(super) fn approx_bytes(&self) -> usize {
        self.approx_bytes
    }

    pub(super) fn set_limits(&mut self, max_entries: usize, max_approx_bytes: usize) -> usize {
        self.max_entries = max_entries;
        self.max_approx_bytes = max_approx_bytes;
        self.enforce_limits()
    }

    pub(super) fn get_cloned(&mut self, key: K) -> Option<V>
    where
        V: Clone,
    {
        self.get_cloned_if(key, |_| true)
    }

    pub(super) fn get_cloned_if(&mut self, key: K, predicate: impl FnOnce(&V) -> bool) -> Option<V>
    where
        V: Clone,
    {
        let entry = self.entries.get(&key)?;
        if !predicate(&entry.value) {
            return None;
        }
        let value = entry.value.clone();
        self.touch(key);
        Some(value)
    }

    pub(super) fn insert(
        &mut self,
        key: K,
        value: V,
        approx_bytes: usize,
    ) -> BoundedLruInsertOutcome {
        if self.max_entries == 0
            || self.max_approx_bytes == 0
            || approx_bytes > self.max_approx_bytes
        {
            return BoundedLruInsertOutcome {
                evictions: 0,
                skipped_oversized: true,
            };
        }

        if let Some(entry) = self.entries.remove(&key) {
            self.approx_bytes = self.approx_bytes.saturating_sub(entry.approx_bytes);
        }
        self.order.retain(|cached_key| *cached_key != key);

        let mut evictions = self.enforce_room_for(approx_bytes);
        self.entries.insert(
            key,
            BoundedLruCacheEntry {
                value,
                approx_bytes,
            },
        );
        self.approx_bytes = self.approx_bytes.saturating_add(approx_bytes);
        self.order.push_back(key);
        evictions = evictions.saturating_add(self.enforce_limits());
        BoundedLruInsertOutcome {
            evictions,
            skipped_oversized: false,
        }
    }

    fn enforce_room_for(&mut self, approx_bytes: usize) -> usize {
        let mut evictions = 0usize;
        while self.entries.len() >= self.max_entries
            || self.approx_bytes.saturating_add(approx_bytes) > self.max_approx_bytes
        {
            evictions = evictions.saturating_add(self.pop_lru());
            if self.order.is_empty() && self.entries.is_empty() {
                break;
            }
        }
        evictions
    }

    fn enforce_limits(&mut self) -> usize {
        if self.max_entries == 0 || self.max_approx_bytes == 0 {
            let evictions = self.entries.len();
            self.entries.clear();
            self.order.clear();
            self.approx_bytes = 0;
            return evictions;
        }

        let mut evictions = 0usize;
        while self.entries.len() > self.max_entries || self.approx_bytes > self.max_approx_bytes {
            let before_len = self.entries.len();
            evictions = evictions.saturating_add(self.pop_lru());
            if self.entries.len() == before_len {
                break;
            }
        }
        evictions
    }

    fn pop_lru(&mut self) -> usize {
        while let Some(evicted_key) = self.order.pop_front() {
            if let Some(entry) = self.entries.remove(&evicted_key) {
                self.approx_bytes = self.approx_bytes.saturating_sub(entry.approx_bytes);
                return 1;
            }
        }
        let evictions = self.entries.len();
        self.entries.clear();
        self.approx_bytes = 0;
        evictions
    }

    fn touch(&mut self, key: K) {
        if let Some(index) = self.order.iter().position(|cached_key| *cached_key == key) {
            self.order.remove(index);
        }
        self.order.push_back(key);
    }
}

pub(super) struct StaticPictureCache {
    cache: BoundedLruCache<u64, StaticPictureCacheEntry>,
}

#[derive(Clone)]
struct StaticPictureCacheEntry {
    picture: Picture,
    fingerprint: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct StaticPictureCacheKey {
    pub(super) hash: u64,
    pub(super) fingerprint: u64,
}

impl StaticPictureCache {
    pub(super) fn new(max_entries: usize, max_approx_bytes: usize) -> Self {
        Self {
            cache: BoundedLruCache::new(max_entries, max_approx_bytes),
        }
    }

    pub(super) fn len(&self) -> usize {
        self.cache.len()
    }

    pub(super) fn approx_bytes(&self) -> usize {
        self.cache.approx_bytes()
    }

    pub(super) fn get(&mut self, key: StaticPictureCacheKey) -> Option<Picture> {
        self.cache
            .get_cloned_if(key.hash, |entry| entry.fingerprint == key.fingerprint)
            .map(|entry| entry.picture)
    }

    pub(super) fn insert(
        &mut self,
        key: StaticPictureCacheKey,
        picture: Picture,
        approx_bytes: usize,
    ) -> BoundedLruInsertOutcome {
        self.cache.insert(
            key.hash,
            StaticPictureCacheEntry {
                picture,
                fingerprint: key.fingerprint,
            },
            approx_bytes,
        )
    }
}
