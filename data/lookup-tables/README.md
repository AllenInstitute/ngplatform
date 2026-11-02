# Lookup tables

Label lookup tables for segmentation layers: each line of a table is a label
value in the image, its name and its colour, in FreeSurfer's format

```
#No. Label Name                     R   G   B   A
17   Left-Hippocampus               220 216  20   0
```

(`A` is FreeSurfer's transparency, 0 for opaque; the app ignores it). A
segmentation layer's **Render → Lookup table** gives the layer these colours
(as its segment colours, kept in the link) and names (through a `lut://`
source, which the Segments tab, the hover values and the segment search
read). The files are bundled with the app, so they work offline.
[`tables.json`](tables.json) is the catalogue the menu shows;
[`make_tables.py`](make_tables.py) records how each file was made from its
publisher's.

These tables are data with licences of their own, not covered by the
repository's Apache-2.0 licence. Each file's header says where it is from.

## Shipped with the app

| File | What | Source | Licence |
|---|---|---|---|
| `FreeSurferColorLUT.txt` | Every FreeSurfer label (1,813): aseg, aparc (Desikan-Killiany), aparc.a2009s (Destrieux), white-matter parcels, thalamic and amygdala nuclei and more | [freesurfer/freesurfer](https://github.com/freesurfer/freesurfer/blob/dev/distribution/FreeSurferColorLUT.txt), `dev` at 18761d3 (15 April 2026), unchanged | FreeSurfer Software License Agreement 1.0 (MGH): redistribution allowed with the licence attached; research use. See [`LICENSE-FreeSurfer.txt`](LICENSE-FreeSurfer.txt). |
| `FreeSurfer_DesikanKilliany.txt` | aparc+aseg: the labels below 256 and the Desikan-Killiany cortex (1000–1035, 2000–2035) | a subset of `FreeSurferColorLUT.txt` (marked as modified in its header) | as above |
| `FreeSurfer_Destrieux.txt` | aparc.a2009s+aseg: the labels below 256 and the Destrieux cortex (11100–11175, 12100–12175) | a subset of `FreeSurferColorLUT.txt` | as above |
| `Yeo2011_7Networks.txt`, `Yeo2011_17Networks.txt` | Yeo et al. (2011) resting-state networks | FreeSurfer, `distribution/average/Yeo_JNeurophysiol11_MNI152/` | as above |
| `Schaefer2018_<N>Parcels_<7\|17>Networks.txt` (N = 100 … 1000) | Schaefer et al. (2018) local-global parcellations, in MNI space, ordered by network; a `0 Background` line added | [ThomasYeoLab/CBIG](https://github.com/ThomasYeoLab/CBIG/tree/master/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/MNI/freeview_lut), c874d05 | MIT, Copyright (c) 2016 CBIG. See [`LICENSE-CBIG.txt`](LICENSE-CBIG.txt). |
| `HarvardOxford_Cortical.txt`, `HarvardOxford_Subcortical.txt` | FSL's Harvard-Oxford maximum-probability atlases, 48 cortical and 21 subcortical regions (values 1…N); names with underscores | names from the atlas as FSL releases it; colours from [FSLeyes](https://github.com/pauldmccarthy/fsleyes/tree/main/fsleyes/assets/luts) (b8889f8) | Names: CC BY-SA 4.0 (FSL: "The Cerebellum and Harvard-Oxford atlases … are released under the CC BY-SA 4.0 licence"), so these files are CC BY-SA 4.0. Colours: Apache-2.0, Copyright 2016–2023 University of Oxford. |

Cite the atlases you use: Desikan et al. (2006) NeuroImage 31:968; Destrieux
et al. (2010) NeuroImage 53:1; Yeo et al. (2011) J Neurophysiol 106:1125;
Schaefer et al. (2018) Cereb Cortex 28:3095; for Harvard-Oxford, Makris et
al. (2006), Frazier et al. (2005), Desikan et al. (2006), Goldstein et al.
(2007).

## Fetched when chosen

| Table | URL | Why not shipped |
|---|---|---|
| Allen Mouse CCFv3 (2017) structures: 1,327 structures, acronyms as names and full names as descriptions | `https://api.brain-map.org/api/v2/structure_graph_download/1.json` (the Allen structure graph, read as JSON; CORS allows it) | The [Allen Institute Terms of Use](https://alleninstitute.org/legal/terms-use/) allow use and redistribution for research or other non-commercial purposes only, which an Apache-2.0 repository cannot pass on. Cite it as the [citation policy](https://alleninstitute.org/legal/citation-policy/) asks. |

Fetched tables need the network the first time they are chosen in a visit.

## Not included: load the file yourself

**Render → Lookup table → File…** reads these from your computer. A table
loaded so travels with the link (its names, compressed, in the layer's
`lut://inline/…` source; its colours as segment colours), so whoever opens
the link sees it without the file.

| Table | Where to get it | Why not shipped or fetched |
|---|---|---|
| JHU ICBM-DTI-81 white-matter labels | `JHU-labels.xml` in FSL (`$FSLDIR/data/atlases/`) or [git.fmrib.ox.ac.uk/fsl/data_atlases](https://git.fmrib.ox.ac.uk/fsl/data_atlases) | FSL's licence: non-commercial, no redistribution without permission; no CORS-enabled official URL. The XML has no colours: the app makes distinct ones. |
| AAL3 (Rolls et al. 2020) | `AAL3v1.nii.txt` in [AAL3v1_for_SPM12.zip](https://oxcns.org/AAL3v1_for_SPM12.zip) or the [GIN download](https://www.gin.cnrs.fr/en/tools/aal/) | Version 1 has no licence; version 2 says GPL without a version; the label file is only inside archives, which browsers cannot fetch (no CORS). No colours (index, name, code): the app makes them. |
| Brainnetome (BN_Atlas_246_LUT.txt) | [atlas.brainnetome.org/download.html](https://atlas.brainnetome.org/download.html) | Non-commercial, share-alike; no direct file URL. |
| Julich-Brain | [EBRAINS](https://search.kg.ebrains.eu/) | Licence not confirmed (records say CC BY-NC-SA 4.0). |

## Formats the app reads

- FreeSurfer colour tables (`index name R G B A`, `#` comments); a trailing
  `# text` is kept as the label's description.
- FSLeyes tables (`value R G B name`, colours 0–1).
- ITK-SNAP label descriptions (`IDX R G B A VIS MSH "LABEL"`).
- FSL atlas XML (`<label index="…">Name</label>`); values are index + 1
  unless the first label is the background ("Unclassified", as in JHU).
- The Allen Institute structure graph (JSON).
- Plain `index name` lists (AAL's), with colours made up.

To add a table: put the file here, add an entry to `tables.json` (`id`,
`title`, `group`, `file` or `url`, `source`, `licence`), list it above with
its licence, and run `npm test` (it checks every entry reads).
