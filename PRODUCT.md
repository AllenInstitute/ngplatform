# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: researchers exploring large brain imaging data in the browser:
terabyte-scale HiP-CT (Human Organ Atlas, LINC), OME-Zarr images,
tractograms and Zarr Vectors stores. They open data, look, measure and share
links. When layout choices conflict, the layout favours them: views first,
tools appear when asked for (user, 2026-11-14).

Also served: analysts running tools (track filtering, registration,
segmentation, anatomical rendering), colleagues opening a shared link, and
plugin developers extending the platform.

## Product Purpose

ngplatform is a workspace around Neuroglancer, extended by plugins. It
hosts domain tools for Zarr, OME-Zarr and Zarr Vectors data that are too
specialised or too large for Neuroglancer itself. Success: a researcher
opens a terabyte dataset, finds the place and scale they need, and works on
it in the view without learning a new tool for each task.

## Positioning

Neuroglancer stays unchanged at the centre; everything ngplatform adds is
additive (plugins, overlays, render layers through public hooks). Data on
the user's computer is read in place as virtual Zarr. Workspaces (datasets,
scenes, plugin state) live in one link.

## Operating Context

Desktop browsers (Chrome and Edge fully; Firefox and Safari without folder
access). Data is local files, http, GCS or S3. Heavy jobs run on a paired
runner (this computer or over SSH). Researchers move between whole-organ
overviews and local high-resolution zooms of the same specimen (HiP-CT
hierarchy).

## Capabilities and Constraints

- Additive to Neuroglancer only: no changes to Neuroglancer's own
  behaviour; the platform adds around it (user, 2026-11-14).
- Existing plugins: annotations, atlas, collections, filters, Luxar,
  orientations, registration, segmentation, time series, track filtering,
  volume view (anatomical rendering), Zarr Vectors.
- Undo for every workspace change; the address bar holds the workspace.
- New work in progress is deployed to a `/dev` page of the Pages site
  before it reaches the main site (user, 2026-11-14).

## Evidence on Hand

- Public example datasets: SRB 2026a template, MICrONS, S-21-46 tractogram
  in MNI, HCP1065 tractogram.
- Docs: https://ngplatform.readthedocs.io/ (sources in `docs/`).
- No usage metrics or testimonials; do not invent them.

## Product Principles

1. The data is the interface: views get the space, chrome steps back.
2. Work happens in the view: what is spatial is manipulated spatially.
3. Additive, never invasive, to Neuroglancer.
4. One way to do a thing across all plugins.

## Accessibility & Inclusion

Keyboard reachable controls, named controls and dialogs (the UI audit checks
these); respects reduced motion.
