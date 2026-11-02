"""How the lookup tables here were made from their publishers' files.

    python make_tables.py SOURCES

SOURCES holds the downloaded files (see README.md for where each comes from):
    freesurfer/FreeSurferColorLUT.txt, freesurfer/LICENSE.txt
    other/Yeo2011_7Networks_ColorLUT.txt, other/Yeo2011_17Networks_ColorLUT.txt
    schaefer/Schaefer2018_<N>Parcels_<7|17>Networks_order.txt
    harvard_oxford/fsleyes_harvard-oxford-{cortical,subcortical}.lut

Every table is written in FreeSurfer's format (index name R G B A); names
with spaces get underscores, as FreeSurfer's reader splits on spaces.
"""
import os
import re
import shutil
import sys

src = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))


def read_fs(path):
    """FreeSurfer LUT lines as (value, name, r, g, b, a)."""
    rows = []
    for line in open(path, encoding="utf-8"):
        t = line.split()
        if len(t) >= 6 and not line.lstrip().startswith("#") and t[0].isdigit():
            rows.append((int(t[0]), t[1], int(t[2]), int(t[3]), int(t[4]), int(t[5])))
    return rows


def write_fs(name, header, rows):
    width = max(len(r[1]) for r in rows)
    with open(os.path.join(here, name), "w", encoding="utf-8") as f:
        for h in header:
            f.write(f"# {h}".rstrip() + "\n")
        f.write(f"#{'No.':>5}  {'Label Name:'.ljust(width)}    R   G   B   A\n")
        for v, n, r, g, b, a in rows:
            f.write(f"{v:6d}  {n.ljust(width)}  {r:3d} {g:3d} {b:3d} {a:3d}\n")


# FreeSurfer: the colour table as published, and its licence with the preface it asks for.
shutil.copy(os.path.join(src, "freesurfer/FreeSurferColorLUT.txt"), os.path.join(here, "FreeSurferColorLUT.txt"))
with open(os.path.join(here, "LICENSE-FreeSurfer.txt"), "w", encoding="utf-8") as f:
    f.write(
        "The FreeSurfer tables here (FreeSurferColorLUT.txt, FreeSurfer_*.txt and\n"
        "Yeo2011_*.txt) come from FreeSurfer and are not covered by this\n"
        "repository's Apache-2.0 licence.\n\n"
        'All or portions of this licensed product (such portions are the "Software")\n'
        'have been obtained under license from The General Hospital Corporation "MGH"\n'
        "and are subject to the following terms and conditions:\n\n"
    )
    f.write(open(os.path.join(src, "freesurfer/LICENSE.txt"), encoding="utf-8").read())

fs = read_fs(os.path.join(src, "freesurfer/FreeSurferColorLUT.txt"))
aseg = [r for r in fs if r[0] < 256]
modified = "Modified from FreeSurferColorLUT.txt (FreeSurfer, MGH; see LICENSE-FreeSurfer.txt): a subset of its labels."
write_fs(
    "FreeSurfer_DesikanKilliany.txt",
    ["Desikan-Killiany cortical parcellation with the subcortical labels (aparc+aseg).", modified, "Desikan et al. (2006) NeuroImage 31(3):968-980."],
    aseg + [r for r in fs if 1000 <= r[0] <= 1035 or 2000 <= r[0] <= 2035],
)
write_fs(
    "FreeSurfer_Destrieux.txt",
    ["Destrieux cortical parcellation with the subcortical labels (aparc.a2009s+aseg).", modified, "Destrieux et al. (2010) NeuroImage 53(1):1-15."],
    aseg + [r for r in fs if 11100 <= r[0] <= 11175 or 12100 <= r[0] <= 12175],
)
for n in (7, 17):
    rows = read_fs(os.path.join(src, f"other/Yeo2011_{n}Networks_ColorLUT.txt"))
    write_fs(
        f"Yeo2011_{n}Networks.txt",
        [f"Yeo 2011 {n}-network cortical parcellation, from FreeSurfer's distribution/average/Yeo_JNeurophysiol11_MNI152 (MGH; see LICENSE-FreeSurfer.txt).", "Yeo et al. (2011) J Neurophysiol 106(3):1125-1165."],
        rows,
    )

# Schaefer 2018 (CBIG, MIT).
for parcels in range(100, 1001, 100):
    for n in (7, 17):
        rows = read_fs(os.path.join(src, f"schaefer/Schaefer2018_{parcels}Parcels_{n}Networks_order.txt"))
        write_fs(
            f"Schaefer2018_{parcels}Parcels_{n}Networks.txt",
            [
                f"Schaefer 2018 local-global parcellation, {parcels} parcels, ordered by the Yeo 2011 {n} networks.",
                "From github.com/ThomasYeoLab/CBIG, stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/MNI/freeview_lut.",
                "Copyright (c) 2016 Computational Brain Imaging Group (CBIG); MIT licence, see LICENSE-CBIG.txt.",
                "Schaefer et al. (2018) Cerebral Cortex 28(9):3095-3114.",
            ],
            [(0, "Background", 0, 0, 0, 0)] + rows,
        )
shutil.copy(os.path.join(src, "schaefer/CBIG_LICENSE.md"), os.path.join(here, "LICENSE-CBIG.txt"))

# Harvard-Oxford: FSLeyes' colours (Apache-2.0) and the atlas's names (CC BY-SA 4.0).
for part, title in (("cortical", "Cortical"), ("subcortical", "Subcortical")):
    rows = [(0, "Background", 0, 0, 0, 0)]
    for line in open(os.path.join(src, f"harvard_oxford/fsleyes_harvard-oxford-{part}.lut"), encoding="utf-8"):
        t = line.split()
        if len(t) >= 5 and t[0].isdigit():
            rgb = [round(float(c) * 255) for c in t[1:4]]
            rows.append((int(t[0]), re.sub(r"[\s,]+", "_", " ".join(t[4:]).strip()).replace("'", ""), *rgb, 0))
    write_fs(
        f"HarvardOxford_{title}.txt",
        [
            f"Harvard-Oxford {part} structural atlas (maximum-probability labels, values 1 to {len(rows) - 1}).",
            "Names: Harvard Center for Morphometric Analysis, as released with FSL under CC BY-SA 4.0; this file is CC BY-SA 4.0.",
            "Colours: FSLeyes (fsleyes/assets/luts), Copyright 2016-2023 University of Oxford, Apache-2.0.",
            "Converted to FreeSurfer's format, names with underscores. Desikan et al. (2006); Makris et al. (2006); Frazier et al. (2005); Goldstein et al. (2007).",
        ],
        rows,
    )
print("done")
