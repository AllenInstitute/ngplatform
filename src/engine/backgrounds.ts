/**
 * The views' backgrounds, and others shown over them for a while: a
 * plugin's for the 2-D views (Luxar's splats need black), and the light
 * ground of Views follow theme (src/ui/theme.ts) for the 2-D and 3-D views.
 * What is shown for a while is never saved: the state keeps the backgrounds
 * it has (a link's own, or the defaults), and `saved()` says what they are
 * while others are shown.  A background the person changes meanwhile
 * (Settings › View) is theirs: shown, and saved, until the state is replaced.
 *
 * Also says whether each view is on a dark or a light ground, for what is
 * drawn over it to read on (src/ui/styles.css, data-view-ground).
 */

/** A background as Neuroglancer keeps it (its TrackableRGB): the value, as saved, and its changes. */
export interface BackgroundColour {
  value: ArrayLike<number>;
  toJSON(): unknown;
  changed: { add(listener: () => void): () => void };
}

export type ViewGround = "dark" | "light";
type Which = "sections" | "view3d";
type Rgb = [number, number, number];

/** A background as the state has it: its value, and as saved (undefined: Neuroglancer's default). */
interface Saved {
  value: Float32Array;
  json: unknown;
}

/** Light when black text reads better on it than white (relative luminance over 0.18). */
export function groundOf(rgb: ArrayLike<number>): ViewGround {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return luminance > 0.18 ? "light" : "dark";
}

export class ViewBackgrounds {
  private savedColours: Record<Which, Saved> | undefined;
  private plugin: Float32Array | undefined;
  private ground: Record<Which, Float32Array> | undefined;
  /** Set here, not by the person. */
  private setting = 0;
  /** Changed by the person while others were shown. */
  private readonly own = new Set<Which>();
  private readonly offs: (() => void)[];

  /** `onChange`: the colours shown changed (by anyone). */
  constructor(
    private readonly colours: Record<Which, BackgroundColour>,
    private readonly onChange: () => void = () => {},
  ) {
    this.offs = (["sections", "view3d"] as const).map((which) => colours[which].changed.add(() => this.edited(which)));
  }

  dispose(): void {
    this.offs.splice(0).forEach((off) => off());
  }

  /** The 2-D views' background a plugin shows for a while, or none. */
  setPlugin(rgb: Rgb | undefined): void {
    this.plugin = rgb === undefined ? undefined : Float32Array.from(rgb);
    this.apply();
  }

  /** The ground shown for a while (the light ground of Views follow theme), or none. */
  setGround(ground: Record<Which, Rgb> | undefined): void {
    this.ground = ground === undefined ? undefined : { sections: Float32Array.from(ground.sections), view3d: Float32Array.from(ground.view3d) };
    this.own.clear();
    this.apply();
  }

  /** The backgrounds as saved (JSON, undefined for Neuroglancer's default) while others are shown; undefined when none are. */
  saved(): Record<Which, unknown> | undefined {
    const saved = this.savedColours;
    return saved === undefined ? undefined : { sections: saved.sections.json, view3d: saved.view3d.json };
  }

  /** Runs `change`, a change of the state's own backgrounds (a state restored, the defaults), beneath what is shown for a while. */
  under(change: () => void): void {
    this.setting++;
    try {
      const saved = this.savedColours;
      this.savedColours = undefined;
      this.own.clear();
      if (saved !== undefined) {
        setColour(this.colours.sections, saved.sections.value);
        setColour(this.colours.view3d, saved.view3d.value);
      }
      change();
    } finally {
      this.setting--;
    }
    this.apply();
  }

  /** Whether the 2-D views and the 3-D view are on a dark or a light ground, as shown now. */
  grounds(): Record<Which, ViewGround> {
    return { sections: groundOf(this.colours.sections.value), view3d: groundOf(this.colours.view3d.value) };
  }

  private apply(): void {
    const want: Record<Which, Float32Array | undefined> = {
      sections: this.own.has("sections") ? undefined : (this.plugin ?? this.ground?.sections),
      view3d: this.own.has("view3d") ? undefined : this.ground?.view3d,
    };
    this.setting++;
    try {
      if (want.sections === undefined && want.view3d === undefined && this.own.size === 0) {
        const saved = this.savedColours;
        this.savedColours = undefined;
        if (saved !== undefined) {
          setColour(this.colours.sections, saved.sections.value);
          setColour(this.colours.view3d, saved.view3d.value);
        }
      } else {
        const saved = (this.savedColours ??= { sections: savedOf(this.colours.sections), view3d: savedOf(this.colours.view3d) });
        setColour(this.colours.sections, want.sections ?? saved.sections.value);
        setColour(this.colours.view3d, want.view3d ?? saved.view3d.value);
      }
    } finally {
      this.setting--;
    }
    this.onChange();
  }

  private edited(which: Which): void {
    if (this.setting > 0) return;
    if (this.savedColours !== undefined) {
      this.savedColours[which] = savedOf(this.colours[which]);
      this.own.add(which);
    }
    this.onChange();
  }
}

function savedOf(colour: BackgroundColour): Saved {
  return { value: Float32Array.from(colour.value), json: colour.toJSON() };
}

/** Sets a colour when it differs (each change redraws the views). */
function setColour(colour: BackgroundColour, rgb: ArrayLike<number>): void {
  const now = colour.value;
  if (now.length === rgb.length && Array.from(now).every((v, i) => v === rgb[i])) return;
  (colour as { value: ArrayLike<number> }).value = Float32Array.from(rgb);
}
