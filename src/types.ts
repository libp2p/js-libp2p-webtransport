import type { WebTransport as WebTransportType } from '@fails-components/webtransport'
import type { WebTransportOptions } from '@fails-components/webtransport/dist/lib/dom'

declare global {
  // eslint-disable-next-line no-var, @typescript-eslint/no-unused-vars
  var WebTransport: new (url: string, config: WebTransportOptions) => WebTransportType
}
