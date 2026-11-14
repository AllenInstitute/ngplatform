/**
 * A bin worker: bins the batches of a tractogram the vectors worker hands
 * it (`Binner` in ./streamlines.ts) into a spill file of its own, which
 * that worker reserved and reads once this one hands it back.  See
 * ./bin_workers.ts.
 */
import { OpfsSpill } from "./spill.js";
import { type BinConfig, Binner } from "./streamlines.js";
import type { TrkBatch } from "./trk.js";

type Message = { id: number } & ({ start: { name: string; config: BinConfig; grow: number } } | { batch: TrkBatch; first: number } | { finish: true });

let spill: OpfsSpill | undefined;
let binner: Binner | undefined;
// Messages are handled one at a time, in order (opening the spill is asynchronous).
let queue = Promise.resolve();

async function handle(m: Message): Promise<void> {
  try {
    if ("start" in m) {
      spill = await OpfsSpill.writer(m.start.name, m.start.grow);
      binner = new Binner(spill, m.start.config);
      postMessage({ id: m.id });
    } else if ("batch" in m) {
      const lengths = binner!.bin(m.batch, m.first);
      postMessage({ id: m.id, lengths }, { transfer: [lengths.buffer] });
    } else {
      const index = binner!.finish();
      const size = spill!.handOver();
      spill = binner = undefined;
      postMessage({ id: m.id, index, size });
    }
  } catch (e) {
    postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e), runner: (e as { kind?: string }).kind === "runner" });
  }
}

self.onmessage = (event: MessageEvent<Message>) => {
  queue = queue.then(() => handle(event.data));
};
