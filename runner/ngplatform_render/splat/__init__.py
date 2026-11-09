"""Gaussian splats of a rendered scene: path-traced views from all round it, fitted once, viewed anywhere.

A splat is made in two steps.  `views` places cameras on a sphere (or a cap
of it) around the point the view turns about and turns the page's view into
one view for each, with what would differ from view to view held still (the
light where it is now, in world space; no lens blur; no smoothing); the
render service path-traces them (server.Splat) into a folder: RGBA images,
the cameras (`cameras.json`, and `transforms.json` for other splat
trainers), and points where each view first meets tissue (`points.ply`, the
fit's starting cloud).  `fit` (torch and gsplat, a Python of its own) fits
3-D Gaussians to the images and `export` writes them as a `.ply` (the usual
3-D Gaussian splatting layout) and a `.splat` (32 bytes a Gaussian, for web
viewers).  Everything a frame of the scene depends on (preset, colours,
light, cuts) is in the images: a change to any of them needs a new splat.
"""
