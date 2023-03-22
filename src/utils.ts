import type { Duplex, Source } from 'it-stream-types'

// Determines if `maybeSubset` is a subset of `set`. This means that all byte arrays in `maybeSubset` are present in `set`.
export function isSubset (set: Uint8Array[], maybeSubset: Uint8Array[]): boolean {
  const intersection = maybeSubset.filter(byteArray => {
    return Boolean(set.find((otherByteArray: Uint8Array) => {
      if (byteArray.length !== otherByteArray.length) {
        return false
      }

      for (let index = 0; index < byteArray.length; index++) {
        if (otherByteArray[index] !== byteArray[index]) {
          return false
        }
      }
      return true
    }))
  })
  return (intersection.length === maybeSubset.length)
}

// Duplex that does nothing. Needed to fulfill the interface
export function inertDuplex (): Duplex<any, any, any> {
  return {
    source: {
      [Symbol.asyncIterator] () {
        return {
          async next () {
            // This will never resolve
            return await new Promise(() => { })
          }
        }
      }
    },
    sink: async (source: Source<any>) => {
      // This will never resolve
      return await new Promise(() => { })
    }
  }
}
