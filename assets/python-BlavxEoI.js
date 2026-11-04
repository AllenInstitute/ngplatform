import{_ as S}from"./preload-helper-Ct5FWWRu.js";import{h as w,c as x}from"./dom-CZ_hTzS2.js";const N="https://cdn.jsdelivr.net/pyodide/v0.28.3/full/",E=`
import json as _json
from contextlib import contextmanager as _contextmanager
import _ngp_bridge as _bridge

class _Workspace:
    """The workspace: ngp.state(), ngp.set_state(d), with ngp.txn() as s: …,
    ngp.layers(), ngp.add_layer(url), await ngp.show(array),
    await ngp.show_points(xyz), await ngp.show_lines(lines),
    await ngp.show_mesh(vertices, faces), ngp.annotate(points=…), ngp.position,
    @ngp.command(title), @ngp.panel(title),
    await ngp.invoke(id, args), ngp.commands(), and ngp.viewer (Neuroglancer's
    JavaScript viewer)."""

    def state(self):
        """This scene's Neuroglancer state, as a dict."""
        return _json.loads(_bridge.getState())

    def set_state(self, state):
        """Replaces this scene's Neuroglancer state."""
        _bridge.setState(_json.dumps(state))

    @_contextmanager
    def txn(self):
        """Edits the state in place, applied when the block ends:
        with ngp.txn() as s: s["layout"] = "xy" """
        state = self.state()
        yield state
        self.set_state(state)

    def layers(self):
        """The names of this scene's layers."""
        return _json.loads(_bridge.layers())

    def layer(self, name):
        """A layer's specification, as a dict."""
        return next((l for l in self.state().get("layers", []) if l.get("name") == name), None)

    def add_layer(self, source, name=None, kind=None):
        """Adds a dataset by URL (any source Neuroglancer reads); returns its layer's name."""
        return _bridge.addLayer(source, name or "", kind or "auto")

    async def show(self, array, name="array", voxel_size=(1.0, 1.0, 1.0), origin=(0.0, 0.0, 0.0), labels=False):
        """Shows a numpy array, indexed [x, y, z] (or [x, y] or [x, y, z, t]), as a layer:
        an image, or with labels=True a segmentation.  voxel_size and origin (the
        first voxel's centre) are in millimetres.  Returns the layer's name:
            layer = await ngp.show(np.random.rand(64, 64, 64), voxel_size=(0.5, 0.5, 2))"""
        import numpy as np
        from pyodide.ffi import to_js
        a = np.asarray(array)
        if a.ndim == 2:
            a = a[:, :, None]
        if a.ndim not in (3, 4):
            raise ValueError("an array of 2 to 4 dimensions: [x, y], [x, y, z] or [x, y, z, t]")
        if a.dtype == np.bool_:
            a = a.astype(np.uint8)
        codes = {"uint8": 2, "int16": 4, "int32": 8, "float32": 16, "float64": 64, "int8": 256, "uint16": 512, "uint32": 768, "int64": 1024, "uint64": 1280}
        if a.dtype.name not in codes:
            a = a.astype(np.float32)
        header = _nifti_header(a, codes[a.dtype.name], voxel_size, origin, 1002 if labels else 0, f"ngp.show: {name}")
        data = header + np.asfortranarray(a.astype(a.dtype.newbyteorder("<"), copy=False)).tobytes(order="F")
        return await _bridge.showFile(f"{name}.nii", to_js(data), name, "segmentation" if labels else "image")

    async def show_points(self, xyz, name="points", values=None):
        """Shows points (an N × 3 array of x, y, z in millimetres) as a layer, each
        point an object; values: {name: N values} shown and filtered per point.
            await ngp.show_points(np.random.rand(1000, 3) * 50, values={"size": np.arange(1000)})"""
        import io
        import numpy as np
        p = np.asarray(xyz, dtype=np.float64)
        if p.ndim != 2 or p.shape[1] != 3:
            raise ValueError("points as an N x 3 array of x, y, z")
        columns = {k: np.asarray(v, dtype=np.float64).ravel() for k, v in (values or {}).items()}
        for k, v in columns.items():
            if len(v) != len(p):
                raise ValueError(f"{k}: {len(v)} values for {len(p)} points")
        table = np.column_stack([p] + list(columns.values())) if columns else p
        out = io.StringIO()
        np.savetxt(out, table, delimiter=",", header=",".join(["x_mm", "y_mm", "z_mm"] + [str(k) for k in columns]), comments="", fmt="%.9g")
        return await self._show_bytes(f"{name}.csv", out.getvalue().encode(), name)

    async def show_lines(self, lines, name="lines"):
        """Shows polylines (a list of M × 3 arrays, millimetres) as streamlines, each
        line an object, as a tractogram would be:
            await ngp.show_lines([np.cumsum(np.random.randn(100, 3), 0) for _ in range(50)])"""
        import numpy as np
        tracks = [np.asarray(l, dtype="<f4").reshape(-1, 3) for l in lines]
        body = bytearray()
        for t in tracks:
            body += t.tobytes() + np.full(3, np.nan, "<f4").tobytes()
        body += np.full(3, np.inf, "<f4").tobytes()
        head = f"mrtrix tracks\\ndatatype: Float32LE\\ncount: {len(tracks)}\\nfile: . {{}}\\nEND\\n"
        offset = len(head.format(0)) + 8
        header = head.format(offset).encode().ljust(offset, b"\\0")
        return await self._show_bytes(f"{name}.tck", bytes(header) + bytes(body), name)

    async def show_mesh(self, vertices, faces, name="mesh"):
        """Shows a triangle mesh (vertices N × 3 in millimetres, faces M × 3 vertex
        indices), as a mesh file would be:
            await ngp.show_mesh(v, f)"""
        import numpy as np
        v = np.asarray(vertices, dtype="<f4").reshape(-1, 3)
        f = np.asarray(faces, dtype="<i4").reshape(-1, 3)
        if f.size and (f.min() < 0 or f.max() >= len(v)):
            raise ValueError("a face names a vertex the mesh does not have")
        head = (f"ply\\nformat binary_little_endian 1.0\\nelement vertex {len(v)}\\nproperty float x\\nproperty float y\\nproperty float z\\n"
                f"element face {len(f)}\\nproperty list uchar int vertex_indices\\nend_header\\n").encode()
        rows = np.zeros(len(f), dtype=[("n", "u1"), ("i", "<i4", 3)])
        rows["n"] = 3
        rows["i"] = f
        return await self._show_bytes(f"{name}.ply", head + v.tobytes() + rows.tobytes(), name)

    async def _show_bytes(self, file_name, data, name):
        from pyodide.ffi import to_js
        return await _bridge.showFile(file_name, to_js(bytes(data)), name, "auto")

    def annotate(self, points=(), lines=(), boxes=(), ellipsoids=(), name="annotations", descriptions=None):
        """Adds an annotation layer (kept in the workspace, editable in the views),
        in the views' coordinates (as ngp.position):
            points: [p, …]; lines: [(a, b), …]; boxes: [(corner, corner), …];
            ellipsoids: [(centre, radii), …]; descriptions: one text per annotation, in that order.
        Returns the layer's name."""
        def xyz(v):
            return [float(x) for x in v]
        made = [{"type": "point", "point": xyz(p)} for p in points]
        made += [{"type": "line", "pointA": xyz(a), "pointB": xyz(b)} for a, b in lines]
        made += [{"type": "axis_aligned_bounding_box", "pointA": xyz(a), "pointB": xyz(b)} for a, b in boxes]
        made += [{"type": "ellipsoid", "center": xyz(c), "radii": xyz(r)} for c, r in ellipsoids]
        for i, a in enumerate(made):
            a["id"] = f"py{i}"
            if descriptions is not None and i < len(descriptions) and descriptions[i]:
                a["description"] = str(descriptions[i])
        with self.txn() as s:
            taken = {l.get("name") for l in s.get("layers", [])}
            layer, k = name, 2
            while layer in taken:
                layer, k = f"{name} {k}", k + 1
            dims = s.get("dimensions", {})
            s.setdefault("layers", []).append({"type": "annotation", "name": layer, "source": {"url": "local://annotations", "transform": {"outputDimensions": dims}}, "annotations": made})
        return layer

    @property
    def position(self):
        return _json.loads(_bridge.position())

    @position.setter
    def position(self, value):
        _bridge.setPosition(_json.dumps([float(v) for v in value]))

    async def invoke(self, command, args=None):
        """Runs a command from the palette by id, e.g. await ngp.invoke("scene.new")."""
        return _json.loads(await _bridge.invoke(command, _json.dumps(args or {})))

    def commands(self):
        """Every command: {id: title}."""
        return _json.loads(_bridge.commands())

    @property
    def viewer(self):
        return _bridge.viewer()

    def panel(self, title, id=None, slot="left"):
        """Adds a tab (slot "left", "right" or "bottom") drawn by a function given the
        tab's element, when shown and again whenever the workspace changes:
        @ngp.panel("My tab")
        def draw(host): host.textContent = f"{len(ngp.layers())} layers"
        """
        def register(function):
            _bridge.registerPanel(id or function.__name__, title, slot, function)
            return function
        return register

    def command(self, title, id=None):
        """Adds a function to the command palette:
        @ngp.command("Count my layers")
        def count(): print(len(ngp.layers()))"""
        def register(function):
            _bridge.registerCommand(id or f"python.{function.__name__}", title, function)
            return function
        return register

    def __repr__(self):
        return "<ngp: the workspace. help(ngp) lists what it does.>"

def _nifti_header(a, datatype, voxel_size, origin, intent, description):
    """A NIfTI-1 header (352 bytes, "n+1") for an array in x-fastest order: sform and qform to millimetres."""
    import struct
    v = [float(x) for x in voxel_size]
    o = [float(x) for x in origin]
    dims = list(a.shape) + [1] * (7 - a.ndim)
    h = bytearray(352)
    struct.pack_into("<i", h, 0, 348)
    struct.pack_into("<8h", h, 40, a.ndim, *dims)
    struct.pack_into("<h", h, 68, intent)
    struct.pack_into("<hh", h, 70, datatype, a.dtype.itemsize * 8)
    struct.pack_into("<8f", h, 76, 1.0, *v, 1.0, 1.0, 1.0, 1.0)
    struct.pack_into("<f", h, 108, 352.0)
    h[123] = 2 | 8  # millimetres, seconds
    h[148:148 + 79] = description.encode()[:79].ljust(79, bytes(1))
    struct.pack_into("<hh", h, 252, 2, 2)  # qform and sform: aligned
    struct.pack_into("<3f", h, 268, *o)
    for r in range(3):
        row = [v[r] if c == r else 0.0 for c in range(3)] + [o[r]]
        struct.pack_into("<4f", h, 280 + 16 * r, *row)
    h[344:348] = b"n+1" + bytes(1)
    return bytes(h)

ngp = _Workspace()

async def _ngp_run(source):
    from pyodide.code import eval_code_async
    value = await eval_code_async(source, globals())
    return None if value is None else repr(value)
`;let k;const v=new Map;let z="console";function $(d){for(const u of v.get(d)?.values()??[])u();v.delete(d)}async function A(d,u,a){const t=await j(d);$(u),z=u;try{await t.loadPackagesFromImports(a),await t.globals.get("_ngp_run")(a)}finally{z="console"}}let g;function j(d){return k??=(async()=>{const a=await(await S(()=>import(`${N}pyodide.mjs`),[],import.meta.url)).loadPyodide({indexURL:N}),{engine:t,store:m,commands:p}=d;return a.registerJsModule("_ngp_bridge",{getState:()=>JSON.stringify(m.ng()),setState:e=>{const i=JSON.parse(e);m.patchState(s=>{for(const o of Object.keys(s))delete s[o];Object.assign(s,i)})},layers:()=>JSON.stringify(t.layers().map(e=>e.name)),addLayer:(e,i,s)=>{const o=m.addDataset({source:e,name:i||void 0,kind:s});return m.sceneDatasets().find(l=>l.dataset.id===o)?.layers[0]??""},showFile:async(e,i,s,o)=>{const[l]=await d.localData.openFile(new File([i],e));if(l===void 0)throw new Error(`${e} could not be read`);const f=m.addDataset({source:l.source,name:s,kind:o});return m.sceneDatasets().find(c=>c.dataset.id===f)?.layers[0]??""},position:()=>JSON.stringify(t.navigation().position),setPosition:e=>t.setPosition(JSON.parse(e)),invoke:async(e,i)=>JSON.stringify(await p.invoke(e,JSON.parse(i))??null),commands:()=>JSON.stringify(Object.fromEntries(p.list().map(e=>[e.id,e.title]))),viewer:()=>t.viewer,registerCommand:(e,i,s)=>{const o=z,l=o!=="console"&&e.startsWith("python.")?`python.${o.replace(/[^A-Za-z0-9_-]/g,"_")}.${e.slice(7)}`:e,f=v.get(o)??new Map;v.set(o,f),f.get(l)?.();const c=s.copy?.()??s,h=p.register({id:l,title:i,group:o==="console"?"Python":`Python: ${o}`,run:async()=>{try{await c()}catch(n){d.log.add(`${i}: ${n.message}`,"error","Python")}}});f.set(l,()=>{h(),c.destroy?.()})},registerPanel:(e,i,s,o)=>{const l=z,f=v.get(l)??new Map;v.set(l,f);const c=`python.${l}.${e}`.replace(/[^A-Za-z0-9_.-]/g,"_");f.get(c)?.();const h=o.copy?.()??o,n=d.docks.addTab({id:c,title:i,slot:["left","right","bottom"].includes(s)?s:"left",order:95,owner:l==="console"?"python":`python:${l}`,render:r=>{const y=()=>{try{r.replaceChildren(),h(r)}catch(P){r.textContent=`${i}: ${P.message}`}};y();let _;const b=m.onChange(()=>{clearTimeout(_),_=setTimeout(y,150)});return()=>{clearTimeout(_),b()}}});f.set(c,()=>{n(),h.destroy?.()})}}),await a.runPythonAsync(E),a.setStdout({batched:e=>g?g(e,"out"):d.log.add(e,"info","Python")}),a.setStderr({batched:e=>g?g(e,"err"):d.log.add(e,"error","Python")}),a})(),k.catch(()=>k=void 0),k}function T(d,u){const a=w("div",{class:"py-out",role:"log","aria-live":"polite"}),t=w("textarea",{class:"py-in",rows:1,spellcheck:"false",placeholder:"Enter runs · Shift+Enter: new line · ↑ ↓: history","aria-label":"Python input",disabled:!0}),m=w("span",{class:"py-prompt"},">>>");d.append(a,w("div",{class:"py-line"},m,t)),d.classList.add("py-host");const p=(n,r="out")=>{const y=a.scrollTop+a.clientHeight>=a.scrollHeight-4;a.append(w("pre",{class:`py-${r}`},n)),(y||r==="in")&&(a.scrollTop=a.scrollHeight)},e=()=>{t.style.height="auto",t.style.height=`${t.scrollHeight}px`},i=[];let s=0,o,l=!1;const f=async n=>{if(!(o===void 0||l)){l=!0,t.disabled=!0,p(n.replace(/^/gm,(r,y)=>y===0?">>> ":"... "),"in");try{await o.loadPackagesFromImports(n,{messageCallback:y=>p(y,"note")});const r=await o.globals.get("_ngp_run")(n);r!=null&&p(r,"result")}catch(r){const y=String(r.message??r),_=y.split(`
`),b=_.findIndex(P=>P.includes('File "<exec>"'));p(b>0?["Traceback (most recent call last):",..._.slice(b)].join(`
`):y,"err")}finally{l=!1,t.disabled=!1,t.focus()}}};t.addEventListener("input",e),t.addEventListener("keydown",n=>{const r=t.value;if(n.key==="Enter"&&!n.shiftKey){if(n.preventDefault(),r.trim()==="")return;i.push(r),s=i.length,t.value="",e(),f(r)}else n.key==="ArrowUp"&&!r.slice(0,t.selectionStart).includes(`
`)&&s>0?(n.preventDefault(),t.value=i[--s],e()):n.key==="ArrowDown"&&!r.slice(t.selectionEnd).includes(`
`)&&s<i.length?(n.preventDefault(),s++,t.value=i[s]??"",e()):n.key==="l"&&n.ctrlKey&&(n.preventDefault(),x(a))});let c=!1;const h=()=>{x(a),p("Loading Python…","note"),j(u).then(n=>{c||(o=n,g=p,x(a),p(`Python (Pyodide ${n.version}), in this page. ngp is the workspace: help(ngp) lists what it does. Packages load when imported; Ctrl+L clears.`,"note"),t.disabled=!1,t.focus())},n=>{c||(x(a),p(`Python did not load from ${N}: ${n.message}. Check the connection, then try again.`,"err"),a.append(w("button",{class:"btn small py-retry",type:"button",onclick:h},"Try again")))})};return h(),()=>{c=!0,g===p&&(g=void 0),d.classList.remove("py-host")}}export{E as PRELUDE,$ as forgetPython,j as loadPython,T as renderPythonPanel,A as runPythonPlugin};
