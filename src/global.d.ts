
interface WebTransportConfig {
  serverCertificateHashes?: Array<{ algorithm: string, value: Uint8Array }>
}
/**
 * @see https://developer.mozilla.org/en-US/docs/Web/API/WebTransportBidirectionalStream
 */
interface WebTransportBidirectionalStream {
  readable: ReadableStream
  writable: WritableStream
}
/**
 * @see https://developer.mozilla.org/en-US/docs/Web/API/WebTransport
 */
interface GlobalThisWebTransport extends EventTarget {
  closed: Promise<any>
  datagrams: Duplex<Uint8ArrayList, Uint8ArrayList | Uint8Array>
  incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>
  incomingUnidirectionalStreams: ReadableStream
  ready: Promise<any>
  close: (options?: { closeCode: number, reason: string }) => void
  createBidirectionalStream: () => Promise<Duplex<Uint8ArrayList, Uint8ArrayList | Uint8Array>>
  createUnidirectionalStream: () => Promise<Stream>
}
// eslint-disable-next-line no-var, @typescript-eslint/no-unused-vars
var WebTransport: new (url: string, config: WebTransportConfig) => GlobalThisWebTransport
