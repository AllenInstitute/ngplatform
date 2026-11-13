import{a as O}from"./docks-D8KEPuD8.js";import{e as w,b as k}from"./dom-SP1g9eJL.js";const x="https://cdn.jsdelivr.net/pyodide/v0.28.3/full/",N={"pyodide.mjs":"sha384-81fS7esAvlEVAVK509OWewC3dTwye8WYv/Qw69eL8WcPB/67xk3ju1SxzR3KAEzr","pyodide.asm.js":"sha384-r0/vSQNahhZUJBO7ne5kqeNO4O9xSg658nGR6cGiQtzyIYSOfY9J8JUwOUdUMEkd"};function $(s,y){return new Promise((a,t)=>{const d=document.createElement("script");d.src=s,d.integrity=y,d.crossOrigin="anonymous",d.onload=()=>a(),d.onerror=()=>{d.remove(),t(new Error(`could not load ${s}, or it is not the file this app expects`))},document.head.append(d)})}async function A(){await $(`${x}pyodide.asm.js`,N["pyodide.asm.js"]);const s=await fetch(`${x}pyodide.mjs`,{integrity:N["pyodide.mjs"]});if(!s.ok)throw new Error(`${x}pyodide.mjs answered ${s.status}`);const y=URL.createObjectURL(new Blob([await s.text()],{type:"text/javascript"}));try{return await import(y)}finally{URL.revokeObjectURL(y)}}const T=`
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

    def panel(self, title, id=None, slot="left", group="Python"):
        """Adds a panel drawn by a function given the panel's element, when shown and
        again whenever the workspace changes.  A tool (slot "left") goes to the Tools
        dock, listed under group; slot "bottom" puts it in the Activity dock:
        @ngp.panel("My panel")
        def draw(host): host.textContent = f"{len(ngp.layers())} layers"
        """
        def register(function):
            _bridge.registerPanel(id or function.__name__, title, slot, function, group)
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
`;let j;const v=new Map;let z="console";function D(s){for(const y of v.get(s)?.values()??[])y();v.delete(s)}async function C(s,y,a){const t=await S(s);D(y),z=y;try{await t.loadPackagesFromImports(a),await t.globals.get("_ngp_run")(a)}finally{z="console"}}let g;function S(s){return j??=(async()=>{const a=await(await A()).loadPyodide({indexURL:x}),{engine:t,store:d,commands:c}=s;return a.registerJsModule("_ngp_bridge",{getState:()=>JSON.stringify(d.ng()),setState:e=>{const i=JSON.parse(e);d.patchState(o=>{for(const r of Object.keys(o))delete o[r];Object.assign(o,i)})},layers:()=>JSON.stringify(t.layers().map(e=>e.name)),addLayer:(e,i,o)=>{const r=d.addDataset({source:e,name:i||void 0,kind:o});return d.sceneDatasets().find(p=>p.dataset.id===r)?.layers[0]??""},showFile:async(e,i,o,r)=>{const[p]=await s.localData.openFile(new File([i],e));if(p===void 0)throw new Error(`${e} could not be read`);const f=d.addDataset({source:p.source,name:o,kind:r});return d.sceneDatasets().find(m=>m.dataset.id===f)?.layers[0]??""},position:()=>JSON.stringify(t.navigation().position),setPosition:e=>t.setPosition(JSON.parse(e)),invoke:async(e,i)=>JSON.stringify(await c.invoke(e,JSON.parse(i))??null),commands:()=>JSON.stringify(Object.fromEntries(c.list().map(e=>[e.id,e.title]))),viewer:()=>t.viewer,registerCommand:(e,i,o)=>{const r=z,p=r!=="console"&&e.startsWith("python.")?`python.${r.replace(/[^A-Za-z0-9_-]/g,"_")}.${e.slice(7)}`:e,f=v.get(r)??new Map;v.set(r,f),f.get(p)?.();const m=o.copy?.()??o,h=c.register({id:p,title:i,group:r==="console"?"Python":`Python: ${r}`,run:async()=>{try{await m()}catch(n){s.log.add(`${i}: ${n.message}`,"error","Python")}}});f.set(p,()=>{h(),m.destroy?.()})},registerPanel:(e,i,o,r,p)=>{const f=z,m=v.get(f)??new Map;v.set(f,m);const h=`python.${f}.${e}`.replace(/[^A-Za-z0-9_.-]/g,"_");m.get(h)?.();const n=r.copy?.()??r,l=s.docks.addTab(O({id:h,title:i,slot:["left","right","bottom"].includes(o)?o:"left",group:p||"Python",order:95,owner:f==="console"?"python":`python:${f}`,render:u=>{const b=()=>{try{u.replaceChildren(),n(u)}catch(E){u.textContent=`${i}: ${E.message}`}};b();let _;const P=d.onChange(()=>{clearTimeout(_),_=setTimeout(b,150)});return()=>{clearTimeout(_),P()}}}));m.set(h,()=>{l(),n.destroy?.()})}}),await a.runPythonAsync(T),a.setStdout({batched:e=>g?g(e,"out"):s.log.add(e,"info","Python")}),a.setStderr({batched:e=>g?g(e,"err"):s.log.add(e,"error","Python")}),a})(),j.catch(()=>j=void 0),j}function J(s,y){const a=w("div",{class:"py-out",role:"log","aria-live":"polite"}),t=w("textarea",{class:"py-in",rows:1,spellcheck:"false",placeholder:"Enter runs · Shift+Enter: new line · ↑ ↓: history","aria-label":"Python input",disabled:!0}),d=w("span",{class:"py-prompt"},">>>");s.append(a,w("div",{class:"py-line"},d,t)),s.classList.add("py-host");const c=(n,l="out")=>{const u=a.scrollTop+a.clientHeight>=a.scrollHeight-4;a.append(w("pre",{class:`py-${l}`},n)),(u||l==="in")&&(a.scrollTop=a.scrollHeight)},e=()=>{t.style.height="auto",t.style.height=`${t.scrollHeight}px`},i=[];let o=0,r,p=!1;const f=async n=>{if(!(r===void 0||p)){p=!0,t.disabled=!0,c(n.replace(/^/gm,(l,u)=>u===0?">>> ":"... "),"in");try{await r.loadPackagesFromImports(n,{messageCallback:u=>c(u,"note")});const l=await r.globals.get("_ngp_run")(n);l!=null&&c(l,"result")}catch(l){const u=String(l.message??l),b=u.split(`
`),_=b.findIndex(P=>P.includes('File "<exec>"'));c(_>0?["Traceback (most recent call last):",...b.slice(_)].join(`
`):u,"err")}finally{p=!1,t.disabled=!1,t.focus()}}};t.addEventListener("input",e),t.addEventListener("keydown",n=>{const l=t.value;if(n.key==="Enter"&&!n.shiftKey){if(n.preventDefault(),l.trim()==="")return;i.push(l),o=i.length,t.value="",e(),f(l)}else n.key==="ArrowUp"&&!l.slice(0,t.selectionStart).includes(`
`)&&o>0?(n.preventDefault(),t.value=i[--o],e()):n.key==="ArrowDown"&&!l.slice(t.selectionEnd).includes(`
`)&&o<i.length?(n.preventDefault(),o++,t.value=i[o]??"",e()):n.key==="l"&&n.ctrlKey&&(n.preventDefault(),k(a))});let m=!1;const h=()=>{k(a),c("Loading Python…","note"),S(y).then(n=>{m||(r=n,g=c,k(a),c(`Python (Pyodide ${n.version}), in this page. ngp is the workspace: help(ngp) lists what it does. Packages load when imported; Ctrl+L clears.`,"note"),t.disabled=!1,t.focus())},n=>{m||(k(a),c(`Python did not load from ${x}: ${n.message}. Check the connection, then try again.`,"err"),a.append(w("button",{class:"btn small py-retry",type:"button",onclick:h},"Try again")))})};return h(),()=>{m=!0,g===c&&(g=void 0),s.classList.remove("py-host")}}export{T as PRELUDE,N as PYODIDE_INTEGRITY,D as forgetPython,S as loadPython,J as renderPythonPanel,C as runPythonPlugin};
