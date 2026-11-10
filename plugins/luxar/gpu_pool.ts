/**
 * One budget of GPU memory shared by every Luxar layer drawing into one
 * WebGL context: Neuroglancer's (the 3-D view, `POOL_3D`) and the 2-D
 * views' shared one (./shared2d.ts).  Before, each layer had its own
 * budgets (768 MB + 512 MB in the 3-D view, 512 MB + 384 MB in its own
 * 2-D context), so a few layers could take several gigabytes, and every
 * layer cost a context.
 *
 * Each view's chunk copies (chunks.ts' `GpuChunks`) are a member.  A
 * member that needs room first lets go of its own copies it is not
 * drawing, then the copies of the layer drawn least recently (one not
 * drawn for STALE_MS: hidden, or out of the views); if there is still no
 * room the upload is refused, and the layer says so (`refused`).
 */

/** A member drawn within this long is in use: its copies are not taken for another's. */
export const STALE_MS = 1000;

export interface PoolMember {
  /** Its bytes on the GPU now. */
  readonly gpuBytes: number;
  /** When it last drew (performance.now()). */
  readonly lastDrawn: number;
  /** Lets go of every copy (the layer draws them again from its kept chunks when it next draws). */
  evict(): void;
}

export class GpuPool {
  private readonly members = new Set<PoolMember>();
  /** Copies refused for want of room, since the pool was made (for the tests and the report). */
  refusals = 0;

  constructor(
    readonly name: string,
    public limit: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  add(member: PoolMember): void {
    this.members.add(member);
  }

  remove(member: PoolMember): void {
    this.members.delete(member);
  }

  get total(): number {
    let n = 0;
    for (const m of this.members) n += m.gpuBytes;
    return n;
  }

  get size(): number {
    return this.members.size;
  }

  /**
   * Room for `bytes` more of `member`'s: true when there is, after
   * `trimSelf` (its own copies not drawn now let go) and, if need be,
   * evicting the layers drawn least recently.  False: refused.
   */
  reserve(member: PoolMember, bytes: number, trimSelf: (target: number) => void): boolean {
    if (this.total + bytes <= this.limit) return true;
    trimSelf(this.limit - bytes);
    if (this.total + bytes <= this.limit) return true;
    const now = this.now();
    const idle = [...this.members].filter((m) => m !== member && m.gpuBytes > 0 && now - m.lastDrawn > STALE_MS).sort((a, b) => a.lastDrawn - b.lastDrawn);
    for (const m of idle) {
      m.evict();
      if (this.total + bytes <= this.limit) return true;
    }
    ++this.refusals;
    return false;
  }
}

/** The 3-D view's budget: every layer's copies in Neuroglancer's context (its own data shares it). */
export const POOL_3D = new GpuPool("3-D", 1024 * 1024 * 1024);
