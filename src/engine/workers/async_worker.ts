/**
 * An async-computation worker (decoding off the chunk worker): Neuroglancer's
 * own contents plus the plugins' decoders.  Neuroglancer's contents come
 * last: they report the worker ready.
 */
import "neuroglancer-zarr-vectors/async_computation";
import "neuroglancer/worker/async_computation";
