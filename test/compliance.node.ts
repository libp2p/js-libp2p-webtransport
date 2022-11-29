import sinon from 'sinon'
import tests from '@libp2p/interface-transport-compliance-tests'
import { multiaddr } from '@multiformats/multiaddr'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { webTransport } from '../src/index.js'
import { generateWebTransportCertificate } from './certificate.js'
import { base64url } from 'multiformats/bases/base64'
import { sha256 } from 'multiformats/hashes/sha2'
import * as Digest from 'multiformats/hashes/digest'

describe('interface-transport compliance', () => {
  tests({
    async setup () {
      const components = {
        peerId: await createEd25519PeerId()
      }

      const certificate = await generateWebTransportCertificate([
        { shortName: 'C', value: 'DE' },
        { shortName: 'ST', value: 'Berlin' },
        { shortName: 'L', value: 'Berlin' },
        { shortName: 'O', value: 'webtransport Test Server' },
        { shortName: 'CN', value: '127.0.0.1' }
      ], {
        // can be max 14 days according to the spec
        days: 13
      })

      const digest = Digest.create(sha256.code, certificate.hash)
      const certhash = base64url.encode(digest.bytes)

      const transport = webTransport({
        certificates: [{
          privateKey: certificate.private,
          pem: certificate.cert,
          hash: digest,
          secret: 'super-secret-shhhhhh'
        }]
      })(components)
      const addrs = [
        multiaddr(`/ip4/127.0.0.1/udp/9091/quic/webtransport/certhash/${certhash}/p2p/${components.peerId.toString()}`),
        multiaddr(`/ip4/127.0.0.1/udp/9092/quic/webtransport/certhash/${certhash}/p2p/${components.peerId.toString()}`),
        multiaddr(`/ip4/127.0.0.1/udp/9093/quic/webtransport/certhash/${certhash}/p2p/${components.peerId.toString()}`),
        multiaddr(`/ip6/::/udp/9094/quic/webtransport/certhash/${certhash}/p2p/${components.peerId.toString()}`)
      ]

      // Used by the dial tests to simulate a delayed connect
      const connector = {
        delay (delayMs: number) {
          // @ts-expect-error method is not part of transport interface
          const authenticateWebTransport = transport.authenticateWebTransport.bind(transport)

          // @ts-expect-error method is not part of transport interface
          sinon.replace(transport, 'authenticateWebTransport', async (wt: WebTransport, localPeer: PeerId, remotePeer: PeerId, certhashes: Array<MultihashDigest<number>>) => {
            await new Promise<void>((resolve) => {
              setTimeout(() => resolve(), delayMs)
            })

            return authenticateWebTransport(wt, localPeer, remotePeer, certhashes)
          })
        },
        restore () {
          sinon.restore()
        }
      }

      return { transport, addrs, connector }
    },
    async teardown () {}
  })
})
