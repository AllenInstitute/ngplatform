# Parked: commits for AllenInstitute/zarr-vectors-tools

These two patches belong on `AllenInstitute/zarr-vectors-tools`, branch
`claude/new-session-f9c16u`, on top of `d427930` (the merge of PR #18). They
are parked here only because the session that wrote them could not push to
the AllenInstitute organisation: the Claude GitHub App is not installed
there.

| Patch | What |
|---|---|
| `0001-…` | `zarr_vectors_tools.filtering`: filter trees and their JSON form (`zvf-predicate` v1), the brute-force oracle, the indexed engine, synthetic tractograms, `load_tractogram`; 78 tests. Also fixes `select_streamlines` missing a streamline that crosses a region near a chunk face (new `reach` parameter). |
| `0002-…` | Gate G1 measured under CPython and Pyodide, and the harness fixes behind it (`benchmarks/filtering/`). |

To apply them:

```bash
git clone https://github.com/AllenInstitute/zarr-vectors-tools
cd zarr-vectors-tools
git checkout -b claude/new-session-f9c16u d427930
git am path/to/ngplatform/pending/zarr-vectors-tools/*.patch
git push -u origin claude/new-session-f9c16u
```

Delete this folder once they are on the tools repository.
