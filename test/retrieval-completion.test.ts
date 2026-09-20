import { expect, test } from 'bun:test';
import { RetrievalCompletion } from '../src/core/retrieval-completion.ts';
test('sealed selected snapshots are immutable and late child work cannot lend evidence', async () => {
  const parent = new RetrievalCompletion(), child = new RetrievalCompletion();
  const pending = Promise.resolve().then(() => child.complete());
  const snapshot = parent.seal();
  await pending;
  parent.accept(child.seal());
  parent.complete();
  expect(snapshot).toEqual({ completed: false });
  expect(parent.seal()).toBe(snapshot);
  expect(Object.isFrozen(snapshot)).toBe(true);
});
test('only explicitly accepted child evidence counts, including empty data', () => {
  const parent = new RetrievalCompletion(), accepted = new RetrievalCompletion(), discarded = new RetrievalCompletion();
  discarded.complete();
  expect(parent.seal().completed).toBe(false);
  const selected = new RetrievalCompletion();
  accepted.complete(); selected.accept(accepted.seal()); selected.accept(accepted.seal());
  expect(selected.seal()).toEqual({ completed: true });
});
