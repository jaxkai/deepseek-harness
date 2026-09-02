import { describe, expect, it } from 'vitest'
import { parseWebUrlLine } from '../src/readiness.ts'

describe('parseWebUrlLine', () => {
  it('parses the plain loopback URL line', () => {
    expect(parseWebUrlLine('dsh web: http://127.0.0.1:3080')?.href).toBe('http://127.0.0.1:3080/')
  })

  it('parses the LAN-suffixed line and keeps the loopback URL', () => {
    expect(parseWebUrlLine('dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.4:3080)')?.href)
      .toBe('http://127.0.0.1:3080/')
  })

  it('accepts localhost and IPv6 loopback', () => {
    expect(parseWebUrlLine('dsh web: http://localhost:4123')?.port).toBe('4123')
    expect(parseWebUrlLine('dsh web: http://[::1]:4124')?.hostname).toBe('[::1]')
  })

  it('ignores unrelated and non-http lines', () => {
    for (const line of ['', 'dsh web:', 'some other output', 'dsh web: https://127.0.0.1:3080']) {
      expect(parseWebUrlLine(line)).toBeUndefined()
    }
  })

  it('refuses a non-loopback host', () => {
    expect(parseWebUrlLine('dsh web: http://0.0.0.0:3080')).toBeUndefined()
    expect(parseWebUrlLine('dsh web: http://192.168.1.4:3080')).toBeUndefined()
  })
})
