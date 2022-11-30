import { logger } from '@libp2p/logger'
import { noise } from '@chainsafe/libp2p-noise'
import { Transport, symbol, CreateListenerOptions, DialOptions, Listener } from '@libp2p/interface-transport'
import type { Connection, MultiaddrConnection } from '@libp2p/interface-connection'
import { Multiaddr, protocols } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'
import { bases, digest } from 'multiformats/basics'
import type { MultihashDigest } from 'multiformats/hashes/interface'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { Duplex, Source } from 'it-stream-types'
import createListener from './listener.js'
import WebTransport from './webtransport.js'
import { inertDuplex, isSubset } from './utils.js'
import { webtransportMuxer } from './muxer.js'
import { AbortError } from '@libp2p/interfaces/errors'

const log = logger('libp2p:webtransport')

/**
 * PEM format server certificate and private key
 */
export interface WebTransportCertificate {
  privateKey: string
  pem: string
  hash: MultihashDigest<number>
  secret: string
}

// @ts-expect-error - Not easy to combine these types.
const multibaseDecoder = Object.values(bases).map(b => b.decoder).reduce((d, b) => d.or(b))

function decodeCerthashStr (s: string): MultihashDigest {
  return digest.decode(multibaseDecoder.decode(s))
}

function parseMultiaddr (ma: Multiaddr): { url: string, certhashes: MultihashDigest[], remotePeer?: PeerId } {
  const parts = ma.stringTuples()

  // This is simpler to have inline than extract into a separate function
  // eslint-disable-next-line complexity
  const { url, certhashes, remotePeer } = parts.reduce((state: { url: string, certhashes: MultihashDigest[], seenHost: boolean, seenPort: boolean, remotePeer?: PeerId }, [proto, value]) => {
    switch (proto) {
      case protocols('ip4').code:
      case protocols('ip6').code:
      case protocols('dns4').code:
      case protocols('dns6').code:
        if (state.seenHost || state.seenPort) {
          throw new Error('Invalid multiaddr, saw host and already saw the host or port')
        }
        return {
          ...state,
          url: `${state.url}${value ?? ''}`,
          seenHost: true
        }
      case protocols('quic').code:
      case protocols('webtransport').code:
        if (!state.seenHost || !state.seenPort) {
          throw new Error("Invalid multiaddr, Didn't see host and port, but saw quic/webtransport")
        }
        return state
      case protocols('udp').code:
        if (state.seenPort) {
          throw new Error('Invalid multiaddr, saw port but already saw the port')
        }
        return {
          ...state,
          url: `${state.url}:${value ?? ''}`,
          seenPort: true
        }
      case protocols('certhash').code:
        if (!state.seenHost || !state.seenPort) {
          throw new Error('Invalid multiaddr, saw the certhash before seeing the host and port')
        }
        return {
          ...state,
          certhashes: state.certhashes.concat([decodeCerthashStr(value ?? '')])
        }
      case protocols('p2p').code:
        return {
          ...state,
          remotePeer: peerIdFromString(value ?? '')
        }
      default:
        throw new Error(`unexpected component in multiaddr: ${proto} ${protocols(proto).name} ${value ?? ''} `)
    }
  },
  // All webtransport urls are https
  { url: 'https://', seenHost: false, seenPort: false, certhashes: [] })

  return { url, certhashes, remotePeer }
}

export interface WebTransportInit {
  maxInboundStreams?: number
  certificates?: WebTransportCertificate[]
}

export interface WebTransportComponents {
  peerId: PeerId
}

export interface WebTransportConfig {
  maxInboundStreams: number
  certificates?: WebTransportCertificate[]
}

class WebTransportTransport implements Transport {
  private readonly components: WebTransportComponents
  private readonly config: WebTransportConfig

  constructor (components: WebTransportComponents, init: WebTransportInit = {}) {
    this.components = components
    this.config = {
      ...init,
      maxInboundStreams: init.maxInboundStreams ?? 1000
    }
  }

  get [Symbol.toStringTag] () {
    return '@libp2p/webtransport'
  }

  get [symbol] (): true {
    return true
  }

  async dial (ma: Multiaddr, options: DialOptions): Promise<Connection> {
    log('dialing %s', ma)
    const localPeer = this.components.peerId
    if (localPeer === undefined) {
      throw new Error('Need a local peerid')
    }

    options = options ?? {}

    const { url, certhashes, remotePeer } = parseMultiaddr(ma)

    const wt = new WebTransport(`${url}/.well-known/libp2p-webtransport?type=noise`, {
      serverCertificateHashes: certhashes.map(certhash => ({
        algorithm: 'sha-256',
        value: certhash.digest
      }))
    })
    wt.closed.catch((error: Error) => {
      log.error('WebTransport transport closed due to:', error)
    })

    await wt.ready

    try {
      if (!await this.authenticateWebTransport(wt, localPeer, certhashes, remotePeer)) {
        throw new Error('Failed to authenticate webtransport')
      }

      const maConn: MultiaddrConnection = {
        close: async (err?: Error) => {
          if (err != null) {
            log('Closing webtransport with err:', err)
          }
          wt.close()
        },
        remoteAddr: ma,
        timeline: {
          open: Date.now()
        },
        // This connection is never used directly since webtransport supports native streams.
        ...inertDuplex()
      }

      wt.closed.catch((err: Error) => {
        log.error('WebTransport connection closed with err:', err)
      })
        .finally(() => {
        // This is how we specify the connection is closed and shouldn't be used.
          maConn.timeline.close = Date.now()
        })

      if (options.signal?.aborted === true) {
        wt.close()
        throw new AbortError()
      }

      return await options.upgrader.upgradeOutbound(maConn, {
        skipEncryption: true,
        muxerFactory: webtransportMuxer(wt, wt.incomingBidirectionalStreams.getReader(), this.config),
        skipProtection: true
      })
    } catch (err) {
      wt.close()
      throw err
    }
  }

  async authenticateWebTransport (wt: WebTransport, localPeer: PeerId, certhashes: Array<MultihashDigest<number>>, remotePeer?: PeerId): Promise<boolean> {
    const stream = await wt.createBidirectionalStream()
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()
    await writer.ready

    const duplex: Duplex<Uint8Array> = {
      source: (async function * () {
        try {
          while (true) {
            const val = await reader.read()

            if (val.done) {
              return
            }

            if (val.value != null) {
              yield val.value
            }
          }
        } finally {
          reader.releaseLock()
        }
      })(),
      sink: async function (source: Source<Uint8Array>) {
        for await (const chunk of source) {
          await writer.write(chunk)
        }
      }
    }

    const encrypter = noise()()

    const { remoteExtensions } = await encrypter.secureOutbound(localPeer, duplex, remotePeer)

    // We're done with this authentication stream
    writer.close().catch((err: Error) => {
      log.error(`Failed to close authentication stream writer: ${err.message}`)
    })

    reader.cancel().catch((err: Error) => {
      log.error(`Failed to close authentication stream reader: ${err.message}`)
    })

    // Verify the certhashes we used when dialing are a subset of the certhashes relayed by the remote peer
    if (!isSubset(remoteExtensions?.webtransportCerthashes ?? [], certhashes.map(ch => ch.bytes))) {
      throw new Error("Our certhashes are not a subset of the remote's reported certhashes")
    }

    return true
  }

  createListener (options: CreateListenerOptions): Listener {
    if (this.config.certificates == null || this.config.certificates.length === 0) {
      throw new Error('WebTransport certificate is required')
    }

    return createListener({
      ...options,
      certificates: this.config.certificates,
      peerId: this.components.peerId
    })
  }

  /**
   * Takes a list of `Multiaddr`s and returns only valid webtransport addresses.
   */
  filter (multiaddrs: Multiaddr[]) {
    return multiaddrs.filter(ma => ma.protoNames().includes('webtransport'))
  }
}

export function webTransport (init: WebTransportInit = {}): (components: WebTransportComponents) => Transport {
  return (components: WebTransportComponents) => new WebTransportTransport(components, init)
}
