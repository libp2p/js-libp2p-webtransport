import { pipe } from 'it-pipe'
import { noise } from '@chainsafe/libp2p-noise'
import { createLibp2p } from 'libp2p'

/** @type {import('aegir/types').PartialOptions} */
export default {
  test: {
    async before () {
      const { generateWebTransportCertificates } = await import('./dist/test/certificate.js')
      const { webTransport } = await import('./dist/src/index.js')

      const node = await createLibp2p({
        addresses: {
          listen: ['/ip4/0.0.0.0/udp/0/quic/webtransport']
        },
        transports: [webTransport({
          certificates: await generateWebTransportCertificates([
            { shortName: 'C', value: 'DE' },
            { shortName: 'ST', value: 'Berlin' },
            { shortName: 'L', value: 'Berlin' },
            { shortName: 'O', value: '@libp2p/webtransport tests' },
            { shortName: 'CN', value: '127.0.0.1' }
          ], [{
            // can be max 14 days according to the spec
            days: 13
          }, {
            // can be max 14 days according to the spec
            days: 13,
            // start the second certificate after the first expires
            start: new Date(Date.now() + (86400000 * 13))
          }])
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
