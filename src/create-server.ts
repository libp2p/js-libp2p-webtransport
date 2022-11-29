import { EventEmitter } from 'events'
import { logger } from '@libp2p/logger'
import { Http3Server, WebTransportSession } from '@fails-components/webtransport'
import pTimeout from 'p-timeout'

const log = logger('libp2p:webtransport:server')

export interface WebTransportServer extends EventEmitter {
  listening: boolean
  sessionTimeout: number

  close: (callback?: () => void) => void
  listen: () => void
  address: () => { port: number, host: string, family: 'IPv4' | 'IPv6' } | null
}

class DefaultWebTransportServer extends EventEmitter implements WebTransportServer {
  private readonly server: Http3Server
  public listening: boolean
  /**
   * How long in ms to wait for an incoming session to be ready
   */
  public sessionTimeout: number

  constructor (init: any) {
    super()

    this.server = new Http3Server(init)
    this.listening = false

    this.sessionTimeout = 1000
  }

  close (callback?: () => void) {
    if (callback != null) {
      this.addListener('close', callback)
    }

    this.server.stopServer()
    this.server.closed
      .then(() => {
        this.listening = false
        this.emit('close')
      })
      .catch((err) => {
        this.emit('error', err)
      })
  }

  listen () {
    this.server.startServer()
    this.server.ready
      .then(() => {
        this.listening = true
        this.emit('listening')

        this._processIncomingSessions().catch(err => {
          this.emit('error', err)
        })
      })
      .catch((err) => {
        this.emit('error', err)
      })
  }

  address (): { port: number, host: string, family: 'IPv4' | 'IPv6' } | null {
    return this.server.address()
  }

  async _processIncomingSessions () {
    const sessionStream = await this.server.sessionStream('/.well-known/libp2p-webtransport?type=noise')
    const sessionReader = sessionStream.getReader()

    while (true) {
      const { done, value: session } = await sessionReader.read()

      if (done) {
        log('session reader finished')
        break
      }

      void Promise.resolve()
        .then(async () => {
          const timeout = pTimeout(session.ready, {
            milliseconds: this.sessionTimeout
          })

          try {
            await timeout

            this.emit('session', session)
          } catch (err) {
            log.error('error waiting for session to become ready', err)
          } finally {
            timeout.clear()
          }
        })
    }
  }
}

export interface SessionHandler {
  (session: WebTransportSession): void
}

export function createServer (init: any, sessionHandler?: SessionHandler): WebTransportServer {
  const server = new DefaultWebTransportServer(init)

  if (sessionHandler != null) {
    server.addListener('session', sessionHandler)
  }

  return server
}
