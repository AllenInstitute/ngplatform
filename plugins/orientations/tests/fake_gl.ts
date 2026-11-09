/**
 * A stand-in WebGL2 context for tests: it compiles nothing and draws
 * nothing, but keeps what it is given (shader sources, programs, buffers,
 * textures, the uniforms looked up and set, the attributes enabled) so a
 * test can check the GL code's bookkeeping without a browser.
 */

export interface FakeShader {
  type: number;
  source: string;
}

export interface FakeProgram {
  shaders: FakeShader[];
  deleted: boolean;
}

export interface FakeObject {
  kind: string;
  deleted: boolean;
}

export interface FakeGl {
  gl: WebGL2RenderingContext;
  /** Every call, by name, with its arguments, in order. */
  calls: { name: string; args: unknown[] }[];
  programs: FakeProgram[];
  /** Objects made by createBuffer, createTexture and createVertexArray. */
  objects: FakeObject[];
  /** The uniforms looked up, with the program in use then. */
  uniforms: { program: FakeProgram; name: string }[];
  /** The attribute locations enabled while each program was drawn, by program. */
  attributes: Map<FakeProgram, Set<number>>;
  /** Fires the canvas's context-lost state: isContextLost() then says so. */
  lose(lost?: boolean): void;
  named(name: string): unknown[][];
}

export function fakeGl(o: { maxTexture?: number; samples?: number } = {}): FakeGl {
  const calls: { name: string; args: unknown[] }[] = [];
  const programs: FakeProgram[] = [];
  const objects: FakeObject[] = [];
  const uniforms: { program: FakeProgram; name: string }[] = [];
  const attributes = new Map<FakeProgram, Set<number>>();
  // Attributes enabled per vertex array; a draw counts the bound one's.
  const arrays = new Map<FakeObject, Set<number>>();
  let boundArray: FakeObject | null = null;
  let current: FakeProgram | undefined;
  let lost = false;
  const constants = new Map<string, number>();
  const constant = (name: string) => {
    let v = constants.get(name);
    if (v === undefined) constants.set(name, (v = 0x9000 + constants.size));
    return v;
  };
  const make = (kind: string) => () => {
    const object = { kind, deleted: false };
    objects.push(object);
    return object;
  };
  const own: Record<string, (...args: never[]) => unknown> = {
    getParameter: (p: number) => (p === constant("MAX_TEXTURE_SIZE") ? (o.maxTexture ?? 4096) : p === constant("SAMPLES") ? (o.samples ?? 0) : 0),
    createShader: (type: number) => ({ type, source: "" }),
    shaderSource: (shader: FakeShader, source: string) => void (shader.source = source),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    createProgram: () => {
      const program = { shaders: [], deleted: false };
      programs.push(program);
      return program;
    },
    attachShader: (program: FakeProgram, shader: FakeShader) => void program.shaders.push(shader),
    deleteProgram: (program: FakeProgram) => void (program.deleted = true),
    useProgram: (program: FakeProgram) => void (current = program),
    getUniformLocation: (program: FakeProgram, name: string) => {
      uniforms.push({ program, name });
      return { program, name };
    },
    createBuffer: make("buffer"),
    createTexture: make("texture"),
    createVertexArray: make("vertexArray"),
    deleteBuffer: (b: FakeObject) => void (b.deleted = true),
    deleteTexture: (t: FakeObject) => void (t.deleted = true),
    deleteVertexArray: (v: FakeObject) => void (v.deleted = true),
    bindVertexArray: (v: FakeObject | null) => {
      boundArray = v;
      if (v !== null && !arrays.has(v)) arrays.set(v, new Set());
    },
    enableVertexAttribArray: (k: number) => void (boundArray !== null && arrays.get(boundArray)!.add(k)),
    drawArraysInstanced: () => {
      if (current === undefined || boundArray === null) return;
      let set = attributes.get(current);
      if (set === undefined) attributes.set(current, (set = new Set()));
      for (const k of arrays.get(boundArray)!) set.add(k);
    },
    isContextLost: () => lost,
  };
  const gl = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (/^[A-Z0-9_]+$/.test(prop)) return constant(prop);
        const f = own[prop];
        return (...args: unknown[]) => {
          calls.push({ name: prop, args });
          return f === undefined ? undefined : (f as (...a: unknown[]) => unknown)(...args);
        };
      },
    },
  ) as WebGL2RenderingContext;
  return {
    gl,
    calls,
    programs,
    objects,
    uniforms,
    attributes,
    lose: (v = true) => void (lost = v),
    named: (name) => calls.filter((c) => c.name === name).map((c) => c.args),
  };
}
