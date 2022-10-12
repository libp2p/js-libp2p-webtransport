/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import './style.css'
import { multiaddr } from '@multiformats/multiaddr'
import { setup as libp2pSetup } from './libp2p'
import { CID } from 'multiformats/cid'

localStorage.debug = '*'

declare global {
  interface Window {
    fetchBtn: HTMLButtonElement
    connectBtn: HTMLButtonElement
    peerInput: HTMLInputElement
    cidInput: HTMLInputElement
    statusEl: HTMLParagraphElement
    downloadEl: HTMLAnchorElement
    downloadCidWrapperEl: HTMLDivElement
    connlistWrapperEl: HTMLDivElement
    connlistEl: HTMLUListElement
  }
}

(async function () {
  const { libp2p, bitswap } = await libp2pSetup()
  window.connectBtn.onclick = async () => {
    const ma = multiaddr(window.peerInput.value)
    console.log('connecting')
    await libp2p.dial(ma)
    console.log('connected')
  }

  libp2p.connectionManager.addEventListener('peer:connect', (_connection) => {
    updateConnList()
  })
  libp2p.connectionManager.addEventListener('peer:disconnect', (_connection) => {
    updateConnList()
  })

  function updateConnList () {
    const addrs = libp2p.getConnections().map(c => c.remoteAddr.toString())
    console.log('updating conns')
    if (addrs.length > 0) {
      window.downloadCidWrapperEl.hidden = false
      window.connlistWrapperEl.hidden = false
      window.connlistEl.innerHTML = ''
      addrs.forEach(a => {
        const li = document.createElement('li')
        li.innerText = a
        window.connlistEl.appendChild(li)
      })
    } else {
      window.downloadCidWrapperEl.hidden = true
      window.connlistWrapperEl.hidden = true
      window.connlistEl.innerHTML = ''
    }
  }

  window.fetchBtn.onclick = async () => {
    console.log('Fetching cid', bitswap)

    const c = CID.parse(window.cidInput.value)
    window.statusEl.hidden = false
    const val = await bitswap.get(c)
    window.statusEl.hidden = true

    window.downloadEl.href = window.URL.createObjectURL(new Blob([val], { type: 'bytes' }))
    window.downloadEl.hidden = false
  }
})().catch(err => console.error(err))

// setupCounter(document.querySelector<HTMLButtonElement>('#counter')!)

// eslint-disable-next-line @typescript-eslint/no-floating-promises
