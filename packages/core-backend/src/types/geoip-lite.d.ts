/**
 * Type declarations for geoip-lite module
 */
declare module 'geoip-lite' {
  export interface GeoIpLookup {
    range: [number, number]
    country: string
    region: string
    eu: '0' | '1'
    timezone: string
    city: string
    ll: [number, number]
    metro: number
    area: number
  }

  export function lookup(ip: string): GeoIpLookup | null
  export function pretty(ip: string): string
  export function cmp(a: string, b: string): number
}
