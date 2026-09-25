declare module 'gif.js.optimized' {
  class GIF {
    constructor(options: Record<string, unknown>)
    addFrame(frame: HTMLCanvasElement | ImageData | ImageBitmap | Uint8ClampedArray, options?: { copy?: boolean; delay?: number }): void
    on(event: 'finished', callback: (blob: Blob) => void): void
    on(event: 'error', callback: (error: Error) => void): void
    on(event: 'abort', callback: () => void): void
    render(): void
  }

  export default GIF
}
