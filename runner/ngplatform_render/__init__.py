"""Path-traced ("cinematic") rendering of OME-Zarr volumes on a CUDA GPU, for ngplatform.

The renderer (`renderer.py`, kernels in `kernels.py`) follows the
published methods: Monte Carlo volumetric path tracing with delta and
ratio tracking over a majorant grid (Novák et al. 2018), hybrid surface
and volume scattering (Kroes et al. 2012), image-based and directional
light, progressive refinement.  `server.py` serves it to the app
through the runner.
"""

__version__ = "0.1.0"
