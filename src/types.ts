import type { WebTransport as WebTransportType } from '@fails-components/webtransport'
import type { WebTransportOptions } from '@fails-components/webtransport/dist/lib/dom'

declare global {
  // will be added to the global TypeScript types once the WebTransport spec is no
  // longer experimental - https://github.com/microsoft/TypeScript/issues/51912
  // eslint-disable-next-line no-var, @typescript-eslint/no-unused-vars
  var WebTransport: new (url: string, config: WebTransportOptions) => WebTransportType
}
