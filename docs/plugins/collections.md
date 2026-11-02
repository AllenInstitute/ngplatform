# Collections

**Kind:** tool · **Off by default** (switch it on in the Plugins tab) · the
**Collections** tab ·
[Source and developer README](https://github.com/AllenInstitute/ngplatform/tree/main/plugins/collections)

An OME-Zarr collection groups images (and other collections) with the
coordinate systems they share and the transforms between them. This plugin
reads collections as [RFC-8](https://ngff.openmicroscopy.org/rfc/8/) of
OME-NGFF drafts them ("Collections and Extensibility", under review in
October 2026), lists what they hold, and shows their images together.

## Using it

- **Open** a collection by its URL: a `.json` document, or a Zarr group
  whose `zarr.json` holds it. **Example** opens a small gallery of the SRB
  2026a template placed three times (as is, moved, and mirrored).
- The tab lists the **members** (each node's type, name and where it is),
  every **coordinate system** with its axes, and every **transform**, from
  which system to which.
- **Show its images in a new scene** opens a scene of its own with every
  image of the collection, each placed by its transform into the
  collection's space.

An image's own coordinate systems and transforms (OME-Zarr 0.4 to 0.6) are
also shown in its Layer → **Source** tab, under the layer's transform.

## Notes from users

*Add your tips, workflows and problems here (edit this page on GitHub).*
