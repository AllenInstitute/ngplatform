/** Neuroglancer's JPEG decoder (third_party/jpgjs), which ships without types. */
declare module "neuroglancer/unstable/third_party/jpgjs/jpg.js" {
  export class JpegDecoder {
    width: number;
    height: number;
    numComponents: number;
    parse(data: Uint8Array): void;
    getData(width: number, height: number, forceRGBOutput: boolean): Uint8Array;
  }
}
