import { logger } from '@libp2p/logger'
import { EventEmitter, CustomEvent } from '@libp2p/interfaces/events'
import type { WebTransportCertificate } from './index.js'
import { multiaddr } from '@multiformats/multiaddr'
import * as os from 'os'
import { noise } from '@chainsafe/libp2p-noise'
import toIt from 'browser-readablestream-to-it'
import type { MultiaddrConnection, Connection } from '@libp2p/interface-connection'
import type { Upgrader, Listener, ListenerEvents, CreateListenerOptions } from '@libp2p/interface-transport'
import type { Multiaddr } from '@multiformats/multiaddr'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { Duplex, Source } from 'it-stream-types'
import type { WebTransportSession } from '@fails-components/webtransport'
import { inertDuplex } from './utils.js'
import { webtransportMuxer } from './muxer.js'
import { createServer, WebTransportServer } from './create-server.js'
import { ipPortToMultiaddr } from '@libp2p/utils/ip-port-to-multiaddr'
import { base64url } from 'multiformats/bases/base64'

const log = logger('libp2p:webtransport:listener')
const CODE_P2P = 421

const networks = os.networkInterfaces()

function isAnyAddr (ip: string) {
  return ['0.0.0.0', '::'].includes(ip)
}

function getNetworkAddrs (family: string) {
  const addresses = []

  for (const [, netAddrs] of Object.entries(networks)) {
    if (netAddrs != null) {
      for (const netAddr of netAddrs) {
        if (netAddr.family === family) {
          addresses.push(netAddr.address)
        }
      }
    }
  }

  return addresses
}

const ProtoFamily = { ip4: 'IPv4', ip6: 'IPv6' }

function getMultiaddrs (proto: 'ip4' | 'ip6', ip: string, port: number, certificates: WebTransportCertificate[]) {
  const certhashes = certificates.map(cert => {
    return `/certhash/${base64url.encode(cert.hash.bytes)}`
  }).join('')

  const toMa = (ip: string) => multiaddr(`/${proto}/${ip}/udp/${port}/quic/webtransport${certhashes}`)
  return (isAnyAddr(ip) ? getNetworkAddrs(ProtoFamily[proto]) : [ip]).map(toMa)
}

/**
 * Attempts to close the given maConn. If a failure occurs, it will be logged
 */
async function attemptClose (conn: Connection) {
  try {
    await conn.close()
  } catch (err) {
    log.error('an error occurred closing the connection', err)
  }
}

interface WebTransportListenerInit extends CreateListenerOptions {
  peerId: PeerId
  handler?: (conn: Connection) => void
  upgrader: Upgrader
  certificates: WebTransportCertificate[]
}

type Status = {started: false} | {started: true, listeningAddr: Multiaddr, peerId: string | null }

class WebTransportListener extends EventEmitter<ListenerEvents> implements Listener {
  private server?: WebTransportServer
  private readonly certificates: WebTransportCertificate[]
  private readonly peerId: PeerId
  private readonly upgrader: Upgrader
  private readonly handler?: (conn: Connection) => void
  /** Keep track of open connections to destroy in case of timeout */
  private readonly connections: Connection[]

  private status: Status = { started: false }

  constructor (init: WebTransportListenerInit) {
    super()

    this.certificates = init.certificates
    this.peerId = init.peerId
    this.upgrader = init.upgrader
    this.handler = init.handler
    this.connections = []
  }

  async onSession (session: WebTransportSession) {
    const bidiReader = session.incomingBidirectionalStreams.getReader()

    // read one stream to do authentication
    log('read authentication stream')
    const bidistr = await bidiReader.read()

    if (bidistr.done) {
      return
    }

    // ok we got a stream
    const bidistream = bidistr.value
    const writer = bidistream.writable.getWriter()

    const encrypter = noise({
      extensions: {
        webtransportCerthashes: this.certificates.map(cert => cert.hash.bytes)
      }
    })()
    const duplex: Duplex<Uint8Array> = {
      source: toIt(bidistream.readable),
      sink: async (source: Source<Uint8Array>) => {
        for await (const buf of source) {
          await writer.write(buf)
        }
      }
    }

    log('secure inbound stream')
    const { remotePeer } = await encrypter.secureInbound(this.peerId, duplex)

    // upgrade it
    const maConn: MultiaddrConnection = {
      close: async (err?: Error) => {
        if (err != null) {
          log('Closing webtransport with err:', err)
        }
        session.close()
      },
      // TODO: pull this from webtransport
      // remoteAddr: ipPortToMultiaddr(session.remoteAddress, session.remotePort),
      remoteAddr: ipPortToMultiaddr('127.0.0.1', 8080).encapsulate(`/p2p/${remotePeer.toString()}`),
      timeline: {
        open: Date.now()
      },
      // This connection is never used directly since webtransport supports native streams.
      ...inertDuplex()
    }

    session.closed.catch((err: Error) => {
      log.error('WebTransport connection closed with error:', err)
    }).finally(() => {
      // This is how we specify the connection is closed and shouldn't be used.
      maConn.timeline.close = Date.now()
    })

    try {
      log('upgrade inbound stream')
      const connection = await this.upgrader.upgradeInbound(maConn, {
        skipEncryption: true,
        skipProtection: true,
        muxerFactory: webtransportMuxer(session, bidiReader, {
          maxInboundStreams: 1000
        })
      })

      // We're done with this authentication stream
      writer.close().catch((err: Error) => {
        log.error('Failed to close authentication stream writer', err)
      })

      this.connections.push(connection)

      if (this.handler != null) {
        this.handler(connection)
      }

      this.dispatchEvent(new CustomEvent('connection', {
        detail: connection
      }))
    } catch (err: any) {
      session.close({
        closeCode: 500,
        reason: err.message
      })
    }
  }

  getAddrs () {
    if (!this.status.started || this.server == null) {
      return []
    }

    let addrs: Multiaddr[] = []
    const address = this.server.address()

    if (address == null) {
      return []
    }

    try {
      if (address.family === 'IPv4') {
        addrs = addrs.concat(getMultiaddrs('ip4', address.host, address.port, this.certificates))
      } else if (address.family === 'IPv6') {
        addrs = addrs.concat(getMultiaddrs('ip6', address.host, address.port, this.certificates))
      }
    } catch (err) {
      log.error('could not turn %s:%s into multiaddr', address.host, address.port, err)
    }

    return addrs.map(ma => this.peerId != null ? ma.encapsulate(`/p2p/${this.peerId.toString()}`) : ma)
  }

  async listen (ma: Multiaddr): Promise<void> {
    log('listen on multiaddr %s', ma)

    const peerId = ma.getPeerId()
    const listeningAddr = peerId == null ? ma.decapsulateCode(CODE_P2P) : ma

    this.status = { started: true, listeningAddr, peerId }

    const options = listeningAddr.toOptions()

    const server = this.server = createServer({
      port: options.port,
      host: options.host,
      secret: this.certificates[0].secret,
      cert: this.certificates[0].pem,
      privKey: this.certificates[0].privateKey
    })

    server.on('listening', () => {
      log('server listening %s', ma, server.address())
      this.dispatchEvent(new CustomEvent('listening'))
    })
    server.on('error', (err) => {
      log('server error %s', ma, err)
      this.dispatchEvent(new CustomEvent('error', { detail: err }))
    })
    server.on('session', (session) => {
      log('server new session %s', ma)
      this.onSession(session)
        .catch(err => {
          log.error('error handling new session', err)
          session.close()
        })
    })
    server.on('close', () => {
      log('server close %s', ma)
      this.dispatchEvent(new CustomEvent('close'))
    })

    return await new Promise<void>((resolve, reject) => {
      server.listen()

      server.on('listening', () => {
        resolve()
      })
    })
  }

  async close () {
    if (this.server == null) {
      return
    }

    log('closing connections')
    await Promise.all(
      this.connections.map(async conn => await attemptClose(conn))
    )

    log('stopping server')
    this.server.close()
  }
}

export default function createListener (options: WebTransportListenerInit): Listener {
  return new WebTransportListener(options)
}
