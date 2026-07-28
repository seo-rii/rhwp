import assert from 'node:assert/strict';
import test from 'node:test';

import { LayerResourceStore } from '../src/core/layer-resource-store.ts';

test('internFontBlob deduplicates identical bytes under the same producer key', () => {
  const store = new LayerResourceStore();
  const bytes = Uint8Array.of(0x00, 0x01, 0x00, 0x00, 0x4f, 0x54, 0x54, 0x4f);
  const duplicateBytes = new Uint8Array(bytes);

  const firstId = store.internFontBlob(bytes, 'digest-a', 'font:producer-a');
  const duplicateId = store.internFontBlob(
    duplicateBytes,
    'digest-a',
    'font:producer-a',
  );

  assert.equal(firstId, 0);
  assert.equal(duplicateId, firstId);
  assert.deepEqual(store.resources.fontBlobs, [bytes]);
  assert.deepEqual(store.resources.fontBlobHashes, ['digest-a']);
  assert.deepEqual(store.resources.fontBlobKeys, ['font:producer-a']);

  const stats = store.stats();
  assert.equal(stats.fontBlobCount, 1);
  assert.equal(stats.fontBlobPayloadsImported, 2);
  assert.equal(stats.fontBlobPayloadBytesImported, bytes.byteLength * 2);
});

test('internFontBlob assigns distinct ids when a producer key is reused for different bytes', () => {
  const store = new LayerResourceStore();
  const firstBytes = Uint8Array.of(0x00, 0x01, 0x00, 0x00);
  const replacementBytes = Uint8Array.of(0x4f, 0x54, 0x54, 0x4f);

  const firstId = store.internFontBlob(
    firstBytes,
    'digest-first',
    'font:producer-a',
  );
  const replacementId = store.internFontBlob(
    replacementBytes,
    'digest-replacement',
    'font:producer-a',
  );

  assert.equal(firstId, 0);
  assert.equal(replacementId, 1);
  assert.deepEqual(store.resources.fontBlobs, [firstBytes, replacementBytes]);
  assert.deepEqual(
    store.resources.fontBlobHashes,
    ['digest-first', 'digest-replacement'],
  );
  assert.deepEqual(
    store.resources.fontBlobKeys,
    ['font:producer-a', 'font:producer-a'],
  );
  assert.equal(store.stats().fontBlobCount, 2);
});

test('clear advances tableId and resets font blob arrays and statistics', () => {
  const store = new LayerResourceStore();
  const initialTableId = store.resources.tableId;
  store.internFontBlob(
    Uint8Array.of(0x00, 0x01, 0x00, 0x00),
    'digest-a',
    'font:producer-a',
  );

  store.clear();

  assert.equal(store.resources.tableId, initialTableId + 1);
  assert.deepEqual(store.resources.fontBlobs, []);
  assert.deepEqual(store.resources.fontBlobHashes, []);
  assert.deepEqual(store.resources.fontBlobKeys, []);
  assert.deepEqual(
    {
      tableId: store.stats().tableId,
      fontBlobCount: store.stats().fontBlobCount,
      fontBlobPayloadsImported: store.stats().fontBlobPayloadsImported,
      fontBlobPayloadBytesImported: store.stats().fontBlobPayloadBytesImported,
    },
    {
      tableId: initialTableId + 1,
      fontBlobCount: 0,
      fontBlobPayloadsImported: 0,
      fontBlobPayloadBytesImported: 0,
    },
  );
});
