/** Internal evidence for a selected retrieval result; never serialized. */
export type RetrievalSnapshot = Readonly<{ completed: boolean }>;
export class RetrievalCompletion {
  private completed = false;
  private snapshot?: RetrievalSnapshot;
  complete(): void { if (!this.snapshot) this.completed = true; }
  accept(value: RetrievalSnapshot): void { if (!this.snapshot && value.completed) this.completed = true; }
  seal(): RetrievalSnapshot { return this.snapshot ??= Object.freeze({ completed: this.completed }); }
}
