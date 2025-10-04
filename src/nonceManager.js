export class NonceManager {
  constructor(startNonce=0n) { this.local = startNonce; }
  set(start) { this.local = start; }
  next() { const n = this.local; this.local = n + 1n; return n; }
}
