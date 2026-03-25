declare module 'heic-decode' {
  export type HeicDecodedImage = {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  };

  type DecodeHeic = (input: { buffer: Uint8Array }) => Promise<HeicDecodedImage>;

  const decodeHeic: DecodeHeic;

  export default decodeHeic;
}
