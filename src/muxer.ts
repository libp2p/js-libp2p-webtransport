import type { Direction, Stream } from '@libp2p/interface-connection'
import type { StreamMuxer, StreamMuxerFactory, StreamMuxerInit } from '@libp2p/interface-stream-muxer'
import { logger } from '@libp2p/logger'
import type { Source } from 'it-stream-types'
import { Uint8ArrayList } from 'uint8arraylist'
import { inertDuplex } from './utils.js'
import type WebTransport from './webtransport.js'
import type { WebTransportBidirectionalStream } from '@fails-components/webtransport'
import { AbortError } from '@libp2p/interfaces/errors'

const log = logger('libp2p:webtransport:muxer')

export interface WebTransportMuxerInit {
  maxInboundStreams: number
}

export function webtransportMuxer (wt: WebTransport, reader: ReadableStreamDefaultReader<WebTransportBidirectionalStream>, config: WebTransportMuxerInit): StreamMuxerFactory {
  let streamIDCounter = 0

  return {
    protocol: 'webtransport',
    createStreamMuxer: (init?: StreamMuxerInit): StreamMuxer => {
      // !TODO handle abort signal when WebTransport supports this.

      const activeStreams: Stream[] = []

      void Promise.resolve().then(async () => {
        //! TODO unclear how to add backpressure here?
        while (true) {
          const { done, value: wtStream } = await reader.read()

          if (done) {
            log('streams have ended')
            break
          }

          if (wtStream == null) {
            log('new incoming stream was undefined')
            break
          }

          log('new incoming stream')

          if (activeStreams.length >= config.maxInboundStreams) {
            // We've reached our limit, close this stream.
            wtStream.writable.close().catch((err: Error) => {
              log.error(`Failed to close inbound stream that crossed our maxInboundStream limit: ${err.message}`)
            })
            wtStream.readable.cancel().catch((err: Error) => {
              log.error(`Failed to close inbound stream that crossed our maxInboundStream limit: ${err.message}`)
            })
          } else {
            const stream = await webtransportBiDiStreamToStream(wtStream, String(streamIDCounter++), 'inbound', activeStreams, init?.onStreamEnd)
            activeStreams.push(stream)
            init?.onIncomingStream?.(stream)
          }
        }
      })

      const muxer: StreamMuxer = {
        protocol: 'webtransport',
        streams: activeStreams,
        newStream: async (name?: string): Promise<Stream> => {
          log('new outgoing stream')

          const wtStream = await wt.createBidirectionalStream()
          const stream = await webtransportBiDiStreamToStream(wtStream, String(streamIDCounter++), init?.direction ?? 'outbound', activeStreams, init?.onStreamEnd)
          activeStreams.push(stream)

          return stream
        },

        /**
         * Close or abort all tracked streams and stop the muxer
         */
        close: (err?: Error) => {
          if (err != null) {
            log('Closing webtransport muxer with err:', err)
          }
          wt.close()
        },
        // This stream muxer is webtransport native. Therefore it doesn't plug in with any other duplex.
        ...inertDuplex()
      }

      if (init?.signal?.aborted === true) {
        wt.close()
        throw new AbortError()
      }

      return muxer
    }
  }
}

async function webtransportBiDiStreamToStream (bidiStream: any, streamId: string, direction: Direction, activeStreams: Stream[], onStreamEnd: undefined | ((s: Stream) => void)): Promise<Stream> {
  const writer = bidiStream.writable.getWriter()
  const reader = bidiStream.readable.getReader()
  await writer.ready

  function cleanupStreamFromActiveStreams () {
    const index = activeStreams.findIndex(s => s === stream)
    if (index !== -1) {
      activeStreams.splice(index, 1)
      stream.stat.timeline.close = Date.now()
      onStreamEnd?.(stream)
    }
  }

  let writerClosed = false
  let readerClosed = false;
  (async function () {
    const err: Error | undefined = await writer.closed.catch((err: Error) => err)
    if (err != null) {
      const msg = err.message
      if (!(msg.includes('aborted by the remote server') || msg.includes('STOP_SENDING'))) {
        log.error(`WebTransport writer closed unexpectedly: streamId=${streamId} err=${err.message}`)
      }
    }
    writerClosed = true
    if (writerClosed && readerClosed) {
      cleanupStreamFromActiveStreams()
    }
  })().catch(() => {
    log.error('WebTransport failed to cleanup closed stream')
  });

  (async function () {
    const err: Error | undefined = await reader.closed.catch((err: Error) => err)
    if (err != null) {
      log.error(`WebTransport reader closed unexpectedly: streamId=${streamId} err=${err.message}`)
    }
    readerClosed = true
    if (writerClosed && readerClosed) {
      cleanupStreamFromActiveStreams()
    }
  })().catch(() => {
    log.error('WebTransport failed to cleanup closed stream')
  })

  let sinkSunk = false
  const stream: Stream = {
    id: streamId,
    abort (_err: Error) {
      if (!writerClosed) {
        writer.abort()
        writerClosed = true
      }
      stream.closeRead()
      readerClosed = true
      cleanupStreamFromActiveStreams()
    },
    close () {
      stream.closeRead()
      stream.closeWrite()
      cleanupStreamFromActiveStreams()
    },

    closeRead () {
      if (!readerClosed) {
        reader.cancel().catch((err: any) => {
          if (err.toString().includes('RESET_STREAM') === true) {
            writerClosed = true
          }
        })
        readerClosed = true
      }
      if (writerClosed) {
        cleanupStreamFromActiveStreams()
      }
    },
    closeWrite () {
      if (!writerClosed) {
        writerClosed = true
        writer.close().catch((err: any) => {
          if (err.toString().includes('RESET_STREAM') === true) {
            readerClosed = true
          }
        })
      }
      if (readerClosed) {
        cleanupStreamFromActiveStreams()
      }
    },
    reset () {
      stream.close()
    },
    stat: {
      direction: direction,
      timeline: { open: Date.now() }
    },
    metadata: {},
    source: (async function * () {
      while (true) {
        const val = await reader.read()
        if (val.done === true) {
          readerClosed = true
          if (writerClosed) {
            cleanupStreamFromActiveStreams()
          }
          return
        }

        yield new Uint8ArrayList(val.value)
      }
    })(),
    sink: async function (source: Source<Uint8Array | Uint8ArrayList>) {
      if (sinkSunk) {
        throw new Error('sink already called on stream')
      }
      sinkSunk = true
      try {
        for await (const chunks of source) {
          if (chunks instanceof Uint8Array) {
            await writer.write(chunks)
          } else {
            for (const buf of chunks) {
              await writer.write(buf)
            }
          }
        }
      } finally {
        stream.closeWrite()
      }
    }
  }

  return stream
}
