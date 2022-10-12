import { WebTransport as WebTransportLibp2p } from 'js-libp2p-webtransport'
import { Noise } from '@chainsafe/libp2p-noise'
import { createLibp2p, Libp2p } from 'libp2p'
import { createBitswap } from 'ipfs-bitswap'
import { MemoryBlockstore } from 'blockstore-core/memory'
import { Yamux } from '@chainsafe/libp2p-yamux'

type Bitswap = ReturnType<typeof createBitswap>

export async function setup (): Promise<{libp2p: Libp2p, bitswap: Bitswap}> {
  const store = new MemoryBlockstore()

  const node = await createLibp2p({
    transports: [new WebTransportLibp2p()],
    connectionEncryption: [new Noise()],
    // Muxer needed here to enable the identify service. A bit of a hack...
    streamMuxers: [new Yamux()]
  })

  await node.start()

  const bitswap = createBitswap(node, store)
  await bitswap.start()

  return { libp2p: node, bitswap }
}
