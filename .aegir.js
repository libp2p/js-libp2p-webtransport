import { pipe } from 'it-pipe'
import { sha256 } from 'multiformats/hashes/sha2'
import * as Digest from 'multiformats/hashes/digest'
import { noise } from '@chainsafe/libp2p-noise'
import { createLibp2p } from 'libp2p'

/** @type {import('aegir/types').PartialOptions} */
export default {
  test: {
    async before() {
      const { generateWebTransportCertificate } = await import('./dist/test/certificate.js')
      const { webTransport } = await import('./dist/src/index.js')

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

      const node = await createLibp2p({
        addresses: {
          listen: ['/ip4/0.0.0.0/udp/0/quic/webtransport']
        },
        transports: [webTransport({
          certificates: [{
            privateKey: certificate.private,
            pem: certificate.cert,
            hash: digest
          }]
        })],
        connectionEncryption: [noise()]
      })

      await node.start()

      await node.handle('echo', ({ stream }) => {
        void pipe(stream, stream)
      })

      const multiaddrs = node.getMultiaddrs()

      return {
        node,
        env: {
          serverAddr: multiaddrs[0].toString()
        }
      }
    },
    async after (_, before) {
      await before.node.stop()
    }
  },
  build: {
    bundlesizeMax: '97kB'
  }
}
